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
    return template.split(/(<[^<>]+>)/g).filter(part=>variables.some(variable=>variable.key===part));
}
function rearrangeTemplate(template:string, from:number, to:number|null):string {
    const pieces=template.split(/(<[^<>]+>)/g);
    const slots=pieces.flatMap((piece,index)=>variables.some(variable=>variable.key===piece)?[index]:[]);
    const keys=slots.map(index=>pieces[index]);
    const simple=template===keys.join('-');
    const [moved]=keys.splice(from,1);
    if(to!==null)keys.splice(to,0,moved);
    if(simple)return keys.join('-');
    if(to===null)pieces[slots[from]]='';
    else slots.forEach((slot,index)=>{pieces[slot]=keys[index];});
    return pieces.join('');
}
export function createTemplateEditor(root: ParentNode, changed: () => void) {
    const input = requireElement(root, '#filenameTemplate', HTMLInputElement);
    const available = requireElement(root, '#templateTags', HTMLElement);
    const selected = requireElement(root, '#selectedTags', HTMLElement);
    const preview = requireElement(root, '#templatePreview', HTMLElement);
    const document = input.ownerDocument;
    let keys: string[] = [];
    let dragIndex: number | null = null;
    let initialized = false;
    function commit(value:string) {
        input.value = value;
        refresh();
        changed();
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
            tag.tabIndex = 0;
            tag.dataset.templateKey = key;
            tag.setAttribute('aria-label', `已选${variable.label}，可用方向键调整顺序`);
            tag.textContent = variable.label;
            const move = (delta: number, action: string) => {
                const next = index + delta;
                if (next < 0 || next >= keys.length) return;
                commit(rearrangeTemplate(input.value,index,next));
                const updated = selected.querySelectorAll<HTMLElement>('[data-template-key]')[next];
                const control = updated?.querySelector<HTMLButtonElement>(`[data-template-action="${action}"]`);
                (control && !control.disabled ? control : updated)?.focus({preventScroll:true});
            };
            const up = document.createElement('button');
            up.type = 'button';up.className = 'template-order';up.textContent = '↑';
            up.dataset.templateAction = 'up';up.setAttribute('aria-label', `上移${variable.label}`);up.disabled = index === 0;
            up.addEventListener('click', () => move(-1, 'up'));
            const down = document.createElement('button');
            down.type = 'button';down.className = 'template-order';down.textContent = '↓';
            down.dataset.templateAction = 'down';down.setAttribute('aria-label', `下移${variable.label}`);down.disabled = index === keys.length - 1;
            down.addEventListener('click', () => move(1, 'down'));
            const remove = document.createElement('button');
            remove.type = 'button';remove.setAttribute('aria-label', `移除${variable.label}`);
            remove.className = 'remove-x';
            remove.textContent = '×';
            tag.append(up, down, remove);
            tag.addEventListener('keydown', event => {
                if (event.target !== tag || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                move(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1, '');
            });
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
                const from=dragIndex;
                dragIndex = null;
                commit(rearrangeTemplate(input.value,from,index));
            });
            remove.addEventListener('click', event => {
                event.stopPropagation();
                commit(rearrangeTemplate(input.value,index,null));
                const next=selected.querySelectorAll<HTMLElement>('[data-template-key]')[Math.min(index,keys.length-1)];
                (next?.querySelector<HTMLElement>('.remove-x')||available.querySelector<HTMLElement>('button'))?.focus({preventScroll:true});
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
                const tag = document.createElement('button');
                tag.type = 'button';
                tag.className = 'template-tag';
                tag.textContent = variable.label;
                tag.addEventListener('click', () => {
                    if (keys.includes(variable.key))
                        return;
                    commit(input.value ? input.value+'-'+variable.key : variable.key);
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
