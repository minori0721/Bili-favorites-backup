import { isRecord, type ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { requireElement } from '../../shared/dom.js';

const commands = [
  {id:'syncNowBtn', path:'/api/sync/now', label:'立即同步', pending:'同步中...'},
  {id:'reconcileRemoteBtn', path:'/api/sync/reconcile-remote', label:'状态对账（仅远端存储）', pending:'对账中...'},
  {id:'reconcileBtn', path:'/api/sync/reconcile', label:'全量扫描并对账', pending:'全量扫描中...'},
];

export function createSyncActions(dependencies: {
  root:ParentNode; api:ApiClient; confirm:ConfirmAction; notify(message:string):void;
}) {
  let initialized = false;
  let generation = 0;
  const actions = commands.map(command => {
    const button = requireElement(dependencies.root, '#'+command.id, HTMLButtonElement);
    let controller:AbortController|null = null;
    let timer:ReturnType<typeof setTimeout>|null = null;
    let confirming = false;
    async function run() {
      if (!initialized || controller || confirming) return;
      const currentGeneration = generation;
      if (command.id === 'reconcileBtn') {
        confirming = true;
        const accepted = await dependencies.confirm({
          title:'确认全量扫描并对账', message:'将全量扫描 B 站收藏夹所有页，并执行对账。',
          detail:'这个操作请求量较大，可能触发 412、登录校验或风控。建议仅在首轮补齐、迁移目录后或确实需要时使用。',
          confirmText:'继续扫描', trigger:button,
        });
        if (generation !== currentGeneration) return;
        confirming = false;
        if (!accepted || !initialized) return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const request = new AbortController();
      controller = request;
      const current = () => initialized && generation === currentGeneration && controller === request;
      button.disabled = true;
      button.textContent = command.pending;
      try {
        const response = await dependencies.api.silent(command.path, {method:'POST',signal:request.signal});
        if (!current()) return;
        if (!isRecord(response) || (response.queued !== undefined && typeof response.queued !== 'boolean')) {
          throw new Error('同步操作响应格式错误');
        }
        button.textContent = response.queued ? '已排队' : '已触发';
      } catch(error) {
        if (!current()) return;
        button.textContent = '触发失败';
        dependencies.notify(error instanceof Error ? error.message : String(error));
      } finally {
        if (current()) {
          controller = null;
          button.disabled = false;
          timer = setTimeout(() => {
            timer = null;
            if (initialized && generation === currentGeneration) button.textContent = command.label;
          }, 2000);
        }
      }
    }
    const click = () => { void run(); };
    return {
      init() {button.textContent=command.label;button.addEventListener('click',click);},
      destroy() {
        button.removeEventListener('click',click);
        controller?.abort();controller=null;confirming=false;
        if(timer!==null)clearTimeout(timer);timer=null;
        button.disabled=false;button.textContent=command.label;
      },
    };
  });
  return {
    init() {if(initialized)return;initialized=true;actions.forEach(action=>action.init());},
    destroy() {if(!initialized)return;initialized=false;generation++;actions.forEach(action=>action.destroy());},
  };
}
