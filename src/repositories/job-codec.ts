import { isRecord } from '../shared/api/value.js';
import type { PersistentJobRecord } from '../database.js';

/** A row returned by better-sqlite3 after the SQL boundary has been checked. */
type SqlRow = Readonly<Record<string, unknown>>;

export interface CountRow {
  readonly count: number;
}

export interface CountAndNextAtRow extends CountRow {
  readonly next_at: number | null;
}

export interface NextAtRow {
  readonly next_at: number | null;
}

export interface JobCountRow extends CountRow {
  readonly kind: string;
  readonly status: string;
}

export interface SessionIdentityRow {
  readonly session_id: string | number;
  readonly session_generation: number;
}

export interface JobRetryRow {
  readonly kind: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly payload_json?: string;
}

export interface PayloadRow {
  readonly payload_json: string;
}

export interface StatusPayloadRow extends PayloadRow {
  readonly status: PersistentJobRecord['status'];
}

export interface AttemptsRow {
  readonly attempts: number;
}

export interface IdRow {
  readonly id: string;
}

export interface BvidProjectionRow {
  readonly bvid: string;
}

export interface QualityTargetProjectionRow {
  readonly kind: string;
  readonly bvid: string | null;
  readonly user_id: string | null;
  readonly media_id: number | null;
  readonly payload_json: string;
}

function decodeSqlRow(value: unknown, context: string): SqlRow | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`Invalid SQL row for ${context}`);
  return value;
}

function decodeSqlRows(value: unknown, context: string): SqlRow[] {
  if (!Array.isArray(value)) throw new Error(`Invalid SQL rows for ${context}`);
  return value.map((row, index) => {
    const decoded = decodeSqlRow(row, `${context}[${index}]`);
    if (!decoded) throw new Error(`Missing SQL row for ${context}[${index}]`);
    return decoded;
  });
}

export function decodeJobRow(value: unknown, context: string): PersistentJobRecord | undefined {
  const row = decodeSqlRow(value, context);
  return row ? rowToJob(row, context) : undefined;
}

export function decodeJobRows(value: unknown, context: string): PersistentJobRecord[] {
  return decodeSqlRows(value, context).map((row, index) => rowToJob(row, `${context}[${index}]`));
}

function requiredRow(value: unknown, context: string): SqlRow {
  const row = decodeSqlRow(value, context);
  if (!row) throw new Error(`Missing SQL row for ${context}`);
  return row;
}

export function decodeCountRow(value: unknown, context: string): CountRow {
  const row = requiredRow(value, context);
  if (typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0) {
    throw new Error(`Invalid non-negative count for ${context}`);
  }
  return { count: row.count };
}

export function decodeCountAndNextAtRow(value: unknown, context: string): CountAndNextAtRow {
  const row = requiredRow(value, context);
  const count = decodeCountRow(row, context).count;
  const nextAt = decodeNextAtRow(row, context).next_at;
  return { count, next_at: nextAt === null ? null : nextAt };
}

export function decodeNextAtRow(value: unknown, context: string): NextAtRow {
  const row = requiredRow(value, context);
  if (row.next_at !== null && (typeof row.next_at !== 'number' || !Number.isSafeInteger(row.next_at) || row.next_at < 0)) {
    throw new Error(`Invalid next_at for ${context}`);
  }
  return { next_at: row.next_at };
}

export function decodeJobCountRow(value: unknown, context: string): JobCountRow {
  const row = requiredRow(value, context);
  const count = decodeCountRow(row, context).count;
  if (typeof row.kind !== 'string' || row.kind.length === 0) throw new Error(`Invalid kind for ${context}`);
  if (typeof row.status !== 'string' || row.status.length === 0) throw new Error(`Invalid status for ${context}`);
  return { kind: row.kind, status: row.status, count };
}

export function decodeSessionIdentityRow(value: unknown, context: string): SessionIdentityRow {
  const row = requiredRow(value, context);
  if ((typeof row.session_id !== 'string' && typeof row.session_id !== 'number') || row.session_id === '') {
    throw new Error(`Invalid session_id for ${context}`);
  }
  const legacyGeneration = row.session_generation === null || row.session_generation === undefined;
  const generation = legacyGeneration && row.legacy_generation === 1 ? 1 : row.session_generation;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Invalid session_generation for ${context}`);
  }
  return { session_id: row.session_id, session_generation: generation };
}

export function decodeBvidProjectionRow(value: unknown, context: string): BvidProjectionRow {
  const row = requiredRow(value, context);
  if (typeof row.bvid !== 'string' || row.bvid.length === 0) throw new Error(`Invalid bvid for ${context}`);
  return { bvid: row.bvid };
}

function decodeSqlStringField(row: SqlRow, key: string, context: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid ${key} for ${context}`);
  return value;
}

function decodeSqlIntegerField(row: SqlRow, key: string, context: string, minimum?: number): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(`Invalid ${key} for ${context}`);
  }
  return value;
}

export function decodePayloadRow(value: unknown, context: string): PayloadRow {
  const row = requiredRow(value, context);
  if (typeof row.payload_json !== 'string') throw new Error(`Invalid payload_json for ${context}`);
  return { payload_json: row.payload_json };
}

export function decodeAttemptsRow(value: unknown, context: string): AttemptsRow {
  const row = requiredRow(value, context);
  return { attempts: decodeSqlIntegerField(row, 'attempts', context, 0) };
}

export function decodeJobRetryRow(value: unknown, context: string, withPayload = false): JobRetryRow {
  const row = requiredRow(value, context);
  const kind = decodeSqlStringField(row, 'kind', context);
  if (!kind) throw new Error(`Invalid kind for ${context}`);
  const decoded: JobRetryRow = {
    kind,
    attempts: decodeSqlIntegerField(row, 'attempts', context, 0),
    max_attempts: decodeSqlIntegerField(row, 'max_attempts', context, 1),
    ...(withPayload ? { payload_json: decodePayloadRow(row, context).payload_json } : {}),
  };
  return decoded;
}

export function decodeStatusPayloadRow(value: unknown, context: string): StatusPayloadRow {
  const row = requiredRow(value, context);
  return { status: status(row.status), payload_json: decodePayloadRow(row, context).payload_json };
}

export function decodeIdRow(value: unknown, context: string): IdRow {
  const row = requiredRow(value, context);
  if (typeof row.id !== 'string' || row.id.length === 0) throw new Error(`Invalid id for ${context}`);
  return { id: row.id };
}

export function decodeJobCountRows(value: unknown, context: string): JobCountRow[] {
  return decodeSqlRows(value, context).map((row, index) => decodeJobCountRow(row, `${context}[${index}]`));
}

export function decodeBvidProjectionRows(value: unknown, context: string): BvidProjectionRow[] {
  return decodeSqlRows(value, context).map((row, index) => decodeBvidProjectionRow(row, `${context}[${index}]`));
}

export function decodeSessionIdentityRows(value: unknown, context: string): SessionIdentityRow[] {
  return decodeSqlRows(value, context).map((row, index) => decodeSessionIdentityRow(row, `${context}[${index}]`));
}

export function decodeQualityTargetProjectionRows(value: unknown, context: string): QualityTargetProjectionRow[] {
  return decodeSqlRows(value, context).map((row, index) => decodeQualityTargetProjectionRow(row, `${context}[${index}]`));
}

export function decodeQualityTargetProjectionRow(value: unknown, context: string): QualityTargetProjectionRow {
  const row = requiredRow(value, context);
  if (typeof row.kind !== 'string' || row.kind.length === 0) throw new Error(`Invalid kind for ${context}`);
  if (row.bvid !== null && typeof row.bvid !== 'string') throw new Error(`Invalid bvid for ${context}`);
  if (row.user_id !== null && typeof row.user_id !== 'string') throw new Error(`Invalid user_id for ${context}`);
  if (row.media_id !== null && (typeof row.media_id !== 'number' || !Number.isSafeInteger(row.media_id))) {
    throw new Error(`Invalid media_id for ${context}`);
  }
  if (typeof row.payload_json !== 'string') throw new Error(`Invalid payload_json for ${context}`);
  const bvid = row.bvid;
  const userId = row.user_id;
  const mediaId = row.media_id;
  return { kind: row.kind, bvid, user_id: userId, media_id: mediaId, payload_json: row.payload_json };
}

export function readPersistedJobPayload(value: unknown, context = 'persisted job'): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Missing persisted job payload');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid persisted job payload JSON for ${context}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid persisted job payload for ${context}`);
  return parsed;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid persisted job field: ${key}`);
  return value;
}
function optionalText(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] == null ? undefined : text(row, key) || undefined;
}
function integer(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid persisted job field: ${key}`);
  return value;
}
function optionalInteger(row: Record<string, unknown>, key: string): number | undefined {
  return row[key] == null ? undefined : integer(row, key);
}
function status(value: unknown): PersistentJobRecord['status'] {
  switch (value) {
    case 'pending': case 'retry_wait': case 'leased': case 'running':
    case 'completed': case 'failed': case 'manual_wait': return value;
    default: throw new Error('Invalid persisted job status');
  }
}
/** Decode database output before it participates in scheduling or recovery. */
export function rowToJob(value: unknown, context = 'persisted job'): PersistentJobRecord {
  if (!isRecord(value)) throw new Error(`Invalid persisted job row for ${context}`);
  return {
    id: text(value, 'id'), kind: text(value, 'kind'), dedupeKey: text(value, 'dedupe_key'),
    bvid: optionalText(value, 'bvid'), userId: optionalText(value, 'user_id'),
    mediaId: optionalInteger(value, 'media_id'), status: status(value.status),
    priority: integer(value, 'priority'), payload: readPersistedJobPayload(value.payload_json, context),
    attempts: integer(value, 'attempts'), maxAttempts: integer(value, 'max_attempts'),
    notBefore: integer(value, 'not_before'), leaseOwner: optionalText(value, 'lease_owner'),
    leaseExpiresAt: optionalInteger(value, 'lease_expires_at'), lastError: optionalText(value, 'last_error'),
    createdAt: integer(value, 'created_at'), updatedAt: integer(value, 'updated_at'),
  };
}
