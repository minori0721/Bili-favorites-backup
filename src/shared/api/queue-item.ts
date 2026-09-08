import { isRecord } from './value.js';

export type QueueBoardStage = "download_pending" | "download_running" | "upload_pending" | "upload_running";
export type QueueBoardPhase =
  | "queued"
  | "leased"
  | "running"
  | "retry_wait"
  | "remote_verifying"
  | "background_wait"
  | "manual_action";
export type QueueBoardAction = "retry" | "verify" | "recheck" | "redownload_with_encoding" | "abandon_attempt";

export interface QueueBoardItem {
  id: string;
  bvid: string;
  title: string;
  upperName: string;
  cover: string;
  folderTitle: string;
  remotePath: string;
  detail: string;
  userId: string;
  mediaId: number;
  retries: number;
  maxRetries: number;
  queuedAt?: number;
  startedAt?: number;
  retryAt?: number;
  sequence?: number;
  status?: string;
  phase?: QueueBoardPhase;
  nextAction?: QueueBoardAction;
  nextActionAt?: number;
  actionRequired?: boolean;
  lastError?: string;
  coverLocalPath?: string;
  persistentJobId?: string;
  awaitingManualRecovery?: boolean;
  recoveryJobId?: string;
  recoveryDisposition?: "background" | "action_required" | "intentional_confirmation";
  recoveryIssueId?: string;
  recoveryKind?: string;
  recoveryActions?: Array<{ id: QueueBoardAction; label: string }>;
  lifecycleState?: string;
  verifiedPages?: number;
  totalPages?: number;
  stage: QueueBoardStage;
}

export type QueueBoardDisplayItem = Partial<QueueBoardItem> & { stage: QueueBoardStage; ownerName?: string };

function optionalText(value: unknown, field: string) {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`任务 ${field} 格式错误`);
  return value;
}
function optionalNumber(value: unknown, field: string) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`任务 ${field} 格式错误`);
  return value;
}
function optionalFlag(value: unknown, field: string) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`任务 ${field} 格式错误`);
  return value;
}


function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T | undefined {
  if (value == null) return undefined;
  for (const candidate of choices) if (value === candidate) return candidate;
  throw new Error(`任务 ${field} 格式错误`);
}
const actions: readonly QueueBoardAction[] = ['retry', 'verify', 'recheck', 'redownload_with_encoding', 'abandon_attempt'];

/** Display fields are explicitly narrowed; omitted fields remain optional. */
export function parseQueueBoardItem(value: unknown, fallbackStage: QueueBoardStage): QueueBoardDisplayItem & Record<string, unknown> {
  if (!isRecord(value)) throw new Error('任务项目格式错误');
  let recoveryActions: QueueBoardItem['recoveryActions'];
  if (value.recoveryActions != null) {
    if (!Array.isArray(value.recoveryActions)) throw new Error('任务恢复动作格式错误');
    recoveryActions = value.recoveryActions.map(action => {
      if (!isRecord(action)) throw new Error('任务恢复动作格式错误');
      const id = choice(action.id, actions, '恢复动作');
      const label = optionalText(action.label, '恢复动作标签');
      if (id === undefined || label === undefined) throw new Error('任务恢复动作格式错误');
      return { id, label };
    });
  }
  return {
    id: optionalText(value.id, 'id'),
    bvid: optionalText(value.bvid, 'bvid'),
    title: optionalText(value.title, 'title'),
    upperName: optionalText(value.upperName, 'upperName'),
    cover: optionalText(value.cover, 'cover'),
    folderTitle: optionalText(value.folderTitle, 'folderTitle'),
    remotePath: optionalText(value.remotePath, 'remotePath'),
    detail: optionalText(value.detail, 'detail'),
    userId: optionalText(value.userId, 'userId'),
    status: optionalText(value.status, 'status'),
    lastError: optionalText(value.lastError, 'lastError'),
    coverLocalPath: optionalText(value.coverLocalPath, 'coverLocalPath'),
    persistentJobId: optionalText(value.persistentJobId, 'persistentJobId'),
    recoveryJobId: optionalText(value.recoveryJobId, 'recoveryJobId'),
    recoveryIssueId: optionalText(value.recoveryIssueId, 'recoveryIssueId'),
    recoveryKind: optionalText(value.recoveryKind, 'recoveryKind'),
    lifecycleState: optionalText(value.lifecycleState, 'lifecycleState'),
    ownerName: optionalText(value.ownerName, 'ownerName'),
    queuedAt: optionalNumber(value.queuedAt, 'queuedAt'),
    startedAt: optionalNumber(value.startedAt, 'startedAt'),
    retryAt: optionalNumber(value.retryAt, 'retryAt'),
    sequence: optionalNumber(value.sequence, 'sequence'),
    nextActionAt: optionalNumber(value.nextActionAt, 'nextActionAt'),
    retries: optionalNumber(value.retries, 'retries'),
    maxRetries: optionalNumber(value.maxRetries, 'maxRetries'),
    mediaId: optionalNumber(value.mediaId, 'mediaId'),
    verifiedPages: optionalNumber(value.verifiedPages, 'verifiedPages'),
    totalPages: optionalNumber(value.totalPages, 'totalPages'),
    actionRequired: optionalFlag(value.actionRequired, 'actionRequired'),
    awaitingManualRecovery: optionalFlag(value.awaitingManualRecovery, 'awaitingManualRecovery'),
    stage: choice<QueueBoardStage>(value.stage, ['download_pending', 'download_running', 'upload_pending', 'upload_running'], '阶段') ?? fallbackStage,
    phase: choice<QueueBoardPhase>(value.phase, ['queued', 'leased', 'running', 'retry_wait', 'remote_verifying', 'background_wait', 'manual_action'], '阶段状态'),
    nextAction: choice(value.nextAction, actions, '下一动作'),
    recoveryDisposition: choice(value.recoveryDisposition, ['background', 'action_required', 'intentional_confirmation'], '恢复处置'),
    recoveryActions,
  };
}
