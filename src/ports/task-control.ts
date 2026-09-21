import type { RecoveryIssueActionId } from '../recovery-policy.js';
import type { RecoveryActionOptions, RecoveryActionResult } from '../scheduler/recovery-action-contracts.js';

/** HTTP needs the task identity, never the persisted job or a scheduler instance. */
export type UploadRecoveryResult =
  | { ok: false; status: number; message: string }
  | { ok: true; job: { id: string }; idempotent: boolean; resolved?: string };

export interface RecoveryPort {
  recoverUploadJob(jobId: string, allowReupload?: boolean): Promise<UploadRecoveryResult>;
  resolveRecoveryIssue(id: string, action: RecoveryIssueActionId, options: RecoveryActionOptions): Promise<RecoveryActionResult>;
}

export interface SyncControlPort {
  sync(): { started: boolean; queued: boolean };
  reconcile(): { started: boolean; queued: boolean };
  remote(): { started: boolean; queued: boolean };
}
