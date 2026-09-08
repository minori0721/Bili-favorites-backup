import { isRecord, type ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
export function parseStorageCheck(value: unknown) {
    if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.title !== 'string'
        || typeof value.message !== 'string' || (value.field !== undefined && typeof value.field !== 'string')) {
        throw new Error('存储检查响应格式错误');
    }
    return { ok: value.ok, title: value.title, message: value.message, field: value.field };
}
export function createStorageCheck(dependencies: {
    root: ParentNode;
    api: ApiClient;
    status(element: HTMLElement, message: string, kind?: string): void;
    notify(message: string): void;
}) {
    const { root, api, status, notify } = dependencies;
    const button = requireElement(root, '#storageCheckBtn', HTMLButtonElement);
    const output = requireElement(root, '#storageCheckStatus', HTMLElement);
    const fields = new Map(['alistUrl', 'alistUsername', 'alistPassword', 'alistDest'].map(id => [id, requireElement(root, '#' + id, HTMLInputElement)]));
    const original = button.textContent;
    let initialized = false;
    let controller: AbortController | null = null;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    async function check() {
        if (!initialized || controller)
            return;
        if (focusTimer !== null)
            clearTimeout(focusTimer);
        focusTimer = null;
        const request = new AbortController();
        controller = request;
        const current = () => initialized && controller === request && !request.signal.aborted;
        button.disabled = true;
        button.textContent = '检查中...';
        status(output, '正在执行只读 WebDAV 检查，不会写入远端。');
        try {
            const result = parseStorageCheck(await api.silent('/api/storage/check', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: request.signal,
                body: JSON.stringify(Object.fromEntries([...fields].map(([key, field]) => [key, field.value.trim()]))),
            }));
            if (!current())
                return;
            status(output, result.title + '：' + result.message, result.ok ? 'success' : 'error');
            const field = result.field ? fields.get(result.field) : undefined;
            if (!result.ok && field) {
                const fold = field.closest('.settings-fold');
                if (fold instanceof HTMLDetailsElement)
                    fold.open = true;
                field.scrollIntoView({ behavior: 'smooth', block: 'center' });
                focusTimer = setTimeout(() => {
                    focusTimer = null;
                    if (initialized && !request.signal.aborted)
                        field.focus({ preventScroll: true });
                }, 260);
            }
        }
        catch (error) {
            if (!current())
                return;
            const message = error instanceof Error ? error.message : '只读存储检查失败。';
            status(output, message, 'error');
            notify(message);
        }
        finally {
            if (controller === request) {
                controller = null;
                button.disabled = false;
                button.textContent = original;
            }
        }
    }
    const onClick = () => { void check(); };
    return {
        init() {
            if (initialized)
                return;
            initialized = true;
            button.addEventListener('click', onClick);
        },
        destroy() {
            if (!initialized)
                return;
            initialized = false;
            button.removeEventListener('click', onClick);
            controller?.abort();
            controller = null;
            if (focusTimer !== null)
                clearTimeout(focusTimer);
            focusTimer = null;
            button.disabled = false;
            button.textContent = original;
        },
    };
}
