import { ApiError, type ApiClient } from '../../shared/api.js';
import { parseProbeCombination, parseProbeReference, parseProbeSummary } from '../../../../shared/api/media-probe.js';
import { isRecord, ResponseFormatError } from '../../../../shared/api/value.js';

const qualityOrder = ['360P', '480P', '720P', '720P60', '1080P', '1080P+', '1080P60', '4K', 'HDR', '杜比视界', '8K'];

/** Use returned streams, never the list of advertised or VIP-only quality names. */
export function describeQualityProbe(value: unknown, bvid: string) {
    const summary = parseProbeSummary(value);
    if (!isRecord(value) || value.bvid !== bvid) throw new ResponseFormatError('画质探测返回了其他视频');
    if (summary.status !== 'complete') return {status: summary.status, text: summary.error};
    if (!Array.isArray(value.pages) || value.pages.length === 0) throw new ResponseFormatError('画质探测缺少分P结果');
    const pages = value.pages.map(page => {
        if (!isRecord(page) || typeof page.pageIndex !== 'number' || !Number.isSafeInteger(page.pageIndex)
            || page.pageIndex < 1 || !Array.isArray(page.tracks)) throw new ResponseFormatError('画质探测分P格式错误');
        const tracks = page.tracks.map(parseProbeCombination).filter(track => track.available);
        if (!tracks.length) throw new ResponseFormatError(`P${page.pageIndex} 未返回可用视频流`);
        if (tracks.some(track => !track.quality || !track.encoding || !qualityOrder.includes(track.quality))) {
            throw new ResponseFormatError(`P${page.pageIndex} 返回了无法比较的画质或编码`);
        }
        const highest = Math.max(...tracks.map(track => qualityOrder.indexOf(track.quality || '')));
        const top = tracks.filter(track => qualityOrder.indexOf(track.quality || '') === highest);
        const encodings = [...new Set(top.map(track => track.encoding))].join('、');
        // BBDown returns tracks in the same preference order used for downloading.
        return {index: page.pageIndex, highest: `${qualityOrder[highest]} / ${encodings}`,
            selected: `${tracks[0].quality} / ${tracks[0].encoding}`};
    });
    if (new Set(pages.map(page => page.index)).size !== pages.length) throw new ResponseFormatError('画质探测分P重复');
    const describe = (kind: 'highest' | 'selected') => {
        const values = new Set(pages.map(page => page[kind]));
        return values.size === 1 ? `${pages.length > 1 ? '各分P均为 ' : ''}${pages[0][kind]}`
            : pages.map(page => `P${page.index}：${page[kind]}`).join('；');
    };
    return {status: 'complete' as const,
        text: `当前账号可获取最高：${describe('highest')}；本次预计下载：${describe('selected')}（已探测，下载时重新确认）`};
}

interface PreviewItem {userId: string; bvid: string}
interface ProbeRow {
    item: PreviewItem;
    views: Array<{text: HTMLElement; retry: HTMLButtonElement; visible: boolean}>;
    text: string;
    state: 'waiting' | 'queued' | 'running' | 'complete' | 'failed';
}

/** One visible preview owns one serial reader; closing it never starts further probes. */
export function createQualityPreviewProbe(document: Document, api: ApiClient) {
    const rows = new Map<string, ProbeRow>();
    const pending = new Set<string>();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishWait: (() => void) | undefined;
    let running = false;
    let disposed = false;
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!(entry.target instanceof HTMLElement)) continue;
            const key = entry.target.dataset.qualityProbeKey;
            const row = key ? rows.get(key) : undefined;
            const view = row?.views.find(view => view.text.parentElement === entry.target);
            if (!key || !row || !view) continue;
            view.visible = entry.isIntersecting;
            if (entry.isIntersecting && row.state === 'waiting') enqueue(key);
            else if (row.state === 'queued' && !row.views.some(view => view.visible)) {
                pending.delete(key);
                render(row, '滚动查看时探测最高画质', 'waiting');
            }
        }
    }, {rootMargin: '0px'});
    function wait(ms: number) {
        return new Promise<void>(resolve => {
            finishWait = resolve;
            timer = setTimeout(() => {timer = undefined; finishWait = undefined; resolve();}, ms);
        });
    }
    function render(row: ProbeRow, text: string, state: ProbeRow['state']) {
        row.text = text;
        row.state = state;
        for (const view of row.views) {
            view.text.textContent = text;
            view.retry.classList.toggle('is-hidden', state !== 'failed');
        }
    }
    async function inspect(row: ProbeRow) {
        const deadline = Date.now() + 120_000;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
        let probeId: string | undefined;
        while (!disposed && Date.now() < deadline) {
            if (document.hidden) {await wait(1_000); continue;}
            try {
                if (!probeId) probeId = parseProbeReference(await api.silent('/api/media-probe', {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, signal,
                    body: JSON.stringify({userId: row.item.userId, bvid: row.item.bvid, reuse: true}),
                }));
                if (disposed) return;
                const result = describeQualityProbe(await api.silent('/api/media-probe/' + encodeURIComponent(probeId), {signal}), row.item.bvid);
                if (disposed) return;
                if (result.status === 'complete') {render(row, result.text, 'complete'); return;}
                if (result.status === 'failed') throw new Error(result.text);
            } catch (error) {
                if (!(error instanceof ApiError && error.code === 'MEDIA_PROBE_BUSY')) throw error;
            }
            await wait(2_000);
        }
        if (!disposed) throw new Error('探测等待超时，请稍后重试');
    }
    async function drain() {
        if (running || disposed) return;
        running = true;
        try {
            while (pending.size && !disposed) {
                if (document.hidden) {await wait(1_000); continue;}
                const next = pending.values().next();
                if (next.done) break;
                const key = next.value;
                pending.delete(key);
                const row = rows.get(key);
                if (!row) continue;
                render(row, '正在探测当前账号的可用画质…', 'running');
                try {await inspect(row);}
                catch (error) {
                    if (!disposed) render(row, '最高画质尚未确认：' + (error instanceof Error ? error.message : String(error)), 'failed');
                }
                if (!disposed && pending.size) await wait(2_000);
            }
        } finally {running = false;}
    }
    function enqueue(key: string) {
        const row = rows.get(key);
        if (!row || disposed || row.state === 'running' || row.state === 'queued' || row.state === 'complete') return;
        render(row, '等待探测当前账号的可用画质…', 'queued');
        pending.add(key);
        void drain();
    }
    return {
        register(item: PreviewItem, container: HTMLElement) {
            const text = document.createElement('span');
            const retry = document.createElement('button');
            retry.type = 'button'; retry.className = 'ghost is-hidden'; retry.textContent = '重新探测';
            const line = document.createElement('div'); line.className = 'rename-path'; line.append(text, retry); container.append(line);
            if (!item.userId || !item.bvid) {text.textContent = '缺少授权账号或视频标识，无法探测最高画质'; return;}
            const key = JSON.stringify([item.userId, item.bvid]);
            let row = rows.get(key);
            if (!row) {
                row = {item: {userId: item.userId, bvid: item.bvid}, views: [], text: '滚动查看时探测最高画质', state: 'waiting'};
                rows.set(key, row);
            }
            row.views.push({text, retry, visible: false}); text.textContent = row.text; retry.classList.toggle('is-hidden', row.state !== 'failed');
            line.dataset.qualityProbeKey = key;
            retry.addEventListener('click', event => {event.preventDefault(); event.stopPropagation(); enqueue(key);}, {signal: controller.signal});
            observer.observe(line);
        },
        stop() {
            if (disposed) return;
            disposed = true; controller.abort(); observer.disconnect();
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined; finishWait?.(); finishWait = undefined; pending.clear(); rows.clear();
        },
    };
}
