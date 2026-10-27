import { isRecord, ResponseFormatError } from './value.js';
import { parseQueueStatus, type QueueStatus } from './queue-status.js';
import { parseQueueBoardItem, type QueueBoardStage } from './queue-item.js';

/** Transport boundary only. Individual views narrow the fields that they consume. */
export interface QueueSnapshot extends Record<string,unknown> {
  downloadPending:ReturnType<typeof parseQueueBoardItem>[];
  downloadRunning:ReturnType<typeof parseQueueBoardItem>[];
  uploadPending:ReturnType<typeof parseQueueBoardItem>[];
  uploadRunning:ReturnType<typeof parseQueueBoardItem>[];
  issues:Record<string,unknown>[];
  issueSummary?:Record<string,unknown>;
  summary?:{running:number;waiting:number};
  statusView:QueueStatus;
}
function items(value:unknown):Record<string,unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new ResponseFormatError('任务中心列表格式错误');
  return value;
}
function boardItems(value:unknown,stage:QueueBoardStage){return items(value).map(item=>parseQueueBoardItem(item,stage));}
function summaryCount(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ResponseFormatError('队列完整计数格式错误');
  return value;
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
  const statusView=parseQueueStatus(value);
  let summary:QueueSnapshot['summary'];
  if(value.summary!==undefined){
    if(!isRecord(value.summary))throw new ResponseFormatError('队列完整计数格式错误');
    summary={running:summaryCount(value.summary.running),waiting:summaryCount(value.summary.waiting)};
  }
  if (value.issueSummary != null && !isRecord(value.issueSummary)) throw new ResponseFormatError('任务中心汇总格式错误');
  return {...value,
    summary,statusView,
    downloadPending:boardItems(value.downloadPending, 'download_pending'), downloadRunning:boardItems(value.downloadRunning, 'download_running'),
    uploadPending:boardItems(value.uploadPending, 'upload_pending'), uploadRunning:boardItems(value.uploadRunning, 'upload_running'),
    ...parseQueueIssueUpdate(value),
  };
}
