import path from 'node:path';
import type Database from 'better-sqlite3';
import type { LocalCleanupPlan, LocalCleanupPlanFile } from '../state.js';
import { decodeLocalCleanupPlan } from './domain-decoders.js';

interface CleanupPlanJobRow { payload_json: string; }
interface CleanupPlanRecordRow { id: string; status: string; payload_json: string; }

function payload(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid persisted job payload: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid persisted job payload');
  return parsed as Record<string, unknown>;
}

function cleanupPlans(value: unknown, context: string): LocalCleanupPlan[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${context}: localCleanupPlans must be an array`);
  return value.map((item, index) => decodeLocalCleanupPlan(item, `${context}.localCleanupPlans[${index}]`));
}

function normalizeRelative(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) return null;
  const normalized = path.normalize(value.replace(/[\\/]+/g, path.sep));
  return normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)
    ? null : normalized.replace(/\\/g, '/');
}

function clonePlan(plan: LocalCleanupPlan): LocalCleanupPlan {
  return { ...plan, files: plan.files.map(file => ({ ...file, remotePaths: [...file.remotePaths], expectedIdentity: { ...file.expectedIdentity } })) };
}

export interface CleanupPlanRepository {
  list(bvid: string, localDir?: string): LocalCleanupPlan[];
  record(bvid: string, plan: LocalCleanupPlan, jobId: string, now: number): boolean;
  reconcile(bvid: string, localDir: string, remainingRelativePaths: Iterable<string>, removedDirectory: boolean, now: number): boolean;
}

export class SqliteCleanupPlanRepository implements CleanupPlanRepository {
  constructor(private readonly connection: () => Database.Database) {}

  list(bvid: string, localDir?: string) {
    const rows = this.connection().prepare<unknown[], CleanupPlanJobRow>("SELECT payload_json FROM jobs WHERE bvid=? AND json_type(payload_json, '$.localCleanupPlans')='array'").all(bvid);
    const wantedDir = localDir ? String(localDir) : undefined;
    return rows.flatMap(row => {
      const raw = cleanupPlans(payload(row.payload_json).localCleanupPlans, `job ${bvid}`);
      return raw.filter(plan => !wantedDir || plan.localDir === wantedDir).map(clonePlan);
    });
  }

  record(bvid: string, plan: LocalCleanupPlan, jobId: string, now: number) {
    const validatedPlan = decodeLocalCleanupPlan(plan, `cleanup plan ${plan.id}`);
    if (!validatedPlan.localDir || !validatedPlan.manifestSessionId) return false;
    const db = this.connection();
    const row = db.prepare<unknown[], CleanupPlanJobRow>('SELECT payload_json FROM jobs WHERE id=? AND bvid=?').get(jobId, bvid);
    if (!row) return false;
    const jobPayload = payload(row.payload_json);
    const filesByPath = new Map<string, LocalCleanupPlanFile>();
    for (const file of validatedPlan.files) {
      const relativePath = normalizeRelative(file?.relativePath);
      const expectedSize = Number(file?.expectedSize);
      const identity = file?.expectedIdentity;
      const remotePaths = [...new Set((Array.isArray(file?.remotePaths) ? file.remotePaths : [])
        .map(value => String(value || '').trim()).filter(Boolean))];
      if (!relativePath || !Number.isFinite(expectedSize) || expectedSize < 0 || remotePaths.length === 0
        || !identity || ![identity.dev, identity.ino, identity.mtimeMs, identity.ctimeMs].every(Number.isFinite)) return false;
      const existing = filesByPath.get(relativePath);
      if (existing && existing.expectedSize !== expectedSize) return false;
      filesByPath.set(relativePath, {
        relativePath, expectedSize, expectedIdentity: { ...identity },
        remotePaths: [...new Set([...(existing?.remotePaths || []), ...remotePaths])],
      });
    }
    if (filesByPath.size === 0 || !String(plan.id || '')) return false;
    const normalized: LocalCleanupPlan = {
      id: validatedPlan.id, localDir: validatedPlan.localDir, manifestSessionId: validatedPlan.manifestSessionId,
      transferSessionId: validatedPlan.transferSessionId,
      transferGeneration: validatedPlan.transferGeneration,
      reason: validatedPlan.reason,
      files: [...filesByPath.values()], createdAt: validatedPlan.createdAt,
    };
    const existingPlans = cleanupPlans(jobPayload.localCleanupPlans, `job ${jobId}`);
    const current = existingPlans.find(item => item.id === normalized.id);
    if (current && (current.localDir !== normalized.localDir || current.manifestSessionId !== normalized.manifestSessionId)) return false;
    const mergedFiles = new Map<string, LocalCleanupPlanFile>();
    for (const file of current?.files || []) mergedFiles.set(file.relativePath, clonePlan({ ...normalized, files: [file] }).files[0]);
    for (const file of normalized.files) {
      const previous = mergedFiles.get(file.relativePath);
      if (previous && (previous.expectedSize !== file.expectedSize || JSON.stringify(previous.expectedIdentity) !== JSON.stringify(file.expectedIdentity))) return false;
      mergedFiles.set(file.relativePath, { ...file, expectedIdentity: { ...file.expectedIdentity }, remotePaths: [...new Set([...(previous?.remotePaths || []), ...file.remotePaths])] });
    }
    const nextPlan = { ...normalized, createdAt: current?.createdAt || normalized.createdAt, files: [...mergedFiles.values()] };
    const nextPlans = current ? existingPlans.map(item => item.id === nextPlan.id ? nextPlan : item) : [...existingPlans, nextPlan];
    if (JSON.stringify(existingPlans) === JSON.stringify(nextPlans)) return false;
    db.prepare('UPDATE jobs SET payload_json=?, updated_at=? WHERE id=? AND bvid=?').run(JSON.stringify({ ...jobPayload, localCleanupPlans: nextPlans }), now, jobId, bvid);
    return true;
  }

  reconcile(bvid: string, localDir: string, remainingRelativePaths: Iterable<string>, removedDirectory: boolean, now: number) {
    const remaining = new Set([...remainingRelativePaths].map(normalizeRelative).filter((value): value is string => Boolean(value)));
    const db = this.connection();
    return db.transaction(() => {
      const rows = db.prepare<unknown[], CleanupPlanRecordRow>("SELECT id, status, payload_json FROM jobs WHERE bvid=? AND json_type(payload_json, '$.localCleanupPlans')='array'").all(bvid);
      let changed = false;
      for (const row of rows) {
        const jobPayload = payload(row.payload_json);
        const plans = cleanupPlans(jobPayload.localCleanupPlans, `job ${row.id}`);
        const next = plans.flatMap(plan => {
          if (plan.localDir !== localDir) return [plan];
          const files = removedDirectory ? [] : plan.files.filter(file => remaining.has(normalizeRelative(file.relativePath) || ''));
          return files.length ? [{ ...plan, files }] : [];
        });
        if (JSON.stringify(plans) === JSON.stringify(next)) continue;
        changed = true;
        if (next.length === 0 && row.status === 'completed') db.prepare("DELETE FROM jobs WHERE id=? AND status='completed'").run(row.id);
        else db.prepare('UPDATE jobs SET payload_json=?, updated_at=? WHERE id=?').run(JSON.stringify({ ...jobPayload, localCleanupPlans: next }), now, row.id);
      }
      return changed;
    })();
  }
}
