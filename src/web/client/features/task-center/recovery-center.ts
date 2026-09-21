import { parseRecoveryIssue, parseRecoverySummary, type RecoveryIssue, type RecoveryAction } from '../../../../shared/api/recovery-issues.js';
import type { ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { requireElement } from '../../shared/dom.js';
import type { createQueueSnapshotResource } from './snapshot.js';
import type { createMediaRetryDialog } from './media-retry.js';
type Summary = ReturnType<typeof parseRecoverySummary>;
interface Options {
  root: Document; api: ApiClient; queueSnapshots: Pick<ReturnType<typeof createQueueSnapshotResource>, 'request' | 'applyIssueUpdate'>;
  mediaRetry: Pick<ReturnType<typeof createMediaRetryDialog>, 'open' | 'encodingPriority'>;
  confirmAction: ConfirmAction; formatBytes(value: number): string; formatDateTime(value: number): string;
  copyTextToClipboard(text: string): Promise<boolean>; showToast(message: string, kind: 'success' | 'error'): void;
  openModal(id: string, trigger?: HTMLElement | null): void; closeModal(id: string, options?: {restoreFocus?: boolean}): unknown;
  boardActive(): boolean;
}
export function createRecoveryCenter({root: document, api, queueSnapshots, mediaRetry, confirmAction, formatBytes, formatDateTime, copyTextToClipboard, showToast, openModal, closeModal, boardActive}: Options) {
  const elements = {
    recoveryIssuesBtn: requireElement(document, '#recoveryIssuesBtn', HTMLButtonElement),
    recoveryIssuesDetail: requireElement(document, '#recoveryIssuesDetail', HTMLElement),
    recoveryIssuesStatus: requireElement(document, '#recoveryIssuesStatus', HTMLElement),
    recoveryIssuesStatusMessage: requireElement(document, '#recoveryIssuesStatusMessage', HTMLElement),
    recoveryIssuesRetryBtn: requireElement(document, '#recoveryIssuesRetryBtn', HTMLButtonElement),
    recoveryIssuesEmptyState: requireElement(document, '#recoveryIssuesEmptyState', HTMLElement),
    recoveryIssuesEmptyTitle: requireElement(document, '#recoveryIssuesEmptyTitle', HTMLElement),
    recoveryIssuesEmptyMessage: requireElement(document, '#recoveryIssuesEmptyMessage', HTMLElement),
    recoveryIssuesEmptyRetryBtn: requireElement(document, '#recoveryIssuesEmptyRetryBtn', HTMLButtonElement),
    recoveryIssuesSummary: requireElement(document, '#recoveryIssuesSummary', HTMLElement),
    recoveryIssuesListCount: requireElement(document, '#recoveryIssuesListCount', HTMLElement),
    recoveryIssuesModal: requireElement(document, '#recoveryIssuesModal', HTMLElement),
    recoveryIssuesList: requireElement(document, '#recoveryIssuesList', HTMLElement),
    recoveryChoiceTitle: requireElement(document, '#recoveryChoiceTitle', HTMLElement),
    recoveryChoiceCopy: requireElement(document, '#recoveryChoiceCopy', HTMLElement),
    recoveryChoiceSelect: requireElement(document, '#recoveryChoiceSelect', HTMLSelectElement),
    recoveryChoiceStatus: requireElement(document, '#recoveryChoiceStatus', HTMLElement),
    storageCheckBtn: requireElement(document, '#storageCheckBtn', HTMLButtonElement),
    storageSettings: requireElement(document, '#storageSettings', HTMLDetailsElement),
    recoveryIssuesLive: requireElement(document, '#recoveryIssuesLive', HTMLElement),
    closeRecoveryIssuesBtn: requireElement(document, '#closeRecoveryIssuesBtn', HTMLButtonElement),
    recoveryIssuesBackBtn: requireElement(document, '#recoveryIssuesBackBtn', HTMLButtonElement),
    recoveryChoiceSubmitBtn: requireElement(document, '#recoveryChoiceSubmitBtn', HTMLButtonElement),
    recoveryChoiceCancelBtn: requireElement(document, '#recoveryChoiceCancelBtn', HTMLButtonElement),
  };
  let recoveryIssuePollTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryIssueRequestInFlight = false;
  const recoveryIssueState: {items: RecoveryIssue[]; selectedId: string | null; focusId: string | null; controller: AbortController | null; token: number; error: string | null; summary: Summary | null} = {
    items: [], selectedId: null, focusId: null, controller: null, token: 0, error: null, summary: null,
  };
  let recoveryChoiceDialogState: {resolve(value: string | null): void; action: RecoveryAction; trigger: HTMLElement} | null = null;
  const actionRequests = new Set<AbortController>();
  const busyActions = new Set<string>();
  let lifecycleGeneration = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let events: AbortController | null = null;
  function later(callback: () => void, delay: number) {
    const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);
  }
  async function runRecoveryIssueAction(issue: RecoveryIssue, action: RecoveryAction | undefined, trigger: HTMLElement) {
    const key = lifecycleGeneration + ':' + issue.id;
    if (!action || busyActions.has(key)) return;
    busyActions.add(key);
    try { await performRecoveryIssueAction(issue, action, trigger); }
    finally { busyActions.delete(key); }
  }
    function recoveryIssueCounts(items: RecoveryIssue[]) {
      const list = Array.isArray(items) ? items : [];
      const actionRequired = list.filter((item) => (item.disposition || 'action_required') === 'action_required');
      const intentional = list.filter((item) => item.disposition === 'intentional_confirmation');
      return {
        total:actionRequired.length,
        danger:actionRequired.filter((item) => item.severity === 'danger').length,
        warning:actionRequired.filter((item) => item.severity === 'warning').length,
        info:actionRequired.filter((item) => item.severity === 'info').length,
        actionRequired:actionRequired.length,
        intentional:intentional.length,
      };
    }

    function updateRecoveryIssuesEntry(summary: Summary) {
      const button = elements.recoveryIssuesBtn;
      if (!button) return;
      const total = Number(summary?.total || 0);
      const danger = Number(summary?.danger || 0);
      const intentional = Number(summary?.intentional || 0);
      button.textContent = '待处理 ' + total + (intentional > 0 ? ' · 待确认 ' + intentional : '');
      button.classList.toggle('has-issues', total > 0);
      button.classList.toggle('has-danger', danger > 0);
      button.setAttribute('aria-label', total > 0 || intentional > 0
        ? '打开恢复中心，待处理 ' + total + ' 项，待确认 ' + intentional + ' 项'
        : '打开恢复中心，当前没有需要处理或确认的项目');
    }

    function renderRecoveryIssueStatus() {
      const shell = document.querySelector<HTMLElement>('.recovery-issues-shell');
      const layout = document.querySelector<HTMLElement>('.recovery-issues-layout');
      const listPane = document.querySelector<HTMLElement>('.recovery-issues-list-pane');
      const detail = elements.recoveryIssuesDetail;
      const status = elements.recoveryIssuesStatus;
      const message = elements.recoveryIssuesStatusMessage;
      const retry = elements.recoveryIssuesRetryBtn;
      const emptyState = elements.recoveryIssuesEmptyState;
      const emptyTitle = elements.recoveryIssuesEmptyTitle;
      const emptyMessage = elements.recoveryIssuesEmptyMessage;
      const emptyRetry = elements.recoveryIssuesEmptyRetryBtn;
      const summaryBadge = elements.recoveryIssuesSummary;
      const listCount = elements.recoveryIssuesListCount;
      const hasItems = recoveryIssueState.items.length > 0;
      const hasError = Boolean(recoveryIssueState.error);
      const actionCount = Number(recoveryIssueState.summary?.total || 0);
      const confirmationCount = Number(recoveryIssueState.summary?.intentional || 0);
      if (shell) {
        shell.classList.toggle('is-empty', !hasItems);
        if (!hasItems) shell.classList.remove('show-detail');
      }
      if (layout) layout.classList.toggle('is-empty', !hasItems);
      if (listPane) listPane.hidden = !hasItems;
      if (detail) detail.hidden = !hasItems;
      if (emptyState) {
        emptyState.hidden = hasItems;
        emptyState.classList.toggle('is-error', !hasItems && hasError);
        emptyState.setAttribute('role', hasError ? 'alert' : 'status');
      }
      const intentionalOnly = !hasItems && Number(recoveryIssueState.summary?.intentional || 0) > 0;
      if (emptyTitle) emptyTitle.textContent = hasError
        ? '待处理问题暂时无法加载'
        : (intentionalOnly ? '当前没有需要立即处理的问题' : '当前没有需要处理的问题');
      if (emptyMessage) emptyMessage.textContent = hasError
        ? '当前没有可用的问题列表，已有数据不会被清除。请重新加载。'
        : (intentionalOnly ? '仍有待确认项目，请打开恢复中心查看。' : '系统会继续在后台自动复核，新的异常会出现在这里。');
      if (emptyRetry) {
        emptyRetry.hidden = !hasError;
        emptyRetry.disabled = recoveryIssueRequestInFlight;
      }
      if (summaryBadge) {
        const summaryParts = [];
        if (actionCount > 0) summaryParts.push('待处理 ' + actionCount);
        if (confirmationCount > 0) summaryParts.push('待确认 ' + confirmationCount);
        summaryBadge.hidden = summaryParts.length === 0;
        summaryBadge.textContent = summaryParts.join(' · ');
      }
      if (listCount) listCount.textContent = hasItems ? recoveryIssueState.items.length + ' 项' : '';
      if (!status || !message || !retry) return;
      status.hidden = !hasItems || !hasError;
      message.textContent = recoveryIssueState.error || '';
      retry.disabled = recoveryIssueRequestInFlight;
    }

    function setRecoveryIssueItems(items: unknown, summary?: unknown) {
      const parsed = Array.isArray(items) ? items.map(parseRecoveryIssue) : [];
      const parsedSummary = summary == null ? recoveryIssueCounts(parsed) : parseRecoverySummary(summary);
      recoveryIssueState.error = null;
      recoveryIssueState.items = parsed;
      recoveryIssueState.summary = parsedSummary;
      const focused = recoveryIssueState.focusId;
      if (focused && recoveryIssueState.items.some((item) => item.id === focused)) {
        recoveryIssueState.selectedId = focused;
        recoveryIssueState.focusId = null;
      } else if (!recoveryIssueState.items.some((item) => item.id === recoveryIssueState.selectedId)) {
        recoveryIssueState.selectedId = recoveryIssueState.items[0]?.id || null;
      }
      updateRecoveryIssuesEntry(recoveryIssueState.summary);
      if (elements.recoveryIssuesModal?.classList.contains('active')) {
        renderRecoveryIssueCenter();
      }
    }

    function recoveryIssueStatusLabel(issue: RecoveryIssue) {
      if (issue?.busy) return '处理中';
      if (issue?.disposition === 'intentional_confirmation') return '待确认';
      if (issue?.severity === 'danger') return '需要处理';
      if (issue?.severity === 'warning') return '建议处理';
      return '待处理';
    }

    function recoveryIssueTypeLabel(issue: RecoveryIssue) {
      const labels: Record<string, string> = {
        remote_size_limit:'远端单文件超过限制',
        remote_write_rejected:'远端写入结果未确认',
        remote_size_conflict:'远端存在同名冲突',
        partial_remote_state:'多分P状态不一致',
        local_file_missing:'本地补传文件已丢失',
        local_file_changed:'本地补传文件已变化',
        remote_permission:'存储权限被拒绝',
        remote_connection:'存储连接暂时不可用',
        remote_unsupported:'存储不支持当前方法',
        remote_unknown:'存储返回未知错误',
        unknown_same_size:'远端证明还未确认',
        legacy_conflict_interrupted:'旧冲突归档待复核',
        conflict_candidate_ready:'新候选等待选择',
        encoding_retry_failed:'媒体替换未完成',
        download_retry_exhausted:'下载重试次数已用完',
        download_account_required:'下载账号需要更换',
        download_tool_failure:'本地下载工具异常',
        quality_failed:'画质重调已暂停',
        storage_backend:'存储设置需要检查',
        manual_review:'上传任务需要复核',
      };
      return labels[issue.kind || ''] || '任务需要复核';
    }

    function recoveryIssueTargetTitle(issue: RecoveryIssue) {
      return issue?.videoTitle || (issue?.bvid ? '视频 ' + issue.bvid : '') || issue?.fileName || '存储后端';
    }

    function recoveryIssueTargetMeta(issue: RecoveryIssue) {
      return [issue?.upperName, issue?.bvid].filter(Boolean).join(' · ') || (issue?.kind === 'storage_backend' ? 'AList / OpenList' : '系统级任务');
    }

    function recoveryIssueMeta(issue: RecoveryIssue) {
      return [issue.bvid, issue.folderTitle, issue.fileName].filter(Boolean).join(' · ') || '系统级问题';
    }

    function renderRecoveryIssueList() {
      const host = elements.recoveryIssuesList;
      host.innerHTML = '';
      if (recoveryIssueState.items.length === 0) {
        return;
      }
      recoveryIssueState.items.forEach((issue) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'recovery-issue-row ' + (issue.severity || 'info');
        row.dataset.issueId = issue.id;
        row.classList.toggle('active', issue.id === recoveryIssueState.selectedId);
        row.setAttribute('aria-pressed', String(issue.id === recoveryIssueState.selectedId));
        row.setAttribute('aria-label', [recoveryIssueStatusLabel(issue), recoveryIssueTargetTitle(issue), recoveryIssueTypeLabel(issue), recoveryIssueTargetMeta(issue)].join(' · '));
        const marker = document.createElement('span');
        marker.className = 'recovery-issue-marker';
        marker.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'recovery-issue-row-copy';
        const status = document.createElement('span');
        status.className = 'recovery-issue-row-status';
        status.textContent = recoveryIssueStatusLabel(issue);
        const title = document.createElement('span');
        title.className = 'recovery-issue-row-title';
        title.textContent = recoveryIssueTargetTitle(issue);
        const problem = document.createElement('span');
        problem.className = 'recovery-issue-row-problem';
        problem.textContent = recoveryIssueTypeLabel(issue);
        const meta = document.createElement('span');
        meta.className = 'recovery-issue-row-meta';
        meta.textContent = recoveryIssueTargetMeta(issue) + (issue.fileName ? ' · ' + issue.fileName : '');
        text.append(status, title, problem, meta);
        const arrow = document.createElement('span');
        arrow.className = 'recovery-issue-row-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        row.append(marker, text, arrow);
        row.addEventListener('click', () => {
          recoveryIssueState.selectedId = issue.id;
          renderRecoveryIssueCenter();
          document.querySelector<HTMLElement>('.recovery-issues-shell')?.classList.add('show-detail');
          elements.recoveryIssuesDetail?.focus({ preventScroll:true });
        });
        host.appendChild(row);
      });
    }

    function appendRecoveryDetailSection(host: HTMLElement, titleText: string, content: Node | string) {
      const section = document.createElement('section');
      section.className = 'recovery-detail-section';
      const title = document.createElement('h3');
      title.textContent = titleText;
      section.appendChild(title);
      if (content instanceof Node) section.appendChild(content);
      else {
        const text = document.createElement('p');
        text.textContent = String(content || '');
        section.appendChild(text);
      }
      host.appendChild(section);
    }

    function finishRecoveryChoiceDialog(value: string | null) {
      const pending = recoveryChoiceDialogState;
      if (!pending) return;
      recoveryChoiceDialogState = null;
      closeModal('recoveryChoiceModal', { restoreFocus:true });
      pending.resolve(value);
    }

    function openRecoveryChoiceDialog(action: RecoveryAction, trigger: HTMLElement): Promise<string | null> {
      if (recoveryChoiceDialogState) return Promise.resolve(null);
      const choices = Array.isArray(action?.choices) ? action.choices.filter((choice) => choice?.value) : [];
      if (choices.length === 0) return Promise.resolve(null);
      return new Promise((resolve) => {
        recoveryChoiceDialogState = { resolve, action, trigger };
        elements.recoveryChoiceTitle.textContent = action.label || '选择恢复方式';
        elements.recoveryChoiceCopy.textContent = action.description || '';
        const select = elements.recoveryChoiceSelect;
        select.innerHTML = '';
        choices.forEach((choice) => {
          const option = document.createElement('option');
          option.value = String(choice.value);
          option.textContent = String(choice.label || choice.value);
          select.appendChild(option);
        });
        elements.recoveryChoiceStatus.textContent = '';
        openModal('recoveryChoiceModal', trigger);
      });
    }

    async function performRecoveryIssueAction(issue: RecoveryIssue, action: RecoveryAction | undefined, trigger: HTMLElement) {
      if (!issue || !action) return;
      if (action.id === 'open_settings') {
        closeModal('recoveryIssuesModal');
        const checkButton = elements.storageCheckBtn;
        elements.storageSettings.open = true;
        checkButton?.scrollIntoView({ behavior:'smooth', block:'center' });
        later(() => checkButton?.focus({ preventScroll:true }), 260);
        return;
      }
      const actionToken = lifecycleGeneration;
      let actionBody: Record<string, unknown> | undefined;
      if (['redownload_with_encoding','redownload_with_quality','retry_quality_with_encoding','retry_quality_with_quality'].includes(action.id)) {
        const selected = await mediaRetry.open(issue, action, trigger, action.id.startsWith('retry_quality_') ? 'quality' : 'upload');
        if (!selected) return;
        actionBody = { strict:true };
        if (selected.quality) actionBody.quality = selected.quality;
        if (selected.encoding) actionBody.encodingPriority = mediaRetry.encodingPriority(selected.encoding);
      }
      if (action.id === 'retry_download_with_account') {
        const userId = await openRecoveryChoiceDialog(action, trigger);
        if (!userId) return;
        actionBody = { userId };
      }
      if (action.id === 'create_candidate') {
        const confirmed = await confirmAction({
          title:'生成隔离候选',
          message:'系统会把当前完整文件组上传到独立候选目录。',
          detail:'正式旧路径不会覆盖、移动或删除；该操作会占用额外远端空间和上传流量，完整验证后再让你选择保留哪一份。',
          confirmText:'生成候选',
          danger:false,
          trigger,
        });
        if (!confirmed) return;
      }
      if (action.id === 'retry_download') {
        const confirmed = await confirmAction({
          title:'重新下载一次',
          message:'重置这个任务的失败次数并重新进入下载队列。',
          detail:'已有本地进度、收藏来源和远端目标保持不变；不会删除任何归档。',
          confirmText:'重新下载',
          danger:false,
          trigger,
        });
        if (!confirmed) return;
      }
      if (action.id === 'abandon_attempt') {
        const confirmed = await confirmAction({
          title:'停止本次尝试',
          message:'结束当前恢复尝试并从待处理中心移除。',
          detail:'只停止自动执行，不删除本地文件或远端文件。当前仍存在的文件会继续占用空间，当前尝试的文件不会自动用于播放。',
          confirmText:'停止本次尝试',
          danger:true,
          trigger,
        });
        if (!confirmed) return;
      }
      if (action.id === 'reupload' || action.id === 'redownload') {
        const reupload = action.id === 'reupload';
        const confirmed = await confirmAction({
          title:reupload ? '确认继续上传' : '确认重新下载',
          message:reupload
            ? '系统会重新检查远端，只为当前任务授权一次上传。'
            : '系统会废弃失效的补传尝试并重新下载这个来源。',
          detail:reupload
            ? '发现同名异大小文件时仍会停止，不会直接覆盖。'
            : '不会删除远端文件；其他已验证来源和归档证明不受影响。',
          confirmText:reupload ? '继续上传' : '重新下载',
          danger:reupload,
          trigger,
        });
        if (!confirmed) return;
      }
      if (action.id === 'keep_existing' || action.id === 'use_candidate') {
        const useCandidate = action.id === 'use_candidate';
        const confirmed = await confirmAction({
          title:useCandidate ? '采用新候选' : '保留现有归档',
          message:useCandidate
            ? '将已验证的新候选设为这个收藏来源的当前可播放归档。'
            : '继续使用SQLite中记录的现有归档证明。',
          detail:useCandidate
            ? '正式旧路径不会移动或删除，候选文件也不会依赖MOVE。'
            : '独立候选目录仍会保留，系统不会自动删除其中的文件。',
          confirmText:useCandidate ? '采用候选' : '保留现有',
          danger:false,
          trigger,
        });
        if (!confirmed) return;
      }
      if (actionToken !== lifecycleGeneration) return false;
      const controller = new AbortController();
      actionRequests.add(controller);
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.recovery-issues-detail button'));
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const data = await api.request('/api/recovery-issues/' + encodeURIComponent(issue.id) + '/actions/' + encodeURIComponent(action.id), {
          method:'POST', signal:controller.signal,
          ...(actionBody ? { headers:{'Content-Type':'application/json'}, body:JSON.stringify(actionBody) } : {}),
        });
        if (actionToken !== lifecycleGeneration || controller.signal.aborted) return false;
        queueSnapshots.applyIssueUpdate(data);
        elements.recoveryIssuesLive.textContent = action.label + '已执行，待处理列表已更新。';
        showToast(action.label + '已执行', 'success');
    } catch (error) {
        // boundary-critical: surface the action error unless the request is stale or cancelled.
        if (actionToken !== lifecycleGeneration || controller.signal.aborted) return false;
        buttons.forEach((button) => { button.disabled = false; });
        if (!(error instanceof Error && error.name === 'AbortError')) showToast(error instanceof Error ? error.message : '处理失败', 'error');
        return false;
      } finally { actionRequests.delete(controller);
      }
    }

    function renderRecoveryIssueDetail() {
      const host = elements.recoveryIssuesDetail;
      host.innerHTML = '';
      if (recoveryIssueState.items.length === 0) return;
      const issue = recoveryIssueState.items.find((item) => item.id === recoveryIssueState.selectedId);
      if (!issue) {
        const empty = document.createElement('div');
        empty.className = 'recovery-issues-empty';
        empty.textContent = '从左侧选择一项查看详情。';
        host.appendChild(empty);
        return;
      }
      const kicker = document.createElement('div');
      kicker.className = 'recovery-detail-kicker ' + (issue.severity || 'info');
      kicker.textContent = recoveryIssueStatusLabel(issue);
      const heading = document.createElement('h2');
      heading.className = 'recovery-detail-title';
      heading.textContent = recoveryIssueTargetTitle(issue);
      const problem = document.createElement('p');
      problem.className = 'recovery-detail-problem';
      problem.textContent = recoveryIssueTypeLabel(issue);
      const meta = document.createElement('div');
      meta.className = 'recovery-detail-meta';
      meta.textContent = issue.occurredAt ? '发生于 ' + formatDateTime(issue.occurredAt) : '';
      host.append(kicker, heading, problem, meta);

      const targetCard = document.createElement('div');
      targetCard.className = 'recovery-target-card';
      const targetFields = [
        ['来源收藏夹', issue.folderTitle || '系统级任务'],
        ['UP主 / BV', recoveryIssueTargetMeta(issue)],
        ['文件', issue.fileName || '未指定'],
      ];
      if (Number.isFinite(Number(issue.expectedSize)) || Number.isFinite(Number(issue.observedSize))) {
        const expected = Number.isFinite(Number(issue.expectedSize)) ? formatBytes(Number(issue.expectedSize)) : '未知';
        const observed = Number.isFinite(Number(issue.observedSize)) ? formatBytes(Number(issue.observedSize)) : '未知';
        targetFields.push(['大小', expected + ' / 远端 ' + observed]);
      }
      targetFields.forEach(([label, value]) => {
        const field = document.createElement('div');
        field.className = 'recovery-target-field';
        const fieldLabel = document.createElement('span');
        fieldLabel.className = 'recovery-target-field-label';
        fieldLabel.textContent = label;
        const fieldValue = document.createElement('strong');
        fieldValue.className = 'recovery-target-field-value';
        fieldValue.textContent = String(value);
        field.append(fieldLabel, fieldValue);
        targetCard.appendChild(field);
      });
      host.appendChild(targetCard);

      const summary = document.createElement('p');
      summary.textContent = issue.summary || '任务已安全暂停。';
      if (issue.severity === 'danger') summary.setAttribute('role', 'alert');
      appendRecoveryDetailSection(host, '发生了什么', summary);

      const protectedList = document.createElement('ul');
      protectedList.className = 'recovery-protected-list';
      (issue.protectedFacts || []).forEach((fact) => {
        const item = document.createElement('li');
        item.textContent = String(fact);
        protectedList.appendChild(item);
      });
      if (protectedList.childElementCount) appendRecoveryDetailSection(host, '系统保护了什么', protectedList);
      if (issue.busy) {
        const busyNote = document.createElement('p');
        busyNote.className = 'recovery-safety-note';
        busyNote.textContent = '替换下载、上传或远端确认正在进行。替换流程不会主动清理旧文件，期间不能重复启动另一种编码。';
        appendRecoveryDetailSection(host, '当前进度', busyNote);
      } else if (issue.recommendedAction) {
        const actions = document.createElement('div');
        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'recovery-primary-action' + (issue.recommendedAction.danger ? ' danger-action' : '');
        primary.textContent = issue.recommendedAction.label;
        primary.title = issue.recommendedAction.description || '';
        primary.addEventListener('click', () => void runRecoveryIssueAction(issue, issue.recommendedAction, primary));
        actions.appendChild(primary);
        const secondaryActions = (issue.availableActions || []).filter((action) => action.id !== issue.recommendedAction?.id);
        if (secondaryActions.length > 0) {
          const secondary = document.createElement('div');
          secondary.className = 'recovery-secondary-actions';
          secondaryActions.forEach((action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.title = action.description || '';
            button.addEventListener('click', () => void runRecoveryIssueAction(issue, action, button));
            secondary.appendChild(button);
          });
          actions.appendChild(secondary);
        }
        const description = document.createElement('p');
        description.className = 'muted status-line recovery-action-note';
        description.textContent = issue.recommendedAction.description || '';
        actions.appendChild(description);
        appendRecoveryDetailSection(host, '下一步', actions);
      }

      const technical = document.createElement('details');
      technical.className = 'recovery-technical';
      const technicalSummary = document.createElement('summary');
      technicalSummary.textContent = '技术详情';
      const grid = document.createElement('div');
      grid.className = 'recovery-technical-grid';
      const technicalRows = [
        ['问题类型', recoveryIssueTypeLabel(issue)],
        ['最近复核', issue.checkedAt ? formatDateTime(issue.checkedAt) : '尚未复核'],
        ['下次自动复核', issue.nextAutomaticCheckAt ? formatDateTime(issue.nextAutomaticCheckAt) : '按需复核'],
        ...(issue.requestedQuality ? [['请求画质', issue.requestedQuality + (issue.qualityMismatch ? '（未满足）' : '')]] : []),
        ...(issue.actualQualities?.length ? [['实际画质', issue.actualQualities.join('、')]] : []),
        ...(issue.requestedEncoding ? [['请求编码', issue.requestedEncoding + (issue.encodingMismatch ? '（未满足）' : '')]] : []),
        ...(issue.actualEncodings?.length ? [['实际编码', issue.actualEncodings.join('、')]] : []),
        ['文件', issue.fileName || '未指定'],
        ['期望大小', Number.isFinite(Number(issue.expectedSize)) ? formatBytes(Number(issue.expectedSize)) : '未知'],
        ['远端大小', Number.isFinite(Number(issue.observedSize)) ? formatBytes(Number(issue.observedSize)) : '未知'],
      ];
      technicalRows.forEach(([label, value]) => {
        const row = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = label + '：';
        row.append(strong, document.createTextNode(String(value)));
        grid.appendChild(row);
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'recovery-copy-diagnostic';
      copy.textContent = '复制诊断摘要';
      copy.addEventListener('click', async () => {
        const copied = await copyTextToClipboard(issue.safeDiagnostic || '');
        showToast(copied ? '诊断摘要已复制' : '复制失败', copied ? 'success' : 'error');
      });
      technical.append(technicalSummary, grid, copy);
      host.appendChild(technical);
    }

    function renderRecoveryIssueCenter() {
      renderRecoveryIssueStatus();
      renderRecoveryIssueList();
      renderRecoveryIssueDetail();
    }

    async function refreshRecoveryIssues() {
      if (recoveryIssueRequestInFlight) return;
      recoveryIssueRequestInFlight = true;
      if (recoveryIssueState.controller) recoveryIssueState.controller.abort();
      const controller = new AbortController();
      const token = ++recoveryIssueState.token;
      recoveryIssueState.controller = controller;
      try {
        const snapshot = await queueSnapshots.request(controller.signal);
        if (token !== recoveryIssueState.token) return false;

      // boundary-critical: retain the last valid issue list and expose a retry
      // state; a failed read never becomes an empty recovery center.
      } catch (error) {
        // boundary-critical: retain the last known list and surface the read failure.
        if (token !== recoveryIssueState.token) return false;
        if (!(error instanceof Error && error.name === 'AbortError') && elements.recoveryIssuesModal?.classList.contains('active')) {
          recoveryIssueState.error = '待处理问题加载失败，已有列表会保留；请点击“重试”再次加载。';
          elements.recoveryIssuesLive.textContent = '待处理问题加载失败，请稍后重试。';
          renderRecoveryIssueCenter();
        } else if (!(error instanceof Error && error.name === 'AbortError')) {
          recoveryIssueState.error = '待处理问题加载失败，已有列表会保留；请打开面板后重试。';
        }
        return false;
      } finally {
        if (token === recoveryIssueState.token) {
          recoveryIssueState.controller = null;
          recoveryIssueRequestInFlight = false;
        }
        if (token === recoveryIssueState.token && elements.recoveryIssuesModal?.classList.contains('active')) {
          renderRecoveryIssueStatus();
        }
      }
    }

    function openRecoveryIssues(trigger: HTMLElement | null, focusId: string | null = null) {
      recoveryIssueState.focusId = focusId || null;
      document.querySelector<HTMLElement>('.recovery-issues-shell')?.classList.remove('show-detail');
      openModal('recoveryIssuesModal', trigger);
      renderRecoveryIssueCenter();
      void refreshRecoveryIssues();
    }

    function startRecoveryIssuePolling() {
      if (recoveryIssuePollTimer) clearInterval(recoveryIssuePollTimer);
      if (document.hidden) return;
      if (!boardActive()) void refreshRecoveryIssues();
      recoveryIssuePollTimer = setInterval(() => {
        if (!boardActive()) void refreshRecoveryIssues();
      }, 10_000);
    }

    function stopRecoveryIssuePolling() {
      if (recoveryIssuePollTimer) {
        clearInterval(recoveryIssuePollTimer);
        recoveryIssuePollTimer = null;
      }
    }


  function deactivateChoice() {
    const pending = recoveryChoiceDialogState; recoveryChoiceDialogState = null; pending?.resolve(null);
  }
  function deactivate() {
    lifecycleGeneration++;
    recoveryIssueState.controller?.abort(); recoveryIssueState.controller = null;
    recoveryIssueRequestInFlight = false; recoveryIssueState.token++;
    for (const controller of actionRequests) controller.abort();
    actionRequests.clear(); busyActions.clear();
    document.querySelector('.recovery-issues-shell')?.classList.remove('show-detail');
  }
  function init() {
    if (events) return;
    events = new AbortController();
    const signal = events.signal;
    function listen(element: HTMLElement, type: string, callback: (event: Event) => void) { element.addEventListener(type, callback, {signal}); }
    listen(elements.recoveryIssuesBtn, 'click', (event) => openRecoveryIssues(elements.recoveryIssuesBtn));
    listen(elements.recoveryIssuesRetryBtn, 'click', () => void refreshRecoveryIssues());
    listen(elements.recoveryIssuesEmptyRetryBtn, 'click', () => void refreshRecoveryIssues());
    listen(elements.closeRecoveryIssuesBtn, 'click', () => closeModal('recoveryIssuesModal'));
    listen(elements.recoveryIssuesBackBtn, 'click', () => {
      document.querySelector('.recovery-issues-shell')?.classList.remove('show-detail');
      const selected = document.querySelector('.recovery-issue-row.active');
      if (selected instanceof HTMLElement) later(() => selected.focus({ preventScroll:true }), 0);
    });
    listen(elements.recoveryChoiceSubmitBtn, 'click', () => {
      if (!recoveryChoiceDialogState) return;
      const value = elements.recoveryChoiceSelect.value;
      if (!value) {
        elements.recoveryChoiceStatus.textContent = '请选择一个可用选项。';
        return;
      }
      finishRecoveryChoiceDialog(value);
    });
    listen(elements.recoveryChoiceCancelBtn, 'click', () => finishRecoveryChoiceDialog(null));

  }
  function destroy() {
    deactivate(); deactivateChoice(); stopRecoveryIssuePolling();
    events?.abort(); events=null;
    for (const timer of timers) clearTimeout(timer); timers.clear();
  }
  return {init, destroy, deactivate, deactivateChoice, receive: setRecoveryIssueItems, open: openRecoveryIssues, startPolling: startRecoveryIssuePolling, stopPolling: stopRecoveryIssuePolling};
}
