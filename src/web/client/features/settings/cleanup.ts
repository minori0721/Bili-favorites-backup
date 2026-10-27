import { ApiError, type ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseCleanupState, parseCleanupResults } from './cleanup-contract.js';
import { cleanupItemRequiresIdle } from '../../../../shared/storage-cleanup.js';
export function createCleanup(dependencies: {
    root: Document;
    api: ApiClient;
    formatBytes(value: number): string;
    open(modal: HTMLElement, trigger: HTMLElement): void;
    close(modal: HTMLElement): void;
    notify(message: string, kind?: string): void;
}) {
    const { root: document, api, formatBytes, notify: showToast } = dependencies;
    const element = (id: string) => requireElement(document, '#' + id, HTMLElement);
    const submitButton = requireElement(document, '#executeCleanupBtn', HTMLButtonElement);
    const confirmationInput = requireElement(document, '#cleanupConfirmInput', HTMLInputElement);
    const setHidden = (value: string | HTMLElement, hidden: boolean) => { const node = typeof value === 'string' ? element(value) : value; node.classList.toggle('is-hidden', hidden); };
    let cleanupState: ReturnType<typeof parseCleanupState> = { items: [], runningTransfers: false, activeScheduler: false };
    let initialized = false;
    let loaded = false;
    let generation = 0;
    let read: AbortController | null = null;
    let action: AbortController | null = null;
    function deactivate() { generation++; read?.abort(); action?.abort(); read = null; action = null; loaded = false; cleanupState = { items: [], runningTransfers: false, activeScheduler: false }; element('cleanupList').replaceChildren(); element('cleanupHelpContent').replaceChildren(); confirmationInput.value = ''; submitButton.disabled = true; submitButton.textContent = '确认清理'; }
    const cleanupDescriptions: Record<string, string> = {
        'memory-cache': '清除页面缓存的收藏夹分页，刷新后会重新获取。',
        temp: '清掉全部临时下载目录，包括可续传会话和已验证旧成品，需要输入 DELETE。',
        'orphan-fragments': '清掉会话中已确认无效的 _invalid/_incompatible 内容，以及没有会话清单、无法确认来源的 aria2/tmp/vclip/aclip 等残片；不会删除已验证成品或可续传轨道。此项已包含在“全部临时下载文件”中。',
        logs: '清除网页任务日志，不影响备份。',
        'debug-logs': '清掉 BBDown 调试日志。排查线索会少一点，但备份状态不受影响。',
        covers: '清掉永久归档封面。视频下架后可能只能显示占位封面；不会自动清理，必须输入 DELETE ARCHIVE COVERS。',
        'online-covers': '清掉可重新下载的在线缩略图，不影响归档封面、视频和归档状态。',
        exports: '清掉已经生成过的数据迁移导出压缩包。不影响当前项目运行。',
        backups: '永久删除导入前的回滚副本；清理后不能再用这些备份恢复旧数据。',
        state: '清空归档索引、共享引用、订阅与排除规则、远端核验和恢复记录。远端视频仍保留，但重新扫描不能完整还原这些记录。',
        users: '清掉 B 站账号登录信息。下次需要重新扫码登录。',
        config: '清掉全局配置。远端存储地址、画质、并发等会回到默认值。',
    };
    function cleanupRequiredConfirmation(selected: string[]) {
        const all = cleanupState.items.length > 0 && cleanupState.items.every((item) => selected.includes(item.key));
        if (all)
            return 'DELETE ALL PROJECT DATA';
        if (selected.length === 1 && selected[0] === 'covers')
            return 'DELETE ARCHIVE COVERS';
        if (cleanupState.items.some((item) => selected.includes(item.key) && item.important))
            return 'DELETE';
        return '';
    }
    function selectedCleanupItems() {
        return Array.from(document.querySelectorAll<HTMLInputElement>('.cleanup-check:checked')).map((item) => item.value);
    }
    function cleanupBusy() {
        return Boolean(cleanupState.runningTransfers || cleanupState.activeScheduler);
    }
    function renderCleanupConfirm() {
        const selected = selectedCleanupItems();
        const required = cleanupRequiredConfirmation(selected);
        const block = element('cleanupConfirmBlock');
        const hint = element('cleanupConfirmHint');
        if (!required) {
            setHidden(block, true);
            hint.textContent = '';
            confirmationInput.value = '';
            return;
        }
        setHidden(block, false);
        hint.textContent = required === 'DELETE ALL PROJECT DATA'
            ? '将清空本项目的全部本地数据，包括归档索引、账号、配置和回滚备份；不会删除远端网盘视频。请输入 DELETE ALL PROJECT DATA 确认。'
            : required === 'DELETE ARCHIVE COVERS'
                ? '你选择了永久归档封面。请输入 DELETE ARCHIVE COVERS，确认允许重新回填封面。'
                : '所选项目包含不可重新生成的数据。请输入 DELETE 确认。';
        if (selected.includes('state')) hint.textContent += ' 归档索引清空后会失去共享引用与恢复记录；需要保留时，请先在“数据迁移”中导出备份。';
        if (selected.includes('backups')) hint.textContent += ' 选中的回滚备份也会永久删除。';
        if (selected.includes('temp') && selected.includes('orphan-fragments')) {
            hint.textContent += ' 无法续传的残片已包含在全部临时下载文件中，不会重复清理。';
        }
    }
    function renderCleanupList() {
        const list = element('cleanupList');
        const st = element('cleanupStatus');
        list.innerHTML = '';
        if (cleanupState.runningTransfers || cleanupState.activeScheduler) {
            st.textContent = '当前有同步/扫描/对账或下载/上传任务在跑，临时文件和重要数据先保护起来，不让清理。';
        }
        else {
            st.textContent = '选择要清理的内容。重要项目会要求二次确认。';
        }
        for (const important of [false,true]) {
          const items = cleanupState.items.filter(item => item.important === important);
          if(!items.length) continue;
          const heading=document.createElement('h3');
          heading.className='cleanup-group-heading';
          heading.textContent=important ? '归档、恢复与本地数据（高风险）' : '日常清理';
          list.appendChild(heading);
          items.forEach((item) => {
            const disabled = cleanupBusy() && cleanupItemRequiresIdle(item.key);
            const label = document.createElement('label');
            label.className = 'cleanup-item' + (item.important ? ' important' : '') + (disabled ? ' disabled' : '');
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.value = item.key;
            check.className = 'cleanup-check';
            check.disabled = disabled;
            check.addEventListener('change', renderCleanupConfirm);
            const body = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'cleanup-item-title';
            title.textContent = item.label + (item.important ? '（重要）' : '');
            const desc = document.createElement('div');
            desc.className = 'cleanup-item-desc';
            desc.textContent = (cleanupDescriptions[item.key] || '') + (disabled ? ' 当前有任务运行，此项暂时不能清理。' : '');
            body.appendChild(title);
            body.appendChild(desc);
            const size = document.createElement('div');
            size.className = 'cleanup-size';
            size.textContent = formatBytes(item.bytes);
            label.appendChild(check);
            label.appendChild(body);
            label.appendChild(size);
            list.appendChild(label);
          });
        }
        renderCleanupConfirm();
    }
    function renderCleanupHelp() {
        const content = element('cleanupHelpContent');
        content.innerHTML = '';
        cleanupState.items.forEach((item) => {
            const div = document.createElement('div');
            div.className = 'cleanup-help-item';
            const title = document.createElement('strong');
            title.textContent = item.label + (item.important ? '：重要项目' : '：普通项目');
            const text = document.createElement('div');
            text.textContent = cleanupDescriptions[item.key] || '';
            div.appendChild(title);
            div.appendChild(text);
            content.appendChild(div);
        });
    }
    async function loadCleanupState() {
        if (!initialized)
            return;
        read?.abort();
        const request = new AbortController();
        read = request;
        const token = generation;
        if (!loaded)
            submitButton.disabled = true;
        try {
            const value = parseCleanupState(await api.silent('/api/storage/cleanup', { signal: request.signal }));
            if (generation !== token || read !== request)
                return;
            cleanupState = value;
            loaded = true;
            renderCleanupList();
            renderCleanupHelp();
        }
        catch (error) {
            if (generation !== token || request.signal.aborted)
                return;
            const message = error instanceof Error ? error.message : String(error);
            element('cleanupStatus').textContent = '清理状态读取失败：' + message;
            showToast(message, 'error');
        }
        finally {
            if (read === request) {
                read = null;
                submitButton.disabled = !loaded || Boolean(action);
            }
        }
    }
    async function openCleanupData() { if (!initialized)
        return; deactivate(); dependencies.open(element('cleanupDataModal'), element('cleanupDataBtn')); setHidden('cleanupResultBlock', true); await loadCleanupState(); }
    function setCleanupSelection(value: boolean) {
        document.querySelectorAll<HTMLInputElement>('.cleanup-check').forEach((item) => {
            if (!item.disabled)
                item.checked = value;
        });
        renderCleanupConfirm();
    }
    async function executeCleanup() {
        if (!initialized || action || !loaded)
            return;
        const selected = selectedCleanupItems();
        const resultBlock = element('cleanupResultBlock');
        if (!selected.length) {
            showToast('请先选择要清理的项目。', 'info');
            return;
        }
        const required = cleanupRequiredConfirmation(selected);
        const confirmation = confirmationInput.value.trim();
        if (required && confirmation !== required) {
            showToast('确认文字不正确，暂未清理。', 'error');
            return;
        }
        const btn = submitButton;
        const request = new AbortController();
        action = request;
        const token = generation;
        const current = () => initialized && token === generation && action === request && !request.signal.aborted;
        btn.disabled = true;
        btn.textContent = '清理中...';
        setHidden(resultBlock, false);
        resultBlock.textContent = '正在清理，请稍等...';
        try {
            const data = await api.silent('/api/storage/cleanup', {
                signal: request.signal,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: selected, confirmation })
            });
            if (!current())
                return;
            const lines = ['清理完成：'];
            parseCleanupResults(data).forEach((item) => lines.push(item.skipped
                ? '已包含：' + item.label + (item.note ? '（' + item.note + '）' : '')
                : '已清理：' + item.label));
            resultBlock.textContent = lines.join('\n');
            showToast('清理完成。', 'success');
            await loadCleanupState();
        }
        catch (e) {
            if (!current())
                return;
            showToast(e instanceof Error ? e.message : String(e), 'error');
            const lines = ['清理失败：' + (e instanceof Error ? e.message : String(e))];
            let results: ReturnType<typeof parseCleanupResults> = [];
            if (e instanceof ApiError) {
                try {
                    results = parseCleanupResults(e.details);
                }
                catch (parseError) { console.debug('[Cleanup] failed to parse structured error details', parseError); }
            }
            results.forEach((item) => lines.push(item.ok
                ? (item.skipped ? '已包含：' : '已清理：') + item.label
                : '失败：' + item.label + (item.error ? ' - ' + item.error : '')));
            resultBlock.textContent = lines.join('\n');
        }
        finally {
            if (action !== request)
                return;
            action = null;
            btn.disabled = !loaded;
            btn.textContent = '确认清理';
        }
    }
    const bindings: Array<[
        HTMLElement,
        string,
        EventListener
    ]> = [
        [element('cleanupDataBtn'), 'click', () => { void openCleanupData(); }], [element('closeCleanupDataBtn'), 'click', () => dependencies.close(element('cleanupDataModal'))],
        [element('cleanupHelpBtn'), 'click', () => dependencies.open(element('cleanupHelpModal'), element('cleanupHelpBtn'))], [element('closeCleanupHelpBtn'), 'click', () => dependencies.close(element('cleanupHelpModal'))],
        [element('cleanupSelectAllBtn'), 'click', () => setCleanupSelection(true)], [element('cleanupSelectNoneBtn'), 'click', () => setCleanupSelection(false)],
        [element('refreshCleanupBtn'), 'click', () => { void loadCleanupState(); }], [submitButton, 'click', () => { void executeCleanup(); }]
    ];
    return { deactivate, init() { if (initialized)
            return; initialized = true; for (const [node, event, listener] of bindings)
            node.addEventListener(event, listener); }, destroy() { if (!initialized)
            return; initialized = false; deactivate(); for (const [node, event, listener] of bindings)
            node.removeEventListener(event, listener); } };
}
