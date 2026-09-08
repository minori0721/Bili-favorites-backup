import { ApiError, type ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
export function createSettingsSaver(dependencies: {
    root: ParentNode;
    api: ApiClient;
    priority(): string[];
    apiMode(): string;
    status(message: string, kind?: string): void;
    notify(message: string): void;
    playback(value: {
        deliveryMode: 'auto' | 'proxy';
        alistBrowserConfigured: boolean;
    }): void;
    migrationRequired(destination: string, signal: AbortSignal): Promise<void>;
}) {
    const { root } = dependencies;
    const btn = requireElement(root, '#saveConfigBtn', HTMLButtonElement);
    const st = requireElement(root, '#configStatus', HTMLElement);
    const input = (id: string) => requireElement(root, '#' + id, HTMLInputElement);
    function field(id: string): HTMLInputElement | HTMLSelectElement {
        const element = root.querySelector('#' + id);
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement))
            throw new Error('Missing settings field: ' + id);
        return element;
    }
    let initialized = false;
    let controller: AbortController | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    async function saveConfig() {
        if (!initialized || controller || btn.disabled)
            return;
        const invalid = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#settingsSection input, #settingsSection select')).find((field) => field.willValidate && !field.validity.valid);
        if (invalid) {
            const fold = invalid.closest('.settings-fold');
            if (fold instanceof HTMLDetailsElement)
                fold.open = true;
            invalid.scrollIntoView({ block: 'center' });
            invalid.reportValidity();
            invalid.focus({ preventScroll: true });
            return;
        }
        const request = new AbortController();
        controller = request;
        const current = () => initialized && controller === request && !request.signal.aborted;
        if (clearTimer !== null)
            clearTimeout(clearTimer);
        clearTimer = null;
        btn.disabled = true;
        btn.textContent = '保存中...';
        st.textContent = '';
        const payload = {
            pollIntervalMinutes: Number(field('pollInterval').value),
            perVideoDelaySeconds: Number(field('delaySeconds').value),
            uploadLayout: field('uploadLayout').value,
            alistUrl: field('alistUrl').value.trim() || 'http://alist:5244',
            alistBrowserUrl: field('alistBrowserUrl').value.trim(),
            alistUsername: field('alistUsername').value.trim(),
            alistPassword: field('alistPassword').value.trim(),
            alistDest: field('alistDest').value.trim(),
            playbackDeliveryMode: field('playbackDeliveryMode').value === 'proxy' ? 'proxy' : 'auto',
            bbdownEncoding: input('bbdownEncodingStrict').checked ? dependencies.priority()[0] : '',
            bbdownEncodingPriority: dependencies.priority().slice(),
            bbdownQuality: field('bbdownQuality').value,
            bbdownApiMode: dependencies.apiMode(),
            bbdownHiRes: input('bbdownHiRes').checked,
            bbdownDolby: input('bbdownDolby').checked,
            filenameTemplate: field('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
            renameScanMaxFiles: Number(field('renameScanMaxFiles').value || 10000),
            maxRetries: Number(field('maxRetries').value),
            retryDelaySeconds: Number(field('retryDelaySeconds').value),
            concurrentDownloads: Number(field('concurrentDownloads').value),
            concurrentUploads: Number(field('concurrentUploads').value),
            uploadFileIntervalSeconds: Number(field('uploadFileIntervalSeconds').value),
            localCacheLimitGB: Number(field('localCacheLimitGB').value),
            onlineCoverCacheLimitMB: Number(field('onlineCoverCacheLimitMB').value),
            queuePrefetchLimit: Number(field('queuePrefetchLimit').value),
            remoteVerifyConcurrency: Number(field('remoteVerifyConcurrency').value),
            remoteVerifyRateLimitPerSecond: Number(field('remoteVerifyRateLimitPerSecond').value),
            remoteRequeueLimitPerCycle: Number(field('remoteRequeueLimitPerCycle').value),
        };
        try {
            await dependencies.api.silent('/api/config', { signal: request.signal, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!current())
                return;
            dependencies.playback({ deliveryMode: payload.playbackDeliveryMode === 'proxy' ? 'proxy' : 'auto', alistBrowserConfigured: Boolean(payload.alistBrowserUrl) });
            dependencies.status('设置已保存。轮询间隔和并发数立即生效；画质、编码、命名模板、重试次数、远端路径等对新任务生效，正在运行的任务不会中途切换。', 'success');
        }
        catch (e) {
            if (!current())
                return;
            const message = e instanceof Error ? e.message : String(e);
            dependencies.notify(message);
            dependencies.status('保存失败: ' + message, 'error');
            root.querySelectorAll('.settings-fold').forEach(group => { if (group instanceof HTMLDetailsElement)
                group.open = true; });
            if (e instanceof ApiError && e.code === 'PATH_MIGRATION_REQUIRED') {
                await dependencies.migrationRequired(payload.alistDest, request.signal);
            }
        }
        finally {
            if (controller === request) {
                controller = null;
                btn.disabled = false;
                btn.textContent = '保存设置并生效';
                clearTimer = setTimeout(() => {
                    clearTimer = null;
                    if (initialized && !st.classList.contains('status-error'))
                        dependencies.status('');
                }, 3000);
            }
        }
    }
    const onClick = () => { void saveConfig(); };
    return { init() { if (initialized)
            return; initialized = true; btn.addEventListener('click', onClick); },
        destroy() {
            if (!initialized)
                return;
            initialized = false;
            btn.removeEventListener('click', onClick);
            if (controller) {
                controller.abort();
                controller = null;
                btn.disabled = false;
                btn.textContent = '保存设置并生效';
            }
            if (clearTimer !== null)
                clearTimeout(clearTimer);
            clearTimer = null;
        } };
}
