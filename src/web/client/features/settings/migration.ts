import { isRecord, type ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { requireElement } from '../../shared/dom.js';
import { parseMigrationEstimate, parseMigrationPreview, parseMigrationResult } from './migration-contract.js';
export function createMigration(dependencies: {
    root: Document;
    api: ApiClient;
    fetch: typeof fetch;
    confirm: ConfirmAction;
    open(modal: HTMLElement, trigger: HTMLElement): void;
    close(modal: HTMLElement): void;
    notify(message: string, kind?: string): void;
    formatBytes(value: number): string;
    formatDateTime(value: string): string;
    restored(): Promise<void>;
}) {
    const { root: document, api } = dependencies;
    const element = (id: string) => requireElement(document, '#' + id, HTMLElement);
    const button = (id: string) => requireElement(document, '#' + id, HTMLButtonElement);
    const input = (id: string) => requireElement(document, '#' + id, HTMLInputElement);
    const modal = element('migrationModal');
    const fileInput = input('migrationFileInput');
    const importButton = button('executeImportBtn');
    const exportButton = button('exportDataBtn');
    const mode = element('migrationModeControl');
    const previewBlock = element('migrationPreviewBlock');
    const choices = ['Config', 'Users', 'State', 'Covers', 'Logs', 'Debug'].map(key => input('mig' + key));
    type RequestKind = 'estimate' | 'preview' | 'export' | 'import';
    const requests = new Map<RequestKind, AbortController>();
    let initialized = false;
    let generation = 0;
    let selected: File | null = null;
    let blocked = true;
    let confirming = false;
    function request(kind: RequestKind) {
        requests.get(kind)?.abort();
        const controller = new AbortController();
        requests.set(kind, controller);
        const token = generation;
        return { signal: controller.signal, current: () => initialized && generation === token && requests.get(kind) === controller && !controller.signal.aborted,
            finish: () => { if (requests.get(kind) === controller)
                requests.delete(kind); } };
    }
    function status(text: string, kind = '') {
        const host = element('migrationStatus');
        host.classList.toggle('is-hidden', !text);
        host.textContent = text;
        host.classList.toggle('success', kind === 'success');
        host.classList.toggle('error', kind === 'error');
    }
    function options() {
        const checked = document.querySelector('input[name="migrationMode"]:checked');
        return { mode: checked instanceof HTMLInputElement ? checked.value : 'lightweight', includeConfig: choices[0].checked, includeUsers: choices[1].checked,
            includeState: choices[2].checked, includeCovers: choices[3].checked, includeLogs: choices[4].checked, includeDebug: choices[5].checked };
    }
    function deactivate() {
        generation++;
        for (const controller of requests.values())
            controller.abort();
        requests.clear();
        selected = null;
        blocked = true;
        confirming = false;
        fileInput.value = '';
        previewBlock.classList.add('is-hidden');
        importButton.disabled = true;
        importButton.textContent = '确认导入并自动备份当前数据';
        exportButton.disabled = false;
        exportButton.textContent = '导出压缩包';
        button('chooseImportBtn').disabled = false;
        fileInput.disabled = false;
    }
    async function estimate() {
        if (!initialized)
            return;
        const operation = request('estimate');
        element('migrationEstimate').textContent = '正在估算迁移大小...';
        try {
            const data = parseMigrationEstimate(await api.silent('/api/migration/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options()), signal: operation.signal }));
            if (!operation.current())
                return;
            const details = data.mode === 'complete' ? '，可续传 ' + data.resumableItems + ' 项（' + dependencies.formatBytes(data.retainedBytes) + '），待补传 ' + data.pendingUploadItems + ' 项' : '';
            element('migrationEstimate').textContent = (data.mode === 'complete' ? '完整迁移' : '轻量迁移') + '预计包含 ' + data.files + ' 个文件，原始大小 ' + dependencies.formatBytes(data.expandedBytes) + details + '。';
        }
        catch (error) {
            if (operation.current()) {
                const text = error instanceof Error ? error.message : String(error);
                element('migrationEstimate').textContent = '暂时无法估算：' + text;
                dependencies.notify(text, 'error');
            }
        }
        finally {
            operation.finish();
        }
    }
    function open() { if (!initialized)
        return; deactivate(); status(''); dependencies.open(modal, button('migrationBtn')); void estimate(); }
    async function preview(file: File | undefined) {
        if (!initialized || !file || requests.has('import'))
            return;
        selected = null;
        blocked = true;
        importButton.disabled = true;
        previewBlock.classList.add('is-hidden');
        status('正在读取导入包...');
        const operation = request('preview');
        try {
            const data = parseMigrationPreview(await api.silent('/api/migration/import-preview', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file, signal: operation.signal }));
            if (!operation.current())
                return;
            selected = file;
            blocked = data.tempItemCount > 0;
            element('migrationPreviewText').textContent = '版本 ' + (data.version || '-') + '，导出时间 ' + (dependencies.formatDateTime(data.exportedAt) || '-') +
                '；账号 ' + data.users + '，视频 ' + data.videos + '，关系 ' + data.relations + '，已失效视频 ' + data.unavailableVideos +
                '；模式 ' + (data.mode === 'complete' ? '完整迁移（包含temp与断点）' : '轻量迁移') +
                (blocked ? '；目标temp当前有 ' + data.tempItemCount + ' 项占用，需先处理后才能导入' : '') + '。导入前会自动备份当前 data。';
            previewBlock.classList.remove('is-hidden');
            importButton.disabled = blocked;
            status(blocked ? '预览发现temp冲突，当前不会执行导入。' : '预览完成，确认后才会写入本地数据。', blocked ? 'error' : 'success');
        }
        catch (error) {
            if (operation.current()) {
                const text = error instanceof Error ? error.message : String(error);
                status(text, 'error');
                dependencies.notify(text, 'error');
            }
        }
        finally {
            operation.finish();
        }
    }
    async function exportData() {
        if (!initialized || requests.has('export'))
            return;
        const operation = request('export');
        exportButton.disabled = true;
        exportButton.textContent = '导出中...';
        status('正在生成压缩包...');
        try {
            const response = await dependencies.fetch('/api/migration/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options()), signal: operation.signal });
            if (!response.ok) {
                let text = '导出失败';
                try {
                    const body: unknown = await response.json();
                    if (isRecord(body) && typeof body.message === 'string')
                        text = body.message;
                }
                catch (parseError) { console.debug('[Migration] failed to parse structured error details', parseError); }
                throw new Error(text);
            }
            const blob = await response.blob();
            if (!operation.current())
                return;
            const match = (response.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/i);
            let filename = 'bili-favorites-backup-export.zip';
            if (match) {
                try {
                    filename = decodeURIComponent(match[1]);
                }
                catch (decodeError) { console.debug('[Migration] download filename header was not URI encoded', decodeError); }
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            try {
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
            }
            finally {
                link.remove();
                URL.revokeObjectURL(url);
            }
            status('导出完成。包含账号登录信息的压缩包请妥善保管。', 'success');
        }
        catch (error) {
            if (operation.current()) {
                const text = error instanceof Error ? error.message : String(error);
                status(text, 'error');
                dependencies.notify(text, 'error');
            }
        }
        finally {
            if (operation.current()) {
                exportButton.disabled = false;
                exportButton.textContent = '导出压缩包';
            }
            operation.finish();
        }
    }
    async function importData() {
        if (!initialized || confirming || requests.has('import'))
            return;
        if (!selected) {
            dependencies.notify('先选择导入包并完成预览', 'error');
            return;
        }
        if (blocked) {
            dependencies.notify('完整迁移目标temp非空，请先处理冲突后重新预览', 'error');
            return;
        }
        const file = selected;
        const token = generation;
        confirming = true;
        const accepted = await dependencies.confirm({ title: '确认导入数据', message: '导入会替换你勾选的数据，并在导入前自动备份当前 data。',
            detail: '包含账号登录信息时会恢复 Cookie / token；导入期间不能有同步、下载、上传或对账任务运行。', requiredText: 'IMPORT DATA', trigger: importButton });
        if (generation !== token)
            return;
        confirming = false;
        if (!accepted || !initialized || selected !== file || blocked)
            return;
        const operation = request('import');
        importButton.disabled = true;
        importButton.textContent = '导入中...';
        button('chooseImportBtn').disabled = true;
        fileInput.disabled = true;
        status('正在导入并备份当前数据...');
        const selectedOptions = options();
        const params = new URLSearchParams();
        for (const key of ['Config', 'Users', 'State', 'Covers', 'Logs', 'Debug'] as const)
            params.set('restore' + key, selectedOptions[`include${key}`] ? 'true' : 'false');
        try {
            const data = parseMigrationResult(await api.silent('/api/migration/import?' + params.toString(), { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file, signal: operation.signal }));
            if (!operation.current())
                return;
            status('导入完成。已恢复：' + data.restored.join('、') + '；导入前备份：' + (data.backupPath || '-'), 'success');
            await dependencies.restored();
        }
        catch (error) {
            if (operation.current())
                status(error instanceof Error ? error.message : String(error), 'error');
        }
        finally {
            if (operation.current()) {
                importButton.disabled = blocked || !selected;
                importButton.textContent = '确认导入并自动备份当前数据';
                button('chooseImportBtn').disabled = false;
                fileInput.disabled = false;
            }
            operation.finish();
        }
    }
    const bindings: Array<[
        HTMLElement,
        string,
        EventListener
    ]> = [
        [button('migrationBtn'), 'click', open], [button('closeMigrationBtn'), 'click', () => dependencies.close(modal)],
        [mode, 'change', () => { void estimate(); }], ...choices.map(choice => [choice, 'change', () => { void estimate(); }] as [
            HTMLElement,
            string,
            EventListener
        ]),
        [exportButton, 'click', () => { void exportData(); }], [button('chooseImportBtn'), 'click', () => fileInput.click()],
        [fileInput, 'change', () => { void preview(fileInput.files?.[0]); }], [importButton, 'click', () => { void importData(); }],
    ];
    return { deactivate, init() { if (initialized)
            return; initialized = true; for (const [node, event, listener] of bindings)
            node.addEventListener(event, listener); },
        destroy() { if (!initialized)
            return; initialized = false; deactivate(); for (const [node, event, listener] of bindings)
            node.removeEventListener(event, listener); } };
}
