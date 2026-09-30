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
    const section = requireElement(root, '#settingsSection', HTMLElement);
    const draftStatus = requireElement(root, '#settingsDraftStatus', HTMLElement);
    const input = (id: string) => requireElement(root, '#' + id, HTMLInputElement);
    function field(id: string): HTMLInputElement | HTMLSelectElement {
        const element = root.querySelector('#' + id);
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement))
            throw new Error('Missing settings field: ' + id);
        return element;
    }
    let initialized = false;
    let controller: AbortController | null = null;
    let loading = false;
    let savedSnapshot: string | null = null;
    function readPayload() {
        return {
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
    }
    function refreshDraft() {
        if (!initialized) return;
        const dirty = savedSnapshot !== null && JSON.stringify(readPayload()) !== savedSnapshot;
        const state = controller ? 'saving' : loading ? 'loading' : savedSnapshot === null ? 'unavailable' : dirty ? 'dirty' : 'saved';
        draftStatus.dataset.state = state;
        draftStatus.textContent = state === 'saving' ? '保存中…' : state === 'loading' ? '正在读取…' : state === 'unavailable' ? '设置尚未读取' : dirty ? '有未保存修改' : '已保存';
        btn.disabled = loading || controller !== null || savedSnapshot === null;
    }
    function setLoading(value: boolean) {
        loading = value;
        if (!initialized) return;
        section.querySelectorAll<HTMLElement>('.settings-fold').forEach(fold => { fold.inert = value || savedSnapshot === null; });
        refreshDraft();
    }
    function loaded() {
        savedSnapshot = JSON.stringify(readPayload());
        refreshDraft();
    }
    function changed() {
        if (st.classList.contains('status-success')) dependencies.status('');
        refreshDraft();
    }
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
        btn.style.minWidth = btn.getBoundingClientRect().width + 'px';
        btn.textContent = '保存中...';
        btn.setAttribute('aria-busy', 'true');
        refreshDraft();
        st.textContent = '';
        const payload = readPayload();
        try {
            await dependencies.api.silent('/api/config', { signal: request.signal, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!current())
                return;
            dependencies.playback({ deliveryMode: payload.playbackDeliveryMode === 'proxy' ? 'proxy' : 'auto', alistBrowserConfigured: Boolean(payload.alistBrowserUrl) });
            savedSnapshot = JSON.stringify(payload);
            dependencies.status(JSON.stringify(readPayload()) === savedSnapshot ? '设置已保存。' : '本次设置已保存；还有新的修改未保存。', 'success');
        }
        catch (e) {
            if (!current())
                return;
            const message = e instanceof Error ? e.message : String(e);
            dependencies.notify(message);
            dependencies.status('保存失败: ' + message, 'error');
            if (e instanceof ApiError && e.code === 'PATH_MIGRATION_REQUIRED') {
                requireElement(root, '#storageSettings', HTMLDetailsElement).open = true;
                await dependencies.migrationRequired(payload.alistDest, request.signal);
            }
        }
        finally {
            if (controller === request) {
                controller = null;
                btn.textContent = '保存设置并生效';
                btn.removeAttribute('aria-busy');
                btn.style.removeProperty('min-width');
                refreshDraft();
            }
        }
    }
    const onClick = () => { void saveConfig(); };
    return { setLoading, loaded, changed, init() { if (initialized)
            return; initialized = true; btn.addEventListener('click', onClick); section.addEventListener('input', changed); section.addEventListener('change', changed); refreshDraft(); },
        destroy() {
            if (!initialized)
                return;
            initialized = false;
            btn.removeEventListener('click', onClick);
            section.removeEventListener('input', changed);
            section.removeEventListener('change', changed);
            if (controller) {
                controller.abort();
                controller = null;
                btn.disabled = false;
                btn.textContent = '保存设置并生效';
            }
            btn.removeAttribute('aria-busy');
            btn.style.removeProperty('min-width');
            section.querySelectorAll<HTMLElement>('.settings-fold').forEach(fold => { fold.inert = false; });
        } };
}
