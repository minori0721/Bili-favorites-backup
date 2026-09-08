import { isRecord } from '../../shared/api.js';
function record(value: unknown) {
    if (!isRecord(value))
        throw new Error('画质重调响应格式错误');
    return value;
}
function text(value: unknown): string {
    if (value === undefined)
        return '';
    if (typeof value !== 'string')
        throw new Error('画质重调字段格式错误');
    return value;
}
function count(value: unknown): number {
    if (value === undefined)
        return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error('画质重调计数格式错误');
    return value;
}
function flag(value: unknown): boolean {
    if (value === undefined)
        return false;
    if (typeof value !== 'boolean')
        throw new Error('画质重调设置格式错误');
    return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
    if (!Array.isArray(value))
        throw new Error('画质重调列表格式错误');
    return value.map(parse);
}
function candidate(value: unknown) {
    const item = record(value);
    const key = text(item.key);
    if (!key)
        throw new Error('画质重调候选缺少标识');
    return { key, bvid: text(item.bvid), title: text(item.title), ownerName: text(item.ownerName), folderTitle: text(item.folderTitle), remotePath: text(item.remotePath), reason: text(item.reason), forceUnknown: false,
        oldFiles: list(item.oldFiles ?? [], value => { const file = record(value); return { name: text(file.name), path: text(file.path) }; }) };
}
export function parseQualityPreview(value: unknown) {
    const data = record(value);
    const target = record(data.target ?? {});
    const candidates = list(data.candidates, candidate);
    const uncertain = list(data.uncertain ?? [], candidate);
    if (new Set([...candidates, ...uncertain].map(item => item.key)).size !== candidates.length + uncertain.length)
        throw new Error('画质重调候选重复');
    const skipped = list(data.skipped ?? [], value => { const item = record(value); return { bvid: text(item.bvid), title: text(item.title), folderTitle: text(item.folderTitle), reason: text(item.reason) }; });
    return { candidates, uncertain, skipped, skippedTotal: count(data.skippedTotal ?? skipped.length), target: { quality: text(target.quality), encoding: text(target.encoding), hiRes: flag(target.hiRes), dolby: flag(target.dolby) } };
}
export type QualityPreview = ReturnType<typeof parseQualityPreview>;
export function parseQualityResult(value: unknown) {
    const data = record(value);
    return { queued: list(data.queued, value => { const item = record(value); return { key: text(item.key), bvid: text(item.bvid), title: text(item.title), artifactKey: text(item.artifactKey) }; }),
        skipped: list(data.skipped, value => { const item = record(value); return { key: text(item.key), reason: text(item.reason) }; }), downloadGroups: count(data.downloadGroups) };
}
export function parseQualityState(value: unknown) {
    const data = record(value);
    return { running: list(data.running, value => { const item = record(value); return { stageLabel: text(item.stageLabel), targetCount: count(item.targetCount) }; }), completed: list(data.completed, record).length };
}
