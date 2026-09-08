import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { parseRenamePreview, parseRenameUpdate, parseRenameResult, type RenamePreview } from './rename-contract.js';
export function createRename(dependencies: {
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
    const modal = element('renamePreviewModal');
    const trigger = button('renameBtn');
    const executeButton = button('executeRenameBtn');
    const refreshButton = button('refreshRenamePreviewBtn');
    let renamePreviewState: RenamePreview = empty();
    let renameSelection = new Map<string, boolean>();
    let generation = 0;
    let request: AbortController | null = null;
    let action: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let confirming = false;
    let initialized = false;
    function empty(): RenamePreview { return { previewId: '', revision: 0, expiresAt: 0, candidates: [], skipped: [], skippedTotal: 0, remoteScan: null }; }
    const safeText = (value: unknown, fallback: string) => String(value || fallback);
    const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => {
        const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return entities[character];
    });
    const setHidden = (target: HTMLElement, hidden: boolean) => { target.classList.toggle('is-hidden', hidden); };
    const renameCandidateId = (item: RenamePreview['candidates'][number]) => item.candidateId;
    const renamePreviewSkippedTotal = () => renamePreviewState.skippedTotal;
    const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
    function status(message: string, kind = 'muted') { const target = element('renameStatus'); target.textContent = message; target.classList.remove('status-success', 'status-muted', 'status-error'); if (kind)
        target.classList.add('status-' + kind); }
    function resetRequests() {
        generation += 1;
        if (timer !== null)
            clearTimeout(timer);
        timer = null;
        request?.abort();
        request = null;
    }
    function deactivate() {
        resetRequests();
        action?.abort();
        action = null;
        confirming = false;
        renamePreviewState = empty();
        renameSelection.clear();
        executeButton.disabled = true;
        executeButton.textContent = '确认重命名所选文件';
        trigger.textContent = '检查旧命名文件';
        refreshButton.disabled = false;
        element('renamePreviewList').replaceChildren();
    }
    function apply(next: RenamePreview) {
        const changed = next.previewId !== renamePreviewState.previewId;
        renameSelection = new Map(next.candidates.map(item => [item.candidateId, changed ? true : renameSelection.get(item.candidateId) ?? true]));
        renamePreviewState = next;
        executeButton.disabled = !next.candidates.length;
        renderRenamePreview();
    }
    function scanStatus() {
        const scan = renamePreviewState.remoteScan;
        if (scan?.status === 'scanning')
            status('远端深扫进行中，当前先显示本地索引结果。');
        else if (scan?.status === 'failed')
            status('远端深扫失败，当前保留本地索引结果：' + safeText(scan.error, '未知错误'), 'error');
        else if (scan?.status === 'ready')
            status(scan.complete === false ? '远端深扫未完整覆盖，当前保留本地索引结果。' : '远端深扫完成，已更新可处理候选。');
    }
    function schedule(token: number) {
        if (token !== generation || renamePreviewState.remoteScan?.status !== 'scanning')
            return;
        timer = setTimeout(() => { timer = null; void poll(token); }, 1000);
    }
    async function poll(token: number) {
        if (token !== generation || !initialized)
            return;
        const controller = new AbortController();
        request = controller;
        try {
            const result = parseRenameUpdate(await api.silent('/api/rename/preview/status?previewId=' + encodeURIComponent(renamePreviewState.previewId) + '&sinceRevision=' + renamePreviewState.revision + '&detailLimit=50', { signal: controller.signal }));
            if (token !== generation || controller.signal.aborted)
                return;
            if (result.unchanged)
                renamePreviewState.remoteScan = result.remoteScan ?? renamePreviewState.remoteScan;
            else
                apply(result.preview);
            scanStatus();
            schedule(token);
        }
        catch (error) {
            if (token === generation && !controller.signal.aborted)
                status('远端深扫状态读取失败：' + errorMessage(error), 'error');
        }
        finally {
            if (request === controller)
                request = null;
        }
    }
    async function load(refresh = false) {
        if (!initialized || action || confirming)
            return;
        resetRequests();
        const token = generation;
        renamePreviewState = empty();
        renameSelection.clear();
        executeButton.disabled = true;
        const controller = new AbortController();
        request = controller;
        trigger.textContent = '检查中...';
        status('');
        element('renamePreviewSummary').textContent = '正在读取本地索引...';
        element('renamePreviewList').replaceChildren();
        setHidden(element('renameResultBlock'), true);
        setHidden(element('renameSkippedBlock'), true);
        try {
            const result = parseRenamePreview(await api.silent('/api/rename/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailLimit: 50, refresh }), signal: controller.signal }));
            if (token !== generation || controller.signal.aborted)
                return;
            apply(result);
            status('已生成重命名预览：' + result.candidates.length + ' 个可处理，' + result.skippedTotal + ' 个跳过。');
            scanStatus();
            schedule(token);
        }
        catch (error) {
            if (token !== generation || controller.signal.aborted)
                return;
            element('renamePreviewSummary').textContent = '预览失败：' + errorMessage(error);
            status('预览失败: ' + errorMessage(error), 'error');
            dependencies.notify(errorMessage(error), 'error');
        }
        finally {
            if (request === controller)
                request = null;
            if (token === generation)
                trigger.textContent = '检查旧命名文件';
        }
    }
    function renderRenamePreview() {
        const candidates = Array.isArray(renamePreviewState.candidates) ? renamePreviewState.candidates : [];
        const skipped = Array.isArray(renamePreviewState.skipped) ? renamePreviewState.skipped : [];
        const summary = element('renamePreviewSummary');
        const list = element('renamePreviewList');
        const skippedBlock = element('renameSkippedBlock');
        const skippedList = element('renameSkippedList');
        const skippedTotal = renamePreviewSkippedTotal();
        const scan = renamePreviewState.remoteScan;
        const scanHint = scan?.status === 'scanning'
            ? '远端深扫进行中，完成后会补充遗漏项。'
            : (scan?.status === 'failed'
                ? '远端深扫失败，当前显示本地索引结果。'
                : (scan?.status === 'ready' && scan?.complete === false
                    ? '远端深扫未完整覆盖，当前保留本地索引结果，执行时仍会逐项复核。'
                    : (scan?.status === 'ready' ? '远端深扫已完成。' : '')));
        summary.textContent = '发现 ' + candidates.length + ' 个可安全重命名的远端文件，' + skippedTotal + ' 个文件已跳过。' + (scanHint ? ' ' + scanHint : '');
        list.innerHTML = '';
        if (!candidates.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = '没有找到可安全重命名的旧命名文件。';
            list.appendChild(empty);
        }
        candidates.forEach((item) => {
            const row = document.createElement('label');
            row.className = 'rename-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            const candidateId = renameCandidateId(item);
            checkbox.checked = renameSelection.get(candidateId) !== false;
            checkbox.dataset.renameCandidateId = candidateId;
            checkbox.addEventListener('change', () => {
                renameSelection.set(candidateId, checkbox.checked);
            });
            const body = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'rename-title';
            title.textContent = safeText(item.title || item.bvid, '未知视频') + ' · ' + safeText(item.ownerName, '未知UP');
            const name = document.createElement('div');
            name.className = 'rename-path';
            name.innerHTML = '<strong>旧文件：</strong>' + escapeHtml(item.oldName || '') + '<br><span class="rename-arrow">→</span> <strong>新文件：</strong>' + escapeHtml(item.newName || '');
            const path = document.createElement('div');
            path.className = 'rename-path';
            path.textContent = '目录：' + (item.remoteDir || '');
            const reason = document.createElement('div');
            reason.className = 'rename-path';
            reason.textContent = item.reason || '文件名和本地状态匹配，可重命名。';
            body.appendChild(title);
            body.appendChild(name);
            body.appendChild(path);
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
                div.textContent = safeText(item.path, '<未知路径>') + '：' + safeText(item.reason, '已跳过');
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
        for (const item of renamePreviewState.candidates)
            renameSelection.set(item.candidateId, checked);
        document.querySelectorAll<HTMLInputElement>('#renamePreviewList input[type="checkbox"]').forEach(input => { input.checked = checked; });
    }
    async function execute() {
        if (!initialized || action || confirming || !renamePreviewState.previewId)
            return;
        const ids = renamePreviewState.candidates.filter(item => renameSelection.get(item.candidateId) !== false).map(item => item.candidateId);
        if (!ids.length) {
            dependencies.notify('请先勾选需要重命名的文件', 'info');
            return;
        }
        const previewId = renamePreviewState.previewId;
        // Freeze the reviewed revision while confirmation is open.
        resetRequests();
        const token = generation;
        confirming = true;
        let confirmed = false;
        try {
            confirmed = await dependencies.confirm({ title: '确认远端重命名', message: '将重命名 ' + ids.length + ' 个远端文件。', detail: '此操作会修改 AList / OpenList 网盘文件名。建议确认预览列表无误后再继续。', confirmText: '确认重命名', trigger: executeButton });
        }
        finally {
            if (token === generation)
                confirming = false;
        }
        if (token !== generation || !initialized)
            return;
        if (!confirmed) {
            schedule(token);
            return;
        }
        const controller = new AbortController();
        action = controller;
        executeButton.disabled = true;
        refreshButton.disabled = true;
        executeButton.textContent = '重命名中...';
        const resultBlock = element('renameResultBlock');
        setHidden(resultBlock, false);
        resultBlock.textContent = '正在执行远端重命名...';
        try {
            const result = parseRenameResult(await api.silent('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId, candidateIds: ids }), signal: controller.signal }));
            if (token !== generation || controller.signal.aborted)
                return;
            const labels: Record<string, string> = { renamed: '已完成', rolled_back: '已回滚', stranded: '需人工处理（停在临时路径）', conflict: '需人工处理（多路径冲突）', missing: '需人工处理（文件缺失）' };
            const lines = ['完成：成功 ' + result.success + ' 个，失败 ' + result.failed + ' 个。'];
            for (const item of result.results)
                lines.push((labels[item.status] || (item.ok ? '已完成' : '失败')) + '：' + item.oldPath + ' → ' + item.newPath + (item.actualPath ? '，实际路径：' + item.actualPath : '') + (item.observedPaths.length > 1 ? '，检测到：' + item.observedPaths.join('、') : '') + (item.error ? '，原因：' + item.error : ''));
            resultBlock.textContent = lines.join('\n');
            dependencies.notify('远端重命名完成', result.failed ? 'info' : 'success');
            // An executed preview is no longer a fresh authorization to rename again.
            renamePreviewState = empty();
            renameSelection.clear();
        }
        catch (error) {
            if (token === generation && !controller.signal.aborted) {
                resultBlock.textContent = '重命名失败：' + errorMessage(error);
                dependencies.notify(errorMessage(error), 'error');
            }
        }
        finally {
            if (action === controller)
                action = null;
            if (token === generation) {
                executeButton.textContent = '确认重命名所选文件';
                executeButton.disabled = true;
                refreshButton.disabled = false;
            }
        }
    }
    const bindings: [
        HTMLElement,
        () => void
    ][] = [
        [trigger, () => { dependencies.open(modal, trigger); void load(); }],
        [button('closeRenamePreviewBtn'), () => dependencies.close(modal)],
        [button('renameSelectAllBtn'), () => select(true)], [button('renameSelectNoneBtn'), () => select(false)],
        [refreshButton, () => { void load(true); }], [executeButton, () => { void execute(); }],
    ];
    return { deactivate, init() { if (initialized)
            return; initialized = true; executeButton.disabled = true; bindings.forEach(([target, handler]) => target.addEventListener('click', handler)); },
        destroy() { if (!initialized)
            return; initialized = false; bindings.forEach(([target, handler]) => target.removeEventListener('click', handler)); deactivate(); } };
}
