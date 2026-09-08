import type { UploadTarget } from '../tasks.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}

export function retirementTargets(value: unknown): UploadTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const item = record(raw);
    if (typeof item.userId !== 'string' || !item.userId || !Number.isInteger(Number(item.mediaId))) return [];
    return [{ userId: item.userId, mediaId: Number(item.mediaId), folderTitle: String(item.folderTitle || ''), remotePath: String(item.remotePath || '') }];
  });
}

export function archiveTaskReferencesUser(value: unknown, userId: string) {
  const task = record(value);
  if (String(task.userId || '') === userId || String(task.downloadUserId || '') === userId) return true;
  const control = record(task.control);
  if (String(control.userId || '') === userId || String(control.downloadUserId || '') === userId) return true;
  const payload = record(record(task.persistentJob).payload);
  if ([payload.primaryUserId, payload.downloadUserId, payload.pausedForUserId].some(value => String(value || '') === userId)) return true;
  return [task.targets, control.targets, payload.targets, payload.detachedTargets, [payload.target]]
    .some(value => Array.isArray(value) && value.some(target => String(record(target).userId || '') === userId));
}
