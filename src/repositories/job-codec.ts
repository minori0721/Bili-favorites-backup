import { isRecord } from '../shared/api/value.js';
import type { PersistentJobRecord } from '../database.js';

export function readPersistedJobPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Missing persisted job payload');
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Invalid persisted job payload');
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
export function rowToJob(value: unknown): PersistentJobRecord {
  if (!isRecord(value)) throw new Error('Invalid persisted job row');
  return {
    id: text(value, 'id'), kind: text(value, 'kind'), dedupeKey: text(value, 'dedupe_key'),
    bvid: optionalText(value, 'bvid'), userId: optionalText(value, 'user_id'),
    mediaId: optionalInteger(value, 'media_id'), status: status(value.status),
    priority: integer(value, 'priority'), payload: readPersistedJobPayload(value.payload_json),
    attempts: integer(value, 'attempts'), maxAttempts: integer(value, 'max_attempts'),
    notBefore: integer(value, 'not_before'), leaseOwner: optionalText(value, 'lease_owner'),
    leaseExpiresAt: optionalInteger(value, 'lease_expires_at'), lastError: optionalText(value, 'last_error'),
    createdAt: integer(value, 'created_at'), updatedAt: integer(value, 'updated_at'),
  };
}
