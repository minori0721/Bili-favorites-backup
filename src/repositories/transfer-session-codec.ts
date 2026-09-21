import { isRecord } from '../shared/api/value.js';
import type { TransferSessionRecord, TransferSessionFileRecord } from './transfer-sessions.js';

function row(value: unknown) {
  if (!isRecord(value)) throw new Error('Missing persisted transfer record');
  return value;
}
function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new Error(`Invalid persisted transfer field: ${key}`);
  return value;
}
function optionalText(source: Record<string, unknown>, key: string) {
  return source[key] == null ? undefined : text(source, key) || undefined;
}
function integer(source: Record<string, unknown>, key: string, minimum = 0): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid persisted transfer field: ${key}`);
  return value;
}
function optionalInteger(source: Record<string, unknown>, key: string, minimum = 0) {
  return source[key] == null ? undefined : integer(source, key, minimum);
}
function flag(source: Record<string, unknown>, key: string) {
  const value = integer(source, key);
  if (value !== 0 && value !== 1) throw new Error(`Invalid persisted transfer flag: ${key}`);
  return value === 1;
}
export function sessionFromRow(value: unknown): TransferSessionRecord {
  const source = row(value);
  const raw = text(source, 'phase');
  const phase = raw === 'staging' || raw === 'promoting' ? 'uploading'
    : raw === 'awaiting_stage' || raw === 'awaiting_final' ? 'awaiting_remote' : raw;
  if (phase !== 'uploading' && phase !== 'awaiting_remote' && phase !== 'completed' && phase !== 'failed' && phase !== 'superseded') throw new Error('Invalid persisted transfer phase');
  const remotePath = text(source, 'remote_path');
  return {
    id: text(source, 'id'), dedupeKey: text(source, 'dedupe_key'), kind: 'upload', bvid: text(source, 'bvid'),
    userId: optionalText(source, 'user_id'), mediaId: optionalInteger(source, 'media_id', -1),
    localDir: text(source, 'local_dir'), remotePath,
    // Legacy staging columns remain on disk; direct uploads use the final path.
    stagingPath: remotePath, phase, generation: integer(source, 'generation', 1),
    historyOnly: flag(source, 'history_only'), historySnapshotAt: optionalText(source, 'history_snapshot_at'),
    allowReupload: flag(source, 'allow_reupload'), lastError: optionalText(source, 'last_error'),
    createdAt: integer(source, 'created_at'), updatedAt: integer(source, 'updated_at'), completedAt: optionalInteger(source, 'completed_at'),
  };
}
export function fileFromRow(value: unknown): TransferSessionFileRecord {
  const source = row(value);
  const raw = text(source, 'status');
  const status = raw === 'awaiting_stage' || raw === 'stage_verified' || raw === 'moving' || raw === 'awaiting_final' ? 'awaiting_remote' : raw;
  if (status !== 'pending' && status !== 'uploading' && status !== 'awaiting_remote' && status !== 'verified' && status !== 'failed') throw new Error('Invalid persisted transfer file status');
  const finalPath = text(source, 'final_path');
  return {
    sessionId: text(source, 'session_id'), generation: integer(source, 'generation', 1), relativePath: text(source, 'relative_path'),
    name: text(source, 'name'), stagingPath: finalPath, finalPath, expectedSize: integer(source, 'expected_size'), status,
    putAcceptedAt: optionalInteger(source, 'put_accepted_at'), stageVerifiedAt: optionalInteger(source, 'stage_verified_at'),
    movedAt: optionalInteger(source, 'moved_at'), verifiedAt: optionalInteger(source, 'verified_at'), attempts: integer(source, 'attempts'),
    nextCheckAt: optionalInteger(source, 'next_check_at'), lastError: optionalText(source, 'last_error'),
    createdAt: integer(source, 'created_at'), updatedAt: integer(source, 'updated_at'),
  };
}
