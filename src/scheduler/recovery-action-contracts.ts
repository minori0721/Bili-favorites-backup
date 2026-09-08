import type { RecoveryIssue } from './recovery-contracts.js';

export type RecoveryActionResult =
  | { ok: false; status: number; message: string }
  | { ok: true; issues?: RecoveryIssue[]; idempotent?: boolean; childJobId?: string; jobId?: string };

export interface RecoveryActionOptions {
  encodingPriority?: unknown;
  strict?: unknown;
  userId?: unknown;
  quality?: unknown;
}
