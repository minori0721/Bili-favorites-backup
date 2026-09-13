import { isRecord, ResponseFormatError } from './value.js';
import { parseQueueStatus } from './queue-status.js';
import { parseQueueBoardItem, type QueueBoardStage } from './queue-item.js';

/** Transport boundary only. Individual views narrow the fields that they consume. */
export interface QueueSnapshot extends Record<string,unknown> {
  downloadPending:Record<string,unknown>[];
  downloadRunning:Record<string,unknown>[];
  uploadPending:Record<string,unknown>[];
  uploadRunning:Record<string,unknown>[];
  issues:Record<string,unknown>[];
  issueSummary?:Record<string,unknown>;
}
function items(value:unknown, stage?: QueueBoardStage):Record<string,unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new ResponseFormatError('任务中心列表格式错误');
  return stage ? value.map((item) => parseQueueBoardItem(item, stage)) : value;
}
/** Mutation responses update only issues, never the scheduler or board columns. */
export function parseQueueIssueUpdate(value: unknown) {
  if (!isRecord(value)) throw new ResponseFormatError('待处理更新格式错误');
  if (value.issueSummary != null && !isRecord(value.issueSummary)) throw new ResponseFormatError('任务中心汇总格式错误');
  return {issues: value.issues == null ? [...items(value.actionRequiredIssues), ...items(value.intentionalConfirmations)] : items(value.issues),
    issueSummary: isRecord(value.issueSummary) ? value.issueSummary : undefined};
}
export function parseQueueSnapshot(value:unknown):QueueSnapshot {
  if (!isRecord(value)) throw new ResponseFormatError('任务中心响应格式错误');
  parseQueueStatus(value);
  if (value.issueSummary != null && !isRecord(value.issueSummary)) throw new ResponseFormatError('任务中心汇总格式错误');
  return {...value,
    downloadPending:items(value.downloadPending, 'download_pending'), downloadRunning:items(value.downloadRunning, 'download_running'),
    uploadPending:items(value.uploadPending, 'upload_pending'), uploadRunning:items(value.uploadRunning, 'upload_running'),
    ...parseQueueIssueUpdate(value),
  };
}
