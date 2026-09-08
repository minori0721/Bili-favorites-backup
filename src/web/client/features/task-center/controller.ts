import { createQueueRecoveryActions } from './queue-recovery.js';
import { createQueueBoardView } from './board-view.js';
import { createQueueBoardController } from './board-controller.js';
import { createQueueStatusView } from './status-view.js';
import { createRecoveryCenter } from './recovery-center.js';
import { createMediaRetryDialog } from './media-retry.js';
import { createQueueSnapshotResource } from './snapshot.js';
import { createLogController, type LogMode } from './logs.js';
import { createSyncActions } from './sync-actions.js';
import { createSyncHelp } from './sync-help.js';
import { requireElement } from '../../shared/dom.js';
import { getQueueLoadingMarkup } from '../../../shared/queue-markup.js';
import type { ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';

interface Options {
  root: Document; api: ApiClient; confirmAction: ConfirmAction;
  openModal(id:string, trigger?:HTMLElement|null):void;
  closeModal(id:string, options?:{restoreFocus?:boolean}):unknown;
  formatDateTime(value:number):string; formatBytes(value:number):string;
  copyTextToClipboard(value:string):Promise<boolean>;
  showToast(message:string, kind?:'success'|'error'):void;
}
export function createTaskCenter(options: Options) {
  const {root:document, api, confirmAction, openModal, closeModal, formatDateTime, formatBytes, copyTextToClipboard, showToast} = options;
  const logRoot = requireElement(document, '#logConsole', HTMLElement);
  const boardRoot = requireElement(document, '#queueBoard', HTMLElement);
  const modes: LogMode[] = ['queue','simple','raw','debug'];
  const buttons = modes.map(mode => ({mode, button:requireElement(document, '#log' + mode[0].toUpperCase() + mode.slice(1) + 'Btn', HTMLButtonElement)}));
  let logMode: LogMode = 'queue';
  let events: AbortController | null = null;
  const snapshots = createQueueSnapshotResource({api, receive:snapshot=>recovery.receive(snapshot.issues,snapshot.issueSummary)});
  const logs = createLogController(logRoot, signal => api.silent('/api/queue/state', { signal }));
  const media = createMediaRetryDialog({root:requireElement(document,'#encodingRetryModal',HTMLElement),api,confirmAction,formatBytes,openModal,closeModal});
  const recovery = createRecoveryCenter({...options,queueSnapshots:snapshots,mediaRetry:media,boardActive:()=>logMode === 'queue'});
  const status = createQueueStatusView({root:document,formatDateTime,formatBytes});
  const actions = createQueueRecoveryActions({root:boardRoot,api,confirm:confirmAction,refresh:()=>board.refresh(),notify:showToast,openIssues:recovery.open});
  const view = createQueueBoardView({root:boardRoot,renderStatus:status.render,renderActions:actions.render});
  const board = createQueueBoardController({root:boardRoot,request:signal=>snapshots.request(signal),render:view.render,tick:view.tick,resetView:view.reset,loadingMarkup:getQueueLoadingMarkup,formatDateTime});
  const sync = createSyncActions({root:document,api,confirm:confirmAction,notify:message=>showToast(message,'error')});
  const help = createSyncHelp({root:document,open:(modal,trigger)=>openModal(modal.id,trigger)});
  function setMode(mode: LogMode) {
    board.stop(); logMode=mode; logs.setMode(mode);
    for (const item of buttons) item.button.classList.toggle('active',item.mode===mode);
    logRoot.classList.toggle('is-hidden',mode==='queue');
    boardRoot.classList.toggle('is-hidden',mode!=='queue');
    if(mode==='queue')board.start();
    else {actions.destroy();board.reset();}
  }
  function init() {
    if(events)return;
    events=new AbortController();const signal=events.signal;
    media.init();recovery.init();logs.init();sync.init();help.init();
    for(const item of buttons)item.button.addEventListener('click',()=>setMode(item.mode),{signal});
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){board.stop();recovery.stopPolling();}
      else {recovery.startPolling();if(logMode==='queue')board.start();}
    },{signal});
    setMode(logMode);recovery.startPolling();
  }
  function destroy() {
    events?.abort();events=null;
    actions.destroy();board.destroy();recovery.destroy();media.destroy();logs.destroy();sync.destroy();help.destroy();snapshots.cancel();
  }
  function escapeDetail() {
    const shell=document.querySelector('.recovery-issues-shell');
    if(!shell?.classList.contains('show-detail'))return false;
    shell.classList.remove('show-detail');
    document.querySelector<HTMLElement>('.recovery-issue-row.active')?.focus({preventScroll:true});
    return true;
  }
  return {init,destroy,escapeDetail,deactivateIssues:recovery.deactivate,deactivateChoice:recovery.deactivateChoice,deactivateMedia:media.deactivate};
}
