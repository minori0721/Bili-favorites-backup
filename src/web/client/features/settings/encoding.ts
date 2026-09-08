const ENCODING_PRIORITY_LABELS: Record<string, {
    name: string;
    hint: string;
}> = {
    HEVC: { name: 'HEVC (H.265)', hint: '体积通常更小，兼容性取决于播放器' },
    AVC: { name: 'AVC (H.264)', hint: '兼容性最好，文件通常更大' },
    AV1: { name: 'AV1', hint: '压缩效率高，部分设备不支持解码' }
};
export function normalizeClientEncodingPriority(value: unknown, legacy?: unknown): string[] {
    const supported = ['HEVC', 'AVC', 'AV1'];
    const candidate = Array.isArray(value) ? value.map(v => String(v || '').trim().toUpperCase()) : [];
    if (candidate.length === supported.length && candidate.every(v => supported.includes(v)) && new Set(candidate).size === supported.length)
        return candidate;
    const old = String(legacy || '').trim().toUpperCase();
    return supported.includes(old) ? [old, ...supported.filter(v => v !== old)] : supported.slice();
}
export function renderEncodingPriorityEditor(host: HTMLElement, priority: readonly string[], onChange: (next: string[]) => void) {
    const values = normalizeClientEncodingPriority(priority);
    const document = host.ownerDocument;
    host.replaceChildren();
    let dragIndex: number | null = null;
    values.forEach((encoding, index) => {
        const item = document.createElement('div');
        item.className = 'encoding-priority-item';
        item.draggable = true;
        item.dataset.encoding = encoding;
        item.dataset.index = String(index);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-label', (index + 1) + '：' + (ENCODING_PRIORITY_LABELS[encoding]?.name || encoding));
        item.tabIndex = 0;
        const rank = document.createElement('span');
        rank.className = 'encoding-priority-rank';
        rank.textContent = String(index + 1);
        const copy = document.createElement('span');
        copy.className = 'encoding-priority-copy';
        const name = document.createElement('strong');
        name.className = 'encoding-priority-name';
        name.textContent = ENCODING_PRIORITY_LABELS[encoding]?.name || encoding;
        const hint = document.createElement('span');
        hint.className = 'encoding-priority-hint';
        hint.textContent = ENCODING_PRIORITY_LABELS[encoding]?.hint || '';
        copy.append(name, hint);
        const actions = document.createElement('span');
        actions.className = 'encoding-priority-actions';
        const move = (delta: number) => {
            const nextIndex = index + delta;
            if (nextIndex < 0 || nextIndex >= values.length)
                return;
            const next = values.slice();
            [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
            onChange(next);
        };
        const up = document.createElement('button');
        up.type = 'button';
        up.textContent = '↑';
        up.title = '上移';
        up.setAttribute('aria-label', '上移 ' + encoding);
        up.disabled = index === 0;
        up.addEventListener('click', () => move(-1));
        const down = document.createElement('button');
        down.type = 'button';
        down.textContent = '↓';
        down.title = '下移';
        down.setAttribute('aria-label', '下移 ' + encoding);
        down.disabled = index === values.length - 1;
        down.addEventListener('click', () => move(1));
        actions.append(up, down);
        item.append(rank, copy, actions);
        item.addEventListener('dragstart', (event) => { dragIndex = index; item.classList.add('dragging'); if (event.dataTransfer)
            event.dataTransfer.effectAllowed = 'move'; });
        item.addEventListener('dragend', () => { dragIndex = null; item.classList.remove('dragging'); });
        item.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer)
            event.dataTransfer.dropEffect = 'move'; });
        item.addEventListener('drop', (event) => {
            event.preventDefault();
            if (dragIndex === null || dragIndex === index)
                return;
            const next = values.slice();
            const [picked] = next.splice(dragIndex, 1);
            next.splice(index, 0, picked);
            onChange(next);
        });
        item.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
                return;
            event.preventDefault();
            move(event.key === 'ArrowUp' ? -1 : 1);
        });
        host.appendChild(item);
    });
}
