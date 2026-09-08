import type { ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { requireElement } from '../../shared/dom.js';
import { parseQualityPreview, parseQualityResult, parseQualityState, type QualityPreview } from './quality-contract.js';
export function createQualityUpgrade(dependencies: {
    root: Document;
    api: ApiClient;
    confirm: ConfirmAction;
    open(modal: HTMLElement, trigger: HTMLElement): void;
    close(modal: HTMLElement): void;
    notify(message: string, kind?: string): void;
}) {
    const { root: document, api } = dependencies;
    const element = (id: string) => requireElement(document, '#' + id, HTMLElement);
    const button = (id: string) => requireElement(document, '#' + id, HTMLButtonElement);
    const modal = element('qualityUpgradeModal');
    const trigger = button('qualityUpgradeBtn');
    const submit = button('executeQualityUpgradeBtn');
    const refresh = button('refreshQualityUpgradeBtn');
    let qualityUpgradePreviewState: QualityPreview = empty();
    let initialized = false;
    let generation = 0;
    let confirming = false;
    let read: AbortController | null = null;
    let action: AbortController | null = null;
    let stateRead: AbortController | null = null;
    function empty(): QualityPreview { return { candidates: [], uncertain: [], skipped: [], skippedTotal: 0, target: { quality: '', encoding: '', hiRes: false, dolby: false } }; }
    const safeText = (value: unknown, fallback: string) => String(value || fallback);
    const setHidden = (target: HTMLElement, hidden: boolean) => target.classList.toggle('is-hidden', hidden);
    const message = (error: unknown) => error instanceof Error ? error.message : String(error);
    function status(text: string, kind = 'muted') {
        const target = element('qualityUpgradeStatus');
        target.textContent = text;
        target.classList.remove('status-success', 'status-error', 'status-muted');
        if (kind)
            target.classList.add('status-' + kind);
    }
    function deactivate() {
        generation++;
        read?.abort();
        action?.abort();
        stateRead?.abort();
        read = null;
        action = null;
        stateRead = null;
        confirming = false;
        qualityUpgradePreviewState = empty();
        element('qualityUpgradeList').replaceChildren();
        submit.disabled = true;
        submit.textContent = '确认重调所选视频';
        refresh.disabled = false;
        trigger.textContent = '检查可升级画质';
    }
    async function load() {
        if (!initialized || action || confirming)
            return;
        generation++;
        const token = generation;
        read?.abort();
        stateRead?.abort();
        stateRead = null;
        const controller = new AbortController();
        read = controller;
        qualityUpgradePreviewState = empty();
        submit.disabled = true;
        trigger.textContent = '检查中...';
        status('');
        element('qualityUpgradeSummary').textContent = '正在读取本地远端记录...';
        element('qualityUpgradeList').replaceChildren();
        setHidden(element('qualityUpgradeResultBlock'), true);
        setHidden(element('qualityUpgradeSkippedBlock'), true);
        try {
            const data = parseQualityPreview(await api.silent('/api/quality-upgrade/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailLimit: 50 }), signal: controller.signal }));
            if (token !== generation || controller.signal.aborted)
                return;
            qualityUpgradePreviewState = data;
            renderQualityUpgradePreview();
            submit.disabled = !(data.candidates.length + data.uncertain.length);
            status('已生成画质重调预览：' + data.candidates.length + ' 个可处理，' + data.uncertain.length + ' 个需人工确认，' + data.skippedTotal + ' 个跳过。');
        }
        catch (error) {
            if (token === generation && !controller.signal.aborted) {
                element('qualityUpgradeSummary').textContent = '预览失败：' + message(error);
                status('预览失败: ' + message(error), 'error');
                dependencies.notify(message(error), 'error');
            }
        }
        finally {
            if (read === controller)
                read = null;
            if (token === generation)
                trigger.textContent = '检查可升级画质';
        }
    }
    function renderQualityUpgradePreview() {
        const candidates = Array.isArray(qualityUpgradePreviewState.candidates) ? qualityUpgradePreviewState.candidates : [];
        const uncertain = Array.isArray(qualityUpgradePreviewState.uncertain) ? qualityUpgradePreviewState.uncertain : [];
        const displayItems = [...candidates, ...uncertain.map((item) => ({ ...item, forceUnknown: true }))];
        const skipped = Array.isArray(qualityUpgradePreviewState.skipped) ? qualityUpgradePreviewState.skipped : [];
        const target = qualityUpgradePreviewState.target;
        const summary = element('qualityUpgradeSummary');
        const list = element('qualityUpgradeList');
        const skippedBlock = element('qualityUpgradeSkippedBlock');
        const skippedList = element('qualityUpgradeSkippedList');
        const targetText = [target.quality ? '清晰度 ' + target.quality : '', target.encoding ? '编码 ' + target.encoding : '', target.hiRes ? 'Hi-Res' : '', target.dolby ? '杜比' : ''].filter(Boolean).join(' / ') || '当前默认画质设置';
        const skippedTotal = Number.isFinite(Number(qualityUpgradePreviewState.skippedTotal)) ? Number(qualityUpgradePreviewState.skippedTotal) : skipped.length;
        summary.textContent = '目标：' + targetText + '。明确需升级 ' + candidates.length + ' 个，无法判断 ' + uncertain.length + ' 个，跳过 ' + skippedTotal + ' 个。';
        list.innerHTML = '';
        if (!displayItems.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = '没有找到可重调画质的已上传视频记录。';
            list.appendChild(empty);
        }
        displayItems.forEach((item, index) => {
            const row = document.createElement('label');
            row.className = 'rename-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = false;
            checkbox.dataset.qualityUpgradeIndex = String(index);
            if (item.forceUnknown)
                checkbox.dataset.qualityUnknown = '1';
            const body = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'rename-title';
            title.textContent = safeText(item.title || item.bvid, '未知视频') + ' · ' + safeText(item.ownerName, '未知UP');
            const folder = document.createElement('div');
            folder.className = 'rename-path';
            folder.textContent = '收藏夹：' + safeText(item.folderTitle, 'favorites') + '；目录：' + safeText(item.remotePath, '-');
            const files = document.createElement('div');
            files.className = 'rename-path';
            files.textContent = '将替换旧文件：' + (item.oldFiles || []).map((file) => file.name || file.path).join('，');
            const reason = document.createElement('div');
            reason.className = 'rename-path';
            reason.textContent = item.forceUnknown ? '无法判断旧文件画质；勾选即表示仍要强制重新下载。' : (item.reason || '按当前画质设置重新下载，上传验证成功后删除旧文件。');
            body.appendChild(title);
            body.appendChild(folder);
            body.appendChild(files);
            body.appendChild(reason);
            row.appendChild(checkbox);
            row.appendChild(body);
            list.appendChild(row);
        });
        if (skipped.length || skippedTotal > 0) {
            setHidden(skippedBlock, false);
            skippedList.innerHTML = '';
            skipped.forEach((item) => {
                const div = document.createElement('div');
                div.textContent = safeText(item.title || item.bvid || item.folderTitle, '<未知项目>') + '：' + safeText(item.reason, '已跳过');
                skippedList.appendChild(div);
            });
            if (skippedTotal > skipped.length) {
                const more = document.createElement('div');
                more.className = 'muted';
                more.textContent = '其余 ' + (skippedTotal - skipped.length) + ' 个跳过项已汇总，未全部展开。';
                skippedList.appendChild(more);
            }
        }
        else {
            setHidden(skippedBlock, true);
            skippedList.innerHTML = '';
        }
    }
    function select(checked: boolean) {
        document.querySelectorAll<HTMLInputElement>('#qualityUpgradeList input[type="checkbox"]').forEach(input => { input.checked = checked && input.dataset.qualityUnknown !== '1'; });
    }
    async function loadState() {
        if (!initialized || stateRead)
            return;
        const token = generation;
        const controller = new AbortController();
        stateRead = controller;
        try {
            const data = parseQualityState(await api.silent('/api/quality-upgrade/state', { signal: controller.signal }));
            if (token !== generation || controller.signal.aborted || (!data.running.length && !data.completed))
                return;
            const cleanup = data.running.filter(item => item.stageLabel === '旧文件清理重试中').length;
            const shared = data.running.filter(item => item.targetCount > 1 && item.stageLabel.includes('下载新版')).length;
            status('画质重调：运行中 ' + data.running.length + ' 个；最近完成/失败 ' + data.completed + ' 个。' + (shared ? ' 共享下载 ' + shared + ' 组。' : '') + (cleanup ? ' 旧文件清理重试中 ' + cleanup + ' 个。' : ''));
        }
        catch (error) {
            if (token === generation && !controller.signal.aborted)
                status('画质重调状态读取失败: ' + message(error), 'error');
        }
        finally {
            if (stateRead === controller)
                stateRead = null;
        }
    }
    async function execute() {
        if (!initialized || confirming || action)
            return;
        const candidates = [...qualityUpgradePreviewState.candidates, ...qualityUpgradePreviewState.uncertain.map(item => ({ ...item, forceUnknown: true }))];
        const selected: QualityPreview['candidates'] = [];
        document.querySelectorAll<HTMLInputElement>('#qualityUpgradeList input[type="checkbox"]').forEach(input => { const index = Number(input.dataset.qualityUpgradeIndex); if (input.checked && Number.isInteger(index) && candidates[index])
            selected.push(candidates[index]); });
        if (!selected.length) {
            dependencies.notify('请先勾选需要重调画质的视频', 'info');
            return;
        }
        const token = generation;
        confirming = true;
        let confirmed = false;
        try {
            confirmed = await dependencies.confirm({ title: '确认画质重调', message: '将为 ' + selected.length + ' 个视频重新下载并上传新版文件。', detail: '新版文件上传并验证成功后，才会删除旧远端文件。运行期间会占用下载和上传队列。', confirmText: '确认重调', trigger: submit });
        }
        finally {
            if (token === generation)
                confirming = false;
        }
        if (token !== generation || !initialized || !confirmed)
            return;
        const controller = new AbortController();
        action = controller;
        submit.disabled = true;
        refresh.disabled = true;
        submit.textContent = '提交中...';
        const resultBlock = element('qualityUpgradeResultBlock');
        setHidden(resultBlock, false);
        const queued: ReturnType<typeof parseQualityResult>['queued'] = [];
        const skipped: ReturnType<typeof parseQualityResult>['skipped'] = [];
        const groups = new Set<string>();
        let reportedGroups = 0;
        function summary() {
            const lines = ['已提交：' + queued.length + ' 个目标，合并为 ' + (groups.size || reportedGroups) + ' 个下载组；跳过：' + skipped.length + ' 个。任务会在后台执行，可在队列中查看进度。'];
            queued.forEach(item => lines.push('已提交：' + item.bvid + ' ' + item.title));
            skipped.forEach(item => lines.push('跳过：' + (item.key || '<未知>') + '，原因：' + (item.reason || '未知')));
            return lines.join('\n');
        }
        try {
            for (let start = 0; start < selected.length; start += 50) {
                if (token !== generation || controller.signal.aborted)
                    return;
                resultBlock.textContent = '正在提交画质重调任务：第 ' + (Math.floor(start / 50) + 1) + '/' + Math.ceil(selected.length / 50) + ' 批（已处理 ' + start + '/' + selected.length + '）...';
                const items = selected.slice(start, start + 50).map(item => ({ key: item.key, forceUnknown: item.forceUnknown }));
                const data = parseQualityResult(await api.silent('/api/quality-upgrade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }), signal: controller.signal }));
                if (token !== generation || controller.signal.aborted)
                    return;
                queued.push(...data.queued);
                skipped.push(...data.skipped);
                reportedGroups += data.downloadGroups;
                data.queued.forEach(item => { if (item.artifactKey)
                    groups.add(item.artifactKey); });
            }
            resultBlock.textContent = summary();
            dependencies.notify('画质重调任务已提交', 'success');
            await loadState();
        }
        catch (error) {
            if (token === generation && !controller.signal.aborted) {
                resultBlock.textContent = (queued.length || skipped.length ? summary() + '\n' : '') + '提交失败：' + message(error) + '。后续批次已停止，请刷新预览后核对队列。';
                dependencies.notify(message(error), 'error');
            }
        }
        finally {
            if (action === controller)
                action = null;
            if (token === generation) {
                submit.textContent = '确认重调所选视频';
                submit.disabled = true;
                refresh.disabled = false;
                qualityUpgradePreviewState = empty();
            }
        }
    }
    const bindings: [
        HTMLElement,
        () => void
    ][] = [
        [trigger, () => { dependencies.open(modal, trigger); void load(); }], [button('closeQualityUpgradeBtn'), () => dependencies.close(modal)],
        [button('qualityUpgradeSelectAllBtn'), () => select(true)], [button('qualityUpgradeSelectNoneBtn'), () => select(false)],
        [refresh, () => { void load(); }], [submit, () => { void execute(); }],
    ];
    return { deactivate, loadState, init() { if (initialized)
            return; initialized = true; submit.disabled = true; bindings.forEach(([target, handler]) => target.addEventListener('click', handler)); },
        destroy() { if (!initialized)
            return; initialized = false; bindings.forEach(([target, handler]) => target.removeEventListener('click', handler)); deactivate(); } };
}
