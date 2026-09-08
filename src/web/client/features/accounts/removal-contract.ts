import { isRecord } from '../../../../shared/api/value.js';

export function parseRemovalPreview(value: unknown) {
  if (!isRecord(value) || typeof value.previewId !== 'string' || !value.previewId) throw new Error('账号清理预览格式错误');
  const count = (key: string) => {
    const field = value[key];
    if (field == null) return 0;
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) throw new Error('账号清理计数格式错误');
    return field;
  };
  return {previewId:value.previewId,relationCount:count('relationCount'),sourceCount:count('sourceCount'),fileCount:count('fileCount'),
    totalBytes:count('totalBytes'),sharedCount:count('sharedCount'),activeTasks:count('activeTasks')};
}

export interface RemovalOperation extends Record<string, unknown> { id: string; status: string }
export function parseRemovalOperation(value: unknown): RemovalOperation {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.status !== 'string') throw new Error('归档清理状态格式错误');
  return {...value,id:value.id,status:value.status};
}
export function parseRemovalResult(value: unknown) {
  if (!isRecord(value)) throw new Error('账号删除响应格式错误');
  if (value.operation === undefined) return {operation:undefined};
  if (!isRecord(value.operation) || typeof value.operation.id !== 'string' || !value.operation.id) {
    throw new Error('账号删除响应缺少清理任务 ID');
  }
  return {operation:{id:value.operation.id}};
}
