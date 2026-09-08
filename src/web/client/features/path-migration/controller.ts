import { isRecord, type ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseItems, parseState, type MigrationState } from './contract.js';

interface ConfirmOptions {title:string; message:string; detail?:string; requiredText?:string; confirmText:string; trigger:HTMLElement}
export function createPathMigrationController(dependencies: {
  root: Document;
  api: ApiClient;
  openModal(id:string, trigger:HTMLElement):void;
  closeModal(id:string):void;
  confirmAction(options:ConfirmOptions):Promise<boolean>;
  setStatus(id:string, message:string, kind:string):void;
  setHidden(element:HTMLElement, hidden:boolean):void;
  escapeHtml(value:unknown):string;
  formatBytes(value:unknown):string;
}) {
  const {root:document, openModal, closeModal, confirmAction, setStatus, setHidden, escapeHtml, formatBytes} = dependencies;
  const fetchJson = dependencies.api.request, fetchJsonSilent = dependencies.api.silent;
  const element = <T extends Element>(id:string, type:{new(...args:never[]):T}):T => requireElement(document, '#' + id, type);
  let pathMigrationPollTimer: ReturnType<typeof setTimeout> | null = null;
  let pathMigrationGeneration = 0;
  let pathMigrationController: AbortController | null = null;
  let pathMigrationItemsController: AbortController | null = null;
  let pathMigrationItemsVisible = false;
  let pathMigrationCurrentId: string | null = null;
  let listeners: AbortController | null = null;
  let operationController: AbortController | null = null;
    function stopPathMigrationPolling() {
      pathMigrationGeneration += 1;
      operationController?.abort();
      operationController = null;
      pathMigrationController?.abort();
      pathMigrationController = null;
      pathMigrationItemsController?.abort();
      pathMigrationItemsController = null;
      if (pathMigrationPollTimer) {
        clearTimeout(pathMigrationPollTimer);
        pathMigrationPollTimer = null;
      }
    }

    function isPathMigrationOpen() {
      const modal = element('pathMigrationModal', HTMLElement);
      return modal.classList.contains('active') && !modal.classList.contains('is-closing');
    }

    async function loadPathMigrationItems(offset = 0) {
      if (!isPathMigrationOpen()) return;
      pathMigrationItemsController?.abort();
      const controller = new AbortController();
      pathMigrationItemsController = controller;
      const generation = pathMigrationGeneration;
      const migrationId = pathMigrationCurrentId;
      const host = element('pathMigrationItems', HTMLElement);
      pathMigrationItemsVisible = true;
      host.replaceChildren();
      const status = document.createElement('div');
      status.className = 'muted';
      status.textContent = '正在读取冲突与失败项目...';
      host.appendChild(status);
      const button = (label: string, action: () => unknown) => {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = 'ghost';
        control.textContent = label;
        control.addEventListener('click', action);
        return control;
      };
      try {
        const rows = parseItems(await fetchJsonSilent('/api/path-migration/items?status=conflict,failed&offset=' + offset + '&limit=21', { signal:controller.signal }));
        if (controller.signal.aborted || generation !== pathMigrationGeneration || !isPathMigrationOpen()) return;
        if (!Array.isArray(rows) || rows.some((row) => row.migrationId !== migrationId)) throw new Error('迁移预览已变化，请重新打开详情');
        status.textContent = rows.length ? '冲突与失败项目 · 第 ' + (Math.floor(offset / 20) + 1) + ' 页' : '本页没有冲突或失败项目';
        for (const row of rows.slice(0, 20)) {
          const entry = document.createElement('div');
          entry.className = 'cleanup-item';
          const content = document.createElement('div');
          content.style.minWidth = '0';
          content.style.overflowWrap = 'anywhere';
          const title = document.createElement('strong');
          title.textContent = row.relativePath || '未知项目';
          const reason = document.createElement('div');
          reason.textContent = row.lastError || (row.status === 'conflict' ? '目标大小或类型与源文件不一致' : '迁移失败');
          const size = document.createElement('div');
          size.className = 'muted';
          size.textContent = row.itemType === 'directory' ? '目录' : '源文件：' + (typeof row.expectedSize === 'number' ? formatBytes(row.expectedSize) : '大小未知') + ' · 目标大小：未记录';
          content.append(title, reason, size);
          entry.appendChild(content);
          host.appendChild(entry);
        }
        const advice = document.createElement('div');
        advice.className = 'muted';
        advice.textContent = '请在存储端核对冲突文件，或更换目标目录后重新预览；不会自动覆盖或删除冲突文件。';
        const controls = document.createElement('div');
        controls.className = 'row';
        const prev = button('上一页', () => loadPathMigrationItems(Math.max(0, offset - 20)));
        prev.disabled = offset === 0;
        const next = button('下一页', () => loadPathMigrationItems(offset + 20));
        next.disabled = rows.length <= 20;
        controls.append(prev, next, button('刷新列表', () => loadPathMigrationItems(offset)));
        host.append(advice, controls);
      } catch (error) {
        if (controller.signal.aborted || generation !== pathMigrationGeneration || !isPathMigrationOpen()) return;
        status.textContent = '读取失败：' + (error instanceof Error ? error.message : String(error));
        host.appendChild(button('重试', () => loadPathMigrationItems(offset)));
      } finally {
        if (pathMigrationItemsController === controller) pathMigrationItemsController = null;
      }
    }

    function renderPathMigrationState(state: MigrationState | null) {
      if (!isPathMigrationOpen()) return;
      const summary = element('pathMigrationSummary', HTMLElement);
      const source = element('pathMigrationSource', HTMLInputElement);
      const destination = element('pathMigrationDestination', HTMLInputElement);
      const status = element('pathMigrationStatus', HTMLElement);
      const items = element('pathMigrationItems', HTMLElement);
      if (!summary || !status) return;
      if (pathMigrationCurrentId !== (state?.id || null)) {
        pathMigrationItemsController?.abort();
        pathMigrationItemsVisible = false;
        pathMigrationCurrentId = state?.id || null;
        items.replaceChildren();
      }
      source.value = state?.sourceRoot || source.value || '';
      if (state?.destinationRoot) destination.value = state.destinationRoot;
      if (!state) {
        summary.innerHTML = '<div class="cleanup-item"><div><div class="cleanup-item-title">还没有路径预览</div><div class="cleanup-item-desc">输入新路径后生成扫描预览。现有归档不会被移动或删除。</div></div></div>';
        items.innerHTML = '';
        setHidden(status, true);
        return;
      }
      const labels: Record<string,string> = { scanning:'扫描中', ready:state.conflictCount > 0 ? '需处理冲突' : '可以开始', copying:'复制中', verifying:'等待远端确认', paused:'已暂停', switching:'切换状态中', cleanup_pending:'等待清理旧目录', cleanup_running:'正在核验并处理旧目录', completed:'已完成', cancelled:'已取消', failed:'需要处理' };
      const toCopy = Math.max(0, Number(state.entryCount || 0) - Number(state.verifiedCount || 0));
      summary.innerHTML =
        '<div class="cleanup-item"><div><div class="cleanup-item-title">阶段：' + escapeHtml(labels[state.status] || state.status) + '</div><div class="cleanup-item-desc">' + escapeHtml(state.sourceRoot) + ' → ' + escapeHtml(state.destinationRoot) + '</div></div><strong>' + escapeHtml(String(state.progress?.completed || 0)) + ' / ' + escapeHtml(String(state.entryCount || 0)) + '</strong></div>' +
        '<div class="cleanup-item"><div><div class="cleanup-item-title">文件与目录</div><div class="cleanup-item-desc">文件 ' + escapeHtml(String(state.fileCount || 0)) + '，目录 ' + escapeHtml(String(state.directoryCount || 0)) + '，总大小 ' + escapeHtml(formatBytes(state.totalBytes)) + '</div></div><strong>待复制 ' + escapeHtml(String(toCopy)) + '</strong></div>' +
        '<div class="cleanup-item"><div><div class="cleanup-item-title">安全检查</div><div class="cleanup-item-desc">可复用 ' + escapeHtml(String(state.reusableCount || 0)) + '，冲突 ' + escapeHtml(String(state.conflictCount || 0)) + '，目标额外内容 ' + escapeHtml(String(state.extraCount || 0)) + '</div></div></div>';
      setHidden(status, false);
      status.textContent = state.lastError || ('当前阶段：' + (labels[state.status] || state.status));
      status.className = 'rename-result result-block ' + ((state.status === 'failed' || state.conflictCount > 0) ? 'status-error' : (state.status === 'completed' ? 'status-success' : 'status-muted'));
      const busy = ['scanning','copying','verifying','switching','cleanup_running'].includes(state.status);
      element('pathMigrationStartBtn', HTMLButtonElement).disabled = state.status !== 'ready' || state.conflictCount > 0;
      element('pathMigrationPauseBtn', HTMLButtonElement).disabled = !['copying','verifying'].includes(state.status);
      element('pathMigrationResumeBtn', HTMLButtonElement).disabled = state.status !== 'paused';
      element('pathMigrationCancelBtn', HTMLButtonElement).disabled = ['switching','cleanup_pending','cleanup_running','completed','cancelled'].includes(state.status);
      element('pathMigrationCleanupBtn', HTMLButtonElement).disabled = state.status !== 'cleanup_pending';
      element('pathMigrationKeepBtn', HTMLButtonElement).disabled = state.status !== 'cleanup_pending';
      if (items && !pathMigrationItemsVisible) {
        items.replaceChildren();
        if (state.conflictCount || state.failedCount) {
          const show = document.createElement('button');
          show.type = 'button';
          show.className = 'ghost';
          show.textContent = '查看冲突与失败项目';
          show.addEventListener('click', () => loadPathMigrationItems(0));
          items.appendChild(show);
        }
      }
      if (busy || state.status === 'paused' || state.status === 'cleanup_pending') startPathMigrationPolling();
    }

    async function refreshPathMigrationState() {
      if (!isPathMigrationOpen() || pathMigrationController) return;
      if (pathMigrationPollTimer) clearTimeout(pathMigrationPollTimer);
      pathMigrationPollTimer = null;
      const generation = pathMigrationGeneration;
      const controller = new AbortController();
      pathMigrationController = controller;
      try {
        const state = parseState(await fetchJsonSilent('/api/path-migration/state', { signal:controller.signal }));
        if (!controller.signal.aborted && generation === pathMigrationGeneration && isPathMigrationOpen()) renderPathMigrationState(state);
      } catch (error) {
        if (!controller.signal.aborted && generation === pathMigrationGeneration && isPathMigrationOpen()) {
          setStatus('pathMigrationStatus', '状态读取失败：' + (error instanceof Error ? error.message : String(error)), 'error');
          startPathMigrationPolling();
        }
      } finally {
        if (pathMigrationController === controller) pathMigrationController = null;
      }
    }

    function startPathMigrationPolling() {
      if (pathMigrationPollTimer || !isPathMigrationOpen()) return;
      pathMigrationPollTimer = setTimeout(() => {
        pathMigrationPollTimer = null;
        void refreshPathMigrationState();
      }, 1500);
    }

    async function openPathMigration() {
      openModal('pathMigrationModal', element('pathMigrationBtn', HTMLButtonElement));
      stopPathMigrationPolling();
      pathMigrationItemsVisible = false;
      pathMigrationCurrentId = null;
      element('pathMigrationItems', HTMLElement).replaceChildren();
      const generation = pathMigrationGeneration;
      const controller = new AbortController();
      pathMigrationController = controller;
      try {
        const config = await fetchJsonSilent('/api/config', { signal:controller.signal });
        if (!isRecord(config) || typeof config.alistDest !== 'string') throw new Error('配置响应格式错误');
        if (controller.signal.aborted || generation !== pathMigrationGeneration || !isPathMigrationOpen()) return;
        element('pathMigrationSource', HTMLInputElement).value = config.alistDest || '';
        element('pathMigrationDestination', HTMLInputElement).value = '';
      } catch (error) {
        if (!controller.signal.aborted && generation === pathMigrationGeneration && isPathMigrationOpen()) setStatus('pathMigrationStatus', '配置读取失败：' + (error instanceof Error ? error.message : String(error)), 'error');
        return;
      } finally {
        if (pathMigrationController === controller) pathMigrationController = null;
      }
      if (generation === pathMigrationGeneration) await refreshPathMigrationState();
    }

    async function previewPathMigration() {
      if (operationController || !isPathMigrationOpen()) return;
      const generation = pathMigrationGeneration;
      const destinationRoot = element('pathMigrationDestination', HTMLInputElement).value.trim();
      if (!destinationRoot) { setStatus('pathMigrationStatus', '请填写新归档路径。', 'error'); return; }
      const controller = new AbortController();
      operationController = controller;
      try {
        await fetchJson('/api/path-migration/preview', { signal:controller.signal, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ destinationRoot }) });
        if (generation !== pathMigrationGeneration || !isPathMigrationOpen()) return;
        startPathMigrationPolling();
        await refreshPathMigrationState();
      } catch (error) { if (generation === pathMigrationGeneration && isPathMigrationOpen()) setStatus('pathMigrationStatus', '预览失败：' + (error instanceof Error ? error.message : String(error)), 'error'); }
      finally { if (operationController === controller) operationController = null; }
    }

    async function pathMigrationAction(action: string, body: Record<string, unknown> = {}) {
      if (operationController || !isPathMigrationOpen()) return;
      const generation = pathMigrationGeneration;
      const controller = new AbortController();
      operationController = controller;
      try {
        await fetchJson('/api/path-migration/' + action, { signal:controller.signal, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (generation !== pathMigrationGeneration || !isPathMigrationOpen()) return;
        await refreshPathMigrationState();
      } catch (error) { if (generation === pathMigrationGeneration && isPathMigrationOpen()) setStatus('pathMigrationStatus', '操作失败：' + (error instanceof Error ? error.message : String(error)), 'error'); }
      finally { if (operationController === controller) operationController = null; }
    }

    async function cleanupOldPathMigration() {
      const generation = pathMigrationGeneration;
      const ok = await confirmAction({ title:'确认清理旧归档目录', message:'系统会重新验证源目录与目标文件，确认一致后删除旧归档根目录。', detail:'删除后无法由本项目恢复旧目录，请只在确认新目录完整可用后执行。', requiredText:'DELETE OLD ARCHIVE', confirmText:'删除旧目录', trigger:element('pathMigrationCleanupBtn', HTMLButtonElement) });
      if (ok && generation === pathMigrationGeneration) await pathMigrationAction('cleanup-old', { confirmation:'DELETE OLD ARCHIVE' });
    }


  return {
    open:openPathMigration,
    deactivate:stopPathMigrationPolling,
    init() {
      if (listeners) return;
      listeners = new AbortController();
    element('pathMigrationBtn', HTMLButtonElement).addEventListener('click', openPathMigration, {signal:listeners.signal});
    element('pathMigrationPreviewBtn', HTMLButtonElement).addEventListener('click', previewPathMigration, {signal:listeners.signal});
    element('pathMigrationStartBtn', HTMLButtonElement).addEventListener('click', () => pathMigrationAction('start', {}), {signal:listeners.signal});
    element('pathMigrationPauseBtn', HTMLButtonElement).addEventListener('click', () => pathMigrationAction('pause', {}), {signal:listeners.signal});
    element('pathMigrationResumeBtn', HTMLButtonElement).addEventListener('click', () => pathMigrationAction('resume', {}), {signal:listeners.signal});
    element('pathMigrationCancelBtn', HTMLButtonElement).addEventListener('click', async () => {
      const generation = pathMigrationGeneration;
      const ok = await confirmAction({ title:'取消路径迁移', message:'会保留已经复制到新目录的文件，但不会切换配置；下次可重新预览。', confirmText:'确认取消', trigger:element('pathMigrationCancelBtn', HTMLButtonElement) });
      if (ok && generation === pathMigrationGeneration) await pathMigrationAction('cancel', {});
    }, {signal:listeners.signal});
    element('pathMigrationKeepBtn', HTMLButtonElement).addEventListener('click', () => pathMigrationAction('cleanup-old', { keepOld:true }), {signal:listeners.signal});
    element('pathMigrationCleanupBtn', HTMLButtonElement).addEventListener('click', cleanupOldPathMigration, {signal:listeners.signal});
    element('closePathMigrationBtn', HTMLButtonElement).addEventListener('click', () => { stopPathMigrationPolling(); closeModal('pathMigrationModal'); }, {signal:listeners.signal});
    },
    destroy() { stopPathMigrationPolling(); listeners?.abort(); listeners = null; },
  };
}
