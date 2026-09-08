import { requireElement } from '../../shared/dom.js';
const variables = [
    { key: '<videoTitle>', label: '视频标题', example: '视频标题示例' },
    { key: '<ownerName>', label: 'UP主', example: 'UP主名' },
    { key: '<bvid>', label: 'BV号', example: 'BV1xxxxx' },
    { key: '<publishDate>', label: '发布日期', example: '2026-05-08' },
    { key: '<videoDate>', label: '视频日期', example: '2026-05-08' },
    { key: '<dfn>', label: '清晰度', example: '1080P' },
    { key: '<videoCodecs>', label: '编码', example: 'HEVC' },
];
export function templatePreview(template: string): string {
    let preview = template || '<videoTitle>-<bvid>';
    for (const variable of variables)
        preview = preview.split(variable.key).join(variable.example);
    return preview + '.mp4';
}
export function templateKeys(template: string): string[] {
    return variables.filter(variable => template.includes(variable.key))
        .map(variable => variable.key).sort((a, b) => template.indexOf(a) - template.indexOf(b));
}
export function createTemplateEditor(root: ParentNode) {
    const input = requireElement(root, '#filenameTemplate', HTMLInputElement);
    const available = requireElement(root, '#templateTags', HTMLElement);
    const selected = requireElement(root, '#selectedTags', HTMLElement);
    const preview = requireElement(root, '#templatePreview', HTMLElement);
    const document = input.ownerDocument;
    let keys: string[] = [];
    let dragIndex: number | null = null;
    let initialized = false;
    function commit() {
        input.value = keys.join('-');
        refresh();
    }
    function render() {
        selected.replaceChildren();
        if (!keys.length) {
            const hint = document.createElement('span');
            hint.className = 'template-empty-hint';
            hint.textContent = '点击上方标签添加到此处';
            selected.append(hint);
        }
        keys.forEach((key, index) => {
            const variable = variables.find(item => item.key === key);
            if (!variable)
                return;
            const tag = document.createElement('span');
            tag.className = 'template-tag selected';
            tag.draggable = true;
            tag.textContent = variable.label;
            const remove = document.createElement('span');
            remove.className = 'remove-x';
            remove.textContent = '×';
            tag.append(remove);
            tag.addEventListener('dragstart', () => { dragIndex = index; tag.classList.add('dragging'); });
            tag.addEventListener('dragend', () => {
                dragIndex = null;
                tag.classList.remove('dragging');
                selected.querySelectorAll('.drag-over').forEach(item => item.classList.remove('drag-over'));
            });
            tag.addEventListener('dragover', event => { event.preventDefault(); tag.classList.add('drag-over'); });
            tag.addEventListener('dragleave', () => tag.classList.remove('drag-over'));
            tag.addEventListener('drop', event => {
                event.preventDefault();
                tag.classList.remove('drag-over');
                if (dragIndex === null || dragIndex === index)
                    return;
                const moved = keys.splice(dragIndex, 1)[0];
                keys.splice(index, 0, moved);
                dragIndex = null;
                commit();
            });
            remove.addEventListener('click', event => {
                event.stopPropagation();
                keys.splice(index, 1);
                commit();
            });
            selected.append(tag);
        });
    }
    function refresh() {
        if (!initialized)
            return;
        dragIndex = null;
        keys = templateKeys(input.value);
        preview.textContent = templatePreview(input.value);
        render();
    }
    return {
        refresh,
        init() {
            if (initialized)
                return;
            initialized = true;
            available.replaceChildren();
            for (const variable of variables) {
                const tag = document.createElement('span');
                tag.className = 'template-tag';
                tag.textContent = variable.label;
                tag.addEventListener('click', () => {
                    if (keys.includes(variable.key))
                        return;
                    keys.push(variable.key);
                    commit();
                });
                available.append(tag);
            }
            input.addEventListener('input', refresh);
            refresh();
        },
        destroy() {
            if (!initialized)
                return;
            initialized = false;
            input.removeEventListener('input', refresh);
            available.replaceChildren();
            selected.replaceChildren();
            keys = [];
            dragIndex = null;
        },
    };
}
