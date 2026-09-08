import { isRecord } from '../../shared/api.js';
function record(value: unknown) { if (!isRecord(value))
    throw new Error('迁移响应格式错误'); return value; }
function count(value: unknown) { if (value === undefined || value === null)
    return 0; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('迁移计数格式错误'); return value; }
function text(value: unknown) { if (value === undefined || value === null)
    return ''; if (typeof value !== 'string')
    throw new Error('迁移说明格式错误'); return value; }
export function parseMigrationEstimate(value: unknown) { const data = record(value); return { mode: text(data.mode), resumableItems: count(data.resumableItems), retainedBytes: count(data.retainedBytes), pendingUploadItems: count(data.pendingUploadItems), files: count(data.files), expandedBytes: count(data.expandedBytes) }; }
export function parseMigrationPreview(value: unknown) { const data = record(value); const manifest = record(data.manifest); const counts = record(manifest.counts ?? {}); const conflicts = record(data.conflicts ?? {}); return { version: text(manifest.version), exportedAt: text(manifest.exportedAt), mode: text(manifest.mode), users: count(counts.users), videos: count(counts.videos), relations: count(counts.relations), unavailableVideos: count(counts.unavailableVideos), tempItemCount: count(conflicts.tempItemCount) }; }
export function parseMigrationResult(value: unknown) { const data = record(value); if (!Array.isArray(data.restored) || !data.restored.every(item => typeof item === 'string'))
    throw new Error('迁移恢复结果格式错误'); return { restored: data.restored, backupPath: text(data.backupPath) }; }
