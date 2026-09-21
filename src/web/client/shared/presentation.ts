export function createPresentation(document: Document, navigator: Navigator) {
    function setHidden(elOrId: string | HTMLElement | null, hidden: boolean) {
        const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
        if (!el)
            return;
        el.classList.toggle('is-hidden', Boolean(hidden));
    }
    function setStatus(elOrId: string | HTMLElement | null, text: string, type = '') {
        const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
        if (!el)
            return;
        el.textContent = text || '';
        el.classList.remove('status-success', 'status-muted', 'status-error');
        if (type)
            el.classList.add('status-' + type);
    }
    function renderRequestStatus(elOrId: string | HTMLElement | null, text: string, type = '', retry?: () => void) {
        const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
        if (!el)
            return;
        setStatus(el, '', type);
        if (text)
            el.appendChild(document.createTextNode(text));
        if (typeof retry === 'function') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'retry-button';
            button.textContent = '重试';
            button.addEventListener('click', retry);
            el.appendChild(document.createTextNode(' '));
            el.appendChild(button);
        }
    }
    async function copyTextToClipboard(text: string) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            }
            catch (error) {
                console.debug('[Clipboard] navigator clipboard failed; using the textarea fallback', error);
            }
        }
        const input = document.createElement('textarea');
        input.value = text;
        input.setAttribute('readonly', 'readonly');
        input.className = 'clipboard-fallback-input';
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(input);
        return copied;
    }
    function formatDateTime(value: string | number) {
        if (!value)
            return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime()))
            return '';
        return date.toLocaleString('zh-CN', { hour12: false });
    }
    function formatBytes(value: number) {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes <= 0)
            return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit += 1;
        }
        return (unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 10 ? 1 : 2)) + ' ' + units[unit];
    }
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(value: unknown) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => (entities[ch] || ch));
    }
    return { setHidden, setStatus, renderRequestStatus, copyTextToClipboard, formatDateTime, formatBytes, escapeHtml };
}
