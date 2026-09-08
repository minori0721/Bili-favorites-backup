import { isRecord } from '../../shared/api.js';
export function parseCleanupState(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.items) || typeof value.runningTransfers !== 'boolean' || typeof value.activeScheduler !== 'boolean')
        throw new Error('清理状态格式错误');
    return { runningTransfers: value.runningTransfers, activeScheduler: value.activeScheduler, items: value.items.map((item: unknown) => {
            if (!isRecord(item) || typeof item.key !== 'string' || typeof item.label !== 'string' || typeof item.important !== 'boolean'
                || typeof item.bytes !== 'number' || !Number.isFinite(item.bytes) || item.bytes < 0)
                throw new Error('清理项目格式错误');
            return { key: item.key, label: item.label, important: item.important, bytes: item.bytes };
        }) };
}
export function parseCleanupResults(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.results))
        throw new Error('清理结果格式错误');
    return value.results.map((item: unknown) => {
        if (!isRecord(item) || typeof item.label !== 'string' || typeof item.ok !== 'boolean'
            || (item.skipped !== undefined && typeof item.skipped !== 'boolean')
            || (item.note !== undefined && typeof item.note !== 'string')
            || (item.error !== undefined && typeof item.error !== 'string'))
            throw new Error('清理项目结果格式错误');
        return { label: item.label, ok: item.ok, skipped: item.skipped === true, note: typeof item.note === 'string' ? item.note : '', error: typeof item.error === 'string' ? item.error : '' };
    });
}
