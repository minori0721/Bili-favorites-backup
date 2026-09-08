import { isRecord } from '../../shared/api.js';
function record(value: unknown) {
    if (!isRecord(value))
        throw new Error('重命名响应格式错误');
    return value;
}
function text(value: unknown, required = false): string {
    if (value === undefined && !required)
        return '';
    if (typeof value !== 'string' || (required && !value))
        throw new Error('重命名字段格式错误');
    return value;
}
function count(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error('重命名计数格式错误');
    return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
    if (!Array.isArray(value))
        throw new Error('重命名列表格式错误');
    return value.map(parse);
}
export function parseRenameScan(value: unknown) {
    if (value == null)
        return null;
    const data = record(value);
    const status = ['scanning', 'ready', 'failed', 'expired'].find(item => item === data.status);
    if (!status || (data.complete !== undefined && typeof data.complete !== 'boolean'))
        throw new Error('远端扫描状态格式错误');
    return { status, complete: data.complete, error: text(data.error) };
}
export function parseRenamePreview(value: unknown) {
    const data = record(value);
    const candidates = list(data.candidates, item => {
        const row = record(item);
        return { candidateId: text(row.candidateId, true), bvid: text(row.bvid), title: text(row.title), ownerName: text(row.ownerName),
            remoteDir: text(row.remoteDir), oldName: text(row.oldName), newName: text(row.newName), oldPath: text(row.oldPath, true), newPath: text(row.newPath, true), reason: text(row.reason) };
    });
    if (new Set(candidates.map(item => item.candidateId)).size !== candidates.length)
        throw new Error('重命名候选重复');
    const skipped = list(data.skipped ?? [], item => { const row = record(item); return { path: text(row.path), reason: text(row.reason) }; });
    return { previewId: text(data.previewId, true), revision: count(data.revision), expiresAt: count(data.expiresAt), candidates, skipped,
        skippedTotal: count(data.skippedTotal ?? skipped.length), remoteScan: parseRenameScan(data.remoteScan) };
}
export type RenamePreview = ReturnType<typeof parseRenamePreview>;
export function parseRenameUpdate(value: unknown) {
    const data = record(value);
    if (data.unchanged === true)
        return { unchanged: true as const, remoteScan: parseRenameScan(data.remoteScan) };
    return { unchanged: false as const, preview: parseRenamePreview(data) };
}
export function parseRenameResult(value: unknown) {
    const data = record(value);
    return { success: count(data.success), failed: count(data.failed), results: list(data.results, item => {
            const row = record(item);
            if (typeof row.ok !== 'boolean')
                throw new Error('重命名结果格式错误');
            return { ok: row.ok, status: text(row.status), oldPath: text(row.oldPath), newPath: text(row.newPath), actualPath: text(row.actualPath),
                observedPaths: list(row.observedPaths ?? [], item => text(item, true)), error: text(row.error) };
        }) };
}
