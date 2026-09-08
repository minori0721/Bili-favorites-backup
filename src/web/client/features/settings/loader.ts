import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseSettings } from './contract.js';
import { normalizeClientEncodingPriority } from './encoding.js';
export function createSettingsLoader(dependencies: {
    root: ParentNode;
    api: ApiClient;
    status(message: string, kind?: string, retry?: () => void): void;
    playback(value: {
        deliveryMode: 'auto' | 'proxy';
        alistBrowserConfigured: boolean;
    }): void;
    encoding(value: string[]): void;
    apiMode(value: string): void;
    templateChanged(): void;
}) {
    const saveButton = requireElement(dependencies.root, '#saveConfigBtn', HTMLButtonElement);
    const input = (id: string) => requireElement(dependencies.root, '#' + id, HTMLInputElement);
    function field(id: string): HTMLInputElement | HTMLSelectElement {
        const element = dependencies.root.querySelector('#' + id);
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement))
            throw new Error('Missing settings field: ' + id);
        return element;
    }
    const configLoadState: {
        token: number;
        controller: AbortController | null;
        loaded: boolean;
    } = { token: 0, controller: null, loaded: false };
    let disposed = true;
    async function loadConfig() {
        if (disposed)
            return;
        if (configLoadState.controller)
            configLoadState.controller.abort();
        const controller = new AbortController();
        const token = ++configLoadState.token;
        configLoadState.controller = controller;
        if (!configLoadState.loaded) {
            saveButton.disabled = true;
            dependencies.status('正在读取设置...', 'muted');
        }
        try {
            const d = parseSettings(await dependencies.api.silent('/api/config', { signal: controller.signal }));
            if (token !== configLoadState.token)
                return;
            field('pollInterval').value = String(d.pollIntervalMinutes ?? '');
            field('delaySeconds').value = String(d.perVideoDelaySeconds ?? '');
            field('uploadLayout').value = String(d.uploadLayout ?? '');
            field('alistUrl').value = String(d.alistUrl || '');
            field('alistBrowserUrl').value = String(d.alistBrowserUrl || '');
            field('alistUsername').value = String(d.alistUsername || '');
            field('alistPassword').value = String(d.alistPassword || '');
            field('alistDest').value = String(d.alistDest || '');
            field('playbackDeliveryMode').value = String(d.playbackDeliveryMode === 'proxy' ? 'proxy' : 'auto');
            dependencies.playback({ deliveryMode: d.playbackDeliveryMode === 'proxy' ? 'proxy' : 'auto', alistBrowserConfigured: Boolean(d.alistBrowserUrl.trim()) });
            const browserUrlHint = dependencies.root.querySelector('#alistBrowserUrlHint');
            if (browserUrlHint) {
                const insecure = String(d.alistBrowserUrl || '').trim().toLowerCase().startsWith('http://');
                browserUrlHint.textContent = insecure
                    ? '当前使用 HTTP，登录信息和访问路径可能被同网络中的设备看到，建议改为 HTTPS。'
                    : '用于播放器中的“在网盘中查看”入口；留空则不显示。';
                browserUrlHint.classList.toggle('status-error', insecure);
            }
            dependencies.encoding(normalizeClientEncodingPriority(d.bbdownEncodingPriority, d.bbdownEncoding));
            field('bbdownEncoding').value = String(d.bbdownEncoding || '');
            input('bbdownEncodingStrict').checked = Boolean(d.bbdownEncoding);
            field('bbdownQuality').value = String(d.bbdownQuality || '');
            dependencies.apiMode(d.bbdownApiMode || 'web');
            input('bbdownHiRes').checked = !!d.bbdownHiRes;
            input('bbdownDolby').checked = !!d.bbdownDolby;
            field('maxRetries').value = String(d.maxRetries ?? 3);
            field('retryDelaySeconds').value = String(d.retryDelaySeconds ?? 5);
            field('concurrentDownloads').value = String(d.concurrentDownloads ?? 1);
            field('concurrentUploads').value = String(d.concurrentUploads ?? 2);
            field('uploadFileIntervalSeconds').value = String(d.uploadFileIntervalSeconds ?? 10);
            field('localCacheLimitGB').value = String(d.localCacheLimitGB ?? 10);
            field('onlineCoverCacheLimitMB').value = String(d.onlineCoverCacheLimitMB ?? 256);
            field('queuePrefetchLimit').value = String(d.queuePrefetchLimit ?? 25);
            field('remoteVerifyConcurrency').value = String(d.remoteVerifyConcurrency ?? 3);
            field('remoteVerifyRateLimitPerSecond').value = String(d.remoteVerifyRateLimitPerSecond ?? 2);
            field('remoteRequeueLimitPerCycle').value = String(d.remoteRequeueLimitPerCycle ?? 20);
            field('filenameTemplate').value = String(d.filenameTemplate || '<videoTitle>-<bvid>');
            field('renameScanMaxFiles').value = String(d.renameScanMaxFiles ?? 10000);
            dependencies.templateChanged();
            configLoadState.loaded = true;
            dependencies.status('');
        }
        catch (error) {
            if ((error instanceof Error && error.name === 'AbortError') || token !== configLoadState.token)
                return;
            const prefix = configLoadState.loaded ? '设置刷新失败，已保留当前内容：' : '设置加载失败：';
            dependencies.status(prefix + (error instanceof Error ? error.message : String(error)), 'error', () => void loadConfig());
        }
        finally {
            if (token === configLoadState.token) {
                if (configLoadState.controller === controller)
                    configLoadState.controller = null;
                saveButton.disabled = !configLoadState.loaded;
            }
        }
    }
    return { load: loadConfig, init() { disposed = false; }, destroy() { disposed = true; configLoadState.token++; configLoadState.controller?.abort(); configLoadState.controller = null; } };
}
