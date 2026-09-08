import { parseProbeReference, parseProbeResult, type parseProbeCombination } from '../../../../shared/api/media-probe.js';
import type { ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { requireElement } from '../../shared/dom.js';
type Combination = ReturnType<typeof parseProbeCombination>;
type ProbeResult = ReturnType<typeof parseProbeResult>;
type ProbeMode = 'catalog' | 'refine';
export interface MediaAction { id: string; mediaProfile?: { quality?: boolean; encoding?: boolean } }
export interface MediaIssue { userId?: string; bvid?: string; requestedQuality?: string; requestedEncoding?: string }
export interface MediaSelection { quality: string; encoding: string; strict: boolean }
interface DialogState {
  resolve(value: MediaSelection | null): void; issue: MediaIssue; action: MediaAction; trigger: HTMLElement | null; mode: 'upload' | 'quality';
  allowQuality: boolean; allowEncoding: boolean; combinations: Combination[]; selected: Combination | null; manual: boolean;
  latestResult: ProbeResult | null; probeMessage: string; probeError: boolean; catalogFinished: boolean; probeToken: number;
  probeController: AbortController | null; pollTimer: ReturnType<typeof setTimeout> | null; refineTimer: ReturnType<typeof setTimeout> | null;
  activeProbe: {mode: ProbeMode; targetKey: string} | null; queuedRefineKey: string | null; refinementPendingKey: string | null;
  refinedKeys: Set<string>; unknownSizeKeys: Set<string>; sizeConfirmationKey: string | null; confirmingUnknownSize: boolean;
}
interface Options {
  root: HTMLElement; api: ApiClient; confirmAction: ConfirmAction; formatBytes(value: number): string;
  openModal(id: string, trigger?: HTMLElement | null): void;
  closeModal(id: string, options?: {restoreFocus?: boolean}): unknown;
}
export function createMediaRetryDialog({root, api, confirmAction, formatBytes, openModal, closeModal}: Options) {
  const document = root.ownerDocument;
  const elements = {
    encodingRetryQuality: requireElement(root, '#encodingRetryQuality', HTMLSelectElement),
    encodingRetryEncoding: requireElement(root, '#encodingRetryEncoding', HTMLSelectElement),
    encodingRetrySubmitBtn: requireElement(root, '#encodingRetrySubmitBtn', HTMLButtonElement),
    encodingRetryEstimate: requireElement(root, '#encodingRetryEstimate', HTMLElement),
    encodingRetryCombinations: requireElement(root, '#encodingRetryCombinations', HTMLElement),
    encodingRetryManual: requireElement(root, '#encodingRetryManual', HTMLElement),
    encodingRetryProbeSummary: requireElement(root, '#encodingRetryProbeSummary', HTMLElement),
    encodingRetryQualityField: requireElement(root, '#encodingRetryQualityField', HTMLElement),
    encodingRetryEncodingField: requireElement(root, '#encodingRetryEncodingField', HTMLElement),
    encodingRetryProbeBtn: requireElement(root, '#encodingRetryProbeBtn', HTMLButtonElement),
    encodingRetryTitle: requireElement(root, '#encodingRetryTitle', HTMLElement),
    encodingRetryCopy: requireElement(root, '#encodingRetryCopy', HTMLElement),
    encodingRetryStatus: requireElement(root, '#encodingRetryStatus', HTMLElement),
    encodingRetryStrict: requireElement(root, '#encodingRetryStrict', HTMLInputElement),
    encodingRetryCancelBtn: requireElement(root, '#encodingRetryCancelBtn', HTMLButtonElement),
  };
  let encodingRetryDialogState: DialogState | null = null;
  let events: AbortController | null = null;
    const MEDIA_RETRY_QUALITY_ORDER = ['8K','杜比视界','HDR','4K','1080P60','1080P+','1080P','720P60','720P','480P','360P'];
    const MEDIA_RETRY_ENCODING_ORDER = ['HEVC','AVC','AV1'];

    function recoveryActionMediaProfile(action: MediaAction) {
      if (action?.mediaProfile) {
        return {
          quality:Boolean(action.mediaProfile.quality),
          encoding:Boolean(action.mediaProfile.encoding),
        };
      }
      const id = String(action?.id || '');
      return {
        quality:id === 'redownload_with_quality' || id === 'retry_quality_with_quality',
        encoding:id === 'redownload_with_encoding' || id === 'retry_quality_with_encoding',
      };
    }

    function cleanupEncodingRetryDialog(state = encodingRetryDialogState) {
      if (!state) return;
      state.probeToken = Number(state.probeToken || 0) + 1;
      if (state.probeController) state.probeController.abort();
      if (state.pollTimer) clearTimeout(state.pollTimer);
      if (state.refineTimer) clearTimeout(state.refineTimer);
      state.probeController = null;
      state.pollTimer = null;
      state.refineTimer = null;
      state.activeProbe = null;
      state.queuedRefineKey = null;
      state.refinementPendingKey = null;
      state.refinedKeys?.clear?.();
      state.unknownSizeKeys?.clear?.();
    }

    function mediaRetryCombinationKey(combination: Combination | null) {
      return [String(combination?.quality || combination?.bilibiliQuality || '').trim(), String(combination?.encoding || '').trim()].join(':');
    }

    function mediaRetrySourceLabel(source: unknown) {
      const labels: Record<string, string> = {
        api:'接口大小',
        bitrate_estimate:'码率估算',
        head:'HEAD 精确大小',
        range:'Range 精确大小',
        mixed:'混合来源',
      };
      return labels[String(source || '')] || '大小来源未知';
    }

    function mediaRetryFpsLabel(value: unknown) {
      const fps = Number.parseFloat(String(value || ''));
      if (!Number.isFinite(fps) || fps <= 0) return '';
      return (fps >= 49.5 ? Math.round(fps) : Math.round(fps * 100) / 100) + 'fps';
    }

    function mediaRetryCombinationBytes(combination: Combination | null) {
      for (const value of [combination?.totalBytes, combination?.totalVideoBytes, combination?.estimatedBytes]) {
        const bytes = Number(value || 0);
        if (Number.isFinite(bytes) && bytes > 0) return bytes;
      }
      return 0;
    }

    function mediaRetryCombinationHasExactSize(combination: Combination | null) {
      if (!combination) return false;
      if (combination.totalSizeConfidence === 'exact') return true;
      return combination.totalBytesKind === 'final'
        && ['api', 'head', 'range'].includes(String(combination.totalSizeSource || combination.sizeSource || ''));
    }

    function mediaRetryEncodingPriority(encoding: string) {
      const selected = String(encoding || '').toUpperCase();
      return [selected, ...MEDIA_RETRY_ENCODING_ORDER].filter((value, index, values) => value && values.indexOf(value) === index);
    }

    function currentEncodingRetrySelection() {
      const state = encodingRetryDialogState;
      if (!state) return null;
      if (state.selected) {
        return {
          quality:state.allowQuality ? String(state.selected.quality || state.selected.bilibiliQuality || '') : '',
          encoding:state.allowEncoding ? String(state.selected.encoding || '') : '',
          strict:true,
        };
      }
      if (!state.manual) return null;
      return {
        quality:state.allowQuality ? String(elements.encodingRetryQuality?.value || '') : '',
        encoding:state.allowEncoding ? String(elements.encodingRetryEncoding?.value || '') : '',
        strict:true,
      };
    }

    function updateEncodingRetrySelectionState() {
      const state = encodingRetryDialogState;
      if (!state) return;
      const selection = currentEncodingRetrySelection();
      const valid = Boolean(selection && ((state.allowQuality && selection.quality) || (state.allowEncoding && selection.encoding)));
      const submit = elements.encodingRetrySubmitBtn;
      const selectedKey = state.selected ? mediaRetryCombinationKey(state.selected) : '';
      const refinementPending = Boolean(
        state.activeProbe
        || state.refineTimer
        || (selectedKey && state.refinementPendingKey === selectedKey),
      );
      if (submit) {
        submit.disabled = !valid || refinementPending || Boolean(state.confirmingUnknownSize);
        submit.textContent = refinementPending
          ? '正在读取大小...'
          : (selectedKey && state.unknownSizeKeys?.has(selectedKey)) || (state.manual && !state.selected)
            ? '仍然严格尝试'
            : (state.mode === 'quality' ? '开始严格重调' : '开始严格重试');
      }
      const estimate = elements.encodingRetryEstimate;
      if (!estimate) return;
      if (!selection) {
        estimate.textContent = state.combinations.length > 0
          ? '请选择一个可用组合；系统随后会读取该组合的精确大小。'
          : '尚未取得大小信息。';
        return;
      }
      if (!state.selected) {
        estimate.textContent = state.manual
          ? '当前组合的可用性和大小尚未确认；仍可严格尝试，但可能因源不存在或空间不足而进入待处理。'
          : '请选择一个可用组合；系统随后会读取该组合的精确大小。';
        return;
      }
      const combination = state.selected;
      const bytes = mediaRetryCombinationBytes(combination);
      const kind = combination.totalBytesKind === 'final' ? '预计成品' : '预计视频流';
      const coverage = Number(combination.pageCount || 0) > 1
        ? ' · 分P覆盖 ' + Number(combination.availablePageCount || 0) + '/' + Number(combination.pageCount || 0)
        : '';
      const source = mediaRetrySourceLabel(combination.totalSizeSource || combination.sizeSource);
      const peakBytes = Number(combination.peakBytes || 0);
      const availableBytes = Number(state.latestResult?.cacheAvailableBytes);
      const peak = peakBytes > 0 ? ' · 本地峰值约 ' + formatBytes(peakBytes) : '';
      const capacity = Number.isFinite(availableBytes) && availableBytes >= 0 ? ' · 缓存可用 ' + formatBytes(availableBytes) : '';
      const warning = Number.isFinite(availableBytes) && peakBytes > availableBytes ? ' · 空间可能不足' : '';
      const confidence = mediaRetryCombinationHasExactSize(combination)
        ? ''
        : ' · 大小仍需人工确认';
      estimate.textContent = (bytes > 0 ? kind + ' ' + formatBytes(bytes) : '大小仍待确认') + '（' + source + '）' + coverage + peak + capacity + warning + confidence;
    }

    function renderEncodingRetryCombinations() {
      const state = encodingRetryDialogState;
      if (!state) return;
      const host = elements.encodingRetryCombinations;
      const manual = elements.encodingRetryManual;
      const summary = elements.encodingRetryProbeSummary;
      if (!host || !manual || !summary) return;
      summary.textContent = state.probeMessage || '正在读取当前可用媒体组合...';
      summary.classList.toggle('error', Boolean(state.probeError));
      host.innerHTML = '';
      const fixedQuality = state.allowQuality ? '' : String(state.issue?.requestedQuality || '').trim().toUpperCase();
      const fixedEncoding = state.allowEncoding ? '' : String(state.issue?.requestedEncoding || '').trim().toUpperCase();
      const canBindExactCombination = (state.allowQuality || Boolean(fixedQuality)) && (state.allowEncoding || Boolean(fixedEncoding));
      const combinations = (canBindExactCombination ? state.combinations.filter((combination) => {
        const quality = String(combination.quality || combination.bilibiliQuality || '').trim().toUpperCase();
        const encoding = String(combination.encoding || '').trim().toUpperCase();
        return (!fixedQuality || quality === fixedQuality) && (!fixedEncoding || encoding === fixedEncoding);
      }) : []).sort((left, right) => {
        const leftQuality = MEDIA_RETRY_QUALITY_ORDER.indexOf(String(left.quality || left.bilibiliQuality || ''));
        const rightQuality = MEDIA_RETRY_QUALITY_ORDER.indexOf(String(right.quality || right.bilibiliQuality || ''));
        const qualityOrder = (leftQuality < 0 ? 999 : leftQuality) - (rightQuality < 0 ? 999 : rightQuality);
        if (qualityOrder !== 0) return qualityOrder;
        return MEDIA_RETRY_ENCODING_ORDER.indexOf(String(left.encoding || '')) - MEDIA_RETRY_ENCODING_ORDER.indexOf(String(right.encoding || ''));
      });
      combinations.forEach((combination) => {
        const key = mediaRetryCombinationKey(combination);
        const available = combination.available === true;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'media-retry-combination';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(Boolean(state.selected && mediaRetryCombinationKey(state.selected) === key)));
        button.disabled = !available;
        const main = document.createElement('span');
        main.className = 'media-retry-combination-main';
        main.textContent = [combination.quality || combination.bilibiliQuality || '未知画质', combination.encoding || '未知编码'].join(' · ');
        const meta = document.createElement('span');
        meta.className = 'media-retry-combination-meta';
        const pageCount = Number(combination.pageCount || 0);
        const coverage = pageCount > 1
          ? (available ? '全部 ' + pageCount + ' 个分P' : '仅 ' + Number(combination.availablePageCount || 0) + '/' + pageCount + ' 个分P')
          : (available ? '可严格选择' : '当前不可用');
        const dimensions = document.createElement('span');
        dimensions.textContent = [combination.resolution, mediaRetryFpsLabel(combination.frameRate)].filter(Boolean).join(' · ');
        const source = document.createElement('span');
        source.textContent = [coverage, mediaRetrySourceLabel(combination.totalSizeSource || combination.sizeSource)].filter(Boolean).join(' · ');
        meta.append(dimensions, source);
        const size = document.createElement('span');
        size.className = 'media-retry-combination-size';
        const bytes = mediaRetryCombinationBytes(combination);
        size.textContent = bytes > 0 ? formatBytes(bytes) : '大小待确认';
        const copy = document.createElement('span');
        copy.className = 'media-retry-combination-copy';
        copy.append(main, document.createElement('br'), meta);
        button.append(copy, size);
         button.addEventListener('click', () => {
           if (!encodingRetryDialogState || !available) return;
           encodingRetryDialogState.selected = combination;
           encodingRetryDialogState.manual = false;
           encodingRetryDialogState.refinementPendingKey = key;
           encodingRetryDialogState.sizeConfirmationKey = null;
           renderEncodingRetryCombinations();
           queueEncodingRetryRefinement();
         });
        host.appendChild(button);
      });
      const availableCount = combinations.filter((item) => item.available === true).length;
      if (combinations.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = state.probeError ? '当前无法取得可用媒体组合。' : '正在等待探测结果。';
        host.appendChild(empty);
      }
      state.manual = state.manual || (Boolean(state.catalogFinished) && availableCount === 0) || !canBindExactCombination;
      manual.hidden = !state.manual;
      const qualityField = elements.encodingRetryQualityField;
      const encodingField = elements.encodingRetryEncodingField;
      if (qualityField) qualityField.hidden = !state.allowQuality;
      if (encodingField) encodingField.hidden = !state.allowEncoding;
      updateEncodingRetrySelectionState();
    }

    function mergeEncodingRetryCombination(state: DialogState, combination: Combination) {
      const key = mediaRetryCombinationKey(combination);
      const index = state.combinations.findIndex((item) => mediaRetryCombinationKey(item) === key);
      if (index >= 0) state.combinations[index] = combination;
      else state.combinations.push(combination);
    }

    function finishEncodingRetryProbeCycle(state: DialogState, token: number) {
      if (encodingRetryDialogState !== state || token !== state.probeToken) return;
      if (state.probeController) state.probeController = null;
      if (state.pollTimer) clearTimeout(state.pollTimer);
      state.pollTimer = null;
      state.activeProbe = null;
      const button = elements.encodingRetryProbeBtn;
      if (button) button.disabled = false;
      const queued = state.queuedRefineKey;
      state.queuedRefineKey = null;
      if (queued && state.selected && mediaRetryCombinationKey(state.selected) === queued) {
        void startEncodingRetryProbe('refine');
      } else {
        renderEncodingRetryCombinations();
      }
    }

    async function pollEncodingRetryProbe(state: DialogState, probeId: string, token: number, mode: ProbeMode, targetKey: string) {
      if (encodingRetryDialogState !== state || token !== state.probeToken) return;
      try {
        const result = parseProbeResult(await api.silent('/api/media-probe/' + encodeURIComponent(probeId), { signal:state.probeController?.signal }));
        if (encodingRetryDialogState !== state || token !== state.probeToken) return;
        if (result.status === 'running') {
          state.pollTimer = setTimeout(() => void pollEncodingRetryProbe(state, probeId, token, mode, targetKey), 700);
          return;
        }
        if (result.status === 'failed') {
          state.probeError = true;
          state.probeMessage = mode === 'refine'
            ? '精确大小读取失败：' + (result.error || '当前仍可按已探测组合严格尝试。')
            : (result.error || '媒体探测失败；仍可手动严格尝试，但当前可用性和大小未知。');
          if (mode === 'catalog') {
            state.catalogFinished = true;
            state.manual = true;
          } else if (targetKey) {
            state.refinementPendingKey = null;
            state.unknownSizeKeys?.add(targetKey);
            state.refinedKeys?.delete(targetKey);
          }
          finishEncodingRetryProbeCycle(state, token);
          return;
        }
        const combinations = Array.isArray(result.combinations) ? result.combinations : [];
        state.latestResult = result;
        state.probeError = false;
        if (mode === 'catalog') {
          state.catalogFinished = true;
          state.combinations = combinations;
          const availableCount = combinations.filter((item) => item.available === true).length;
          state.probeMessage = '已读取 ' + Number(result.pageCount || 0) + ' 个分P、' + availableCount + ' 个完整可用组合。选择后会再读取该组合的精确大小。';
          state.manual = availableCount === 0;
        } else {
          const refined = combinations.find((item) => item.available === true && mediaRetryCombinationKey(item) === targetKey);
          if (refined) {
            mergeEncodingRetryCombination(state, refined);
            if (state.selected && mediaRetryCombinationKey(state.selected) === targetKey) state.selected = refined;
            state.refinementPendingKey = null;
            state.refinedKeys?.add(targetKey);
            if (mediaRetryCombinationHasExactSize(refined)) state.unknownSizeKeys?.delete(targetKey);
            else state.unknownSizeKeys?.add(targetKey);
          } else if (targetKey) {
            state.refinementPendingKey = null;
            state.refinedKeys?.delete(targetKey);
            state.unknownSizeKeys?.add(targetKey);
          }
          state.probeMessage = refined
            ? '已更新所选组合的大小信息；可以开始严格重试。'
            : '所选组合没有覆盖全部分P，请重新选择或手动严格尝试。';
          state.probeError = !refined;
        }
        finishEncodingRetryProbeCycle(state, token);
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || encodingRetryDialogState !== state || token !== state.probeToken) return;
        state.probeError = true;
        state.probeMessage = mode === 'refine'
          ? '精确大小读取失败：' + ((error instanceof Error ? error.message : '') || '请稍后重试。')
          : ((error instanceof Error ? error.message : '') || '媒体探测失败；仍可手动严格尝试。');
        if (mode === 'catalog') {
          state.catalogFinished = true;
          state.manual = true;
        } else if (targetKey) {
          state.refinementPendingKey = null;
          state.refinedKeys?.delete(targetKey);
          state.unknownSizeKeys?.add(targetKey);
        }
        finishEncodingRetryProbeCycle(state, token);
      }
    }

    async function startEncodingRetryProbe(mode: ProbeMode = 'catalog') {
      const state = encodingRetryDialogState;
      if (!state) return;
      if (state.activeProbe) {
        if (mode === 'refine' && state.selected) state.queuedRefineKey = mediaRetryCombinationKey(state.selected);
        return;
      }
      if (!state.issue?.userId || !state.issue?.bvid) {
        state.probeError = true;
        state.manual = true;
        state.probeMessage = '当前待处理记录缺少账号或BV号，无法自动探测；可以手动严格尝试。';
        renderEncodingRetryCombinations();
        return;
      }
      const selection = mode === 'refine' ? currentEncodingRetrySelection() : null;
      if (mode === 'refine' && !state.selected) return;
      const targetKey = state.selected ? mediaRetryCombinationKey(state.selected) : '';
      if (mode === 'refine' && targetKey) {
        state.refinedKeys?.delete(targetKey);
        state.unknownSizeKeys?.delete(targetKey);
        state.refinementPendingKey = targetKey;
      }
      const controller = new AbortController();
      const token = Number(state.probeToken || 0) + 1;
      state.probeToken = token;
      state.probeController = controller;
      state.activeProbe = { mode, targetKey };
      state.probeError = false;
      state.probeMessage = mode === 'refine' ? '正在读取所选组合的精确大小...' : '正在读取当前可用画质、编码和大小...';
      const button = elements.encodingRetryProbeBtn;
      if (button) button.disabled = true;
      renderEncodingRetryCombinations();
      try {
        const started = await api.silent('/api/media-probe', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          signal:controller.signal,
          body:JSON.stringify({
            userId:state.issue.userId,
            bvid:state.issue.bvid,
            ...(mode === 'refine' && state.allowQuality && selection?.quality ? { quality:selection.quality } : {}),
            ...(mode === 'refine' && state.allowEncoding && selection?.encoding ? { encoding:selection.encoding } : {}),
            strict:mode === 'refine',
          }),
        });
        if (encodingRetryDialogState !== state || token !== state.probeToken) return;
        await pollEncodingRetryProbe(state, parseProbeReference(started), token, mode, targetKey);
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || encodingRetryDialogState !== state || token !== state.probeToken) return;
        state.probeError = true;
        state.probeMessage = (error instanceof Error ? error.message : '') || '媒体探测启动失败；仍可手动严格尝试。';
        if (mode === 'catalog') {
          state.catalogFinished = true;
          state.manual = true;
        }
        renderEncodingRetryCombinations();
        finishEncodingRetryProbeCycle(state, token);
      }
    }

    function queueEncodingRetryRefinement() {
      const state = encodingRetryDialogState;
      if (!state?.selected) return;
      if (state.refineTimer) clearTimeout(state.refineTimer);
      state.refinementPendingKey = mediaRetryCombinationKey(state.selected);
      state.refineTimer = setTimeout(() => {
        if (encodingRetryDialogState !== state || !state.selected) return;
        state.refineTimer = null;
        if (state.activeProbe) {
          state.queuedRefineKey = mediaRetryCombinationKey(state.selected);
          return;
        }
        void startEncodingRetryProbe('refine');
      }, 320);
    }

    function finishEncodingRetryDialog(result: MediaSelection | null) {
      const pending = encodingRetryDialogState;
      if (!pending) return;
      cleanupEncodingRetryDialog(pending);
      encodingRetryDialogState = null;
      closeModal('encodingRetryModal', { restoreFocus:true });
      pending.resolve(result);
    }

    function openEncodingRetryDialog(issue: MediaIssue, action: MediaAction, trigger: HTMLElement | null, mode: 'upload' | 'quality' = 'upload'): Promise<MediaSelection | null> {
      if (encodingRetryDialogState) return Promise.resolve(null);
      return new Promise((resolve) => {
        const profile = recoveryActionMediaProfile(action);
        encodingRetryDialogState = {
          resolve,
          issue,
          action,
          trigger,
          mode,
          allowQuality:profile.quality,
          allowEncoding:profile.encoding,
          combinations:[],
          selected:null,
          manual:false,
          latestResult:null,
          probeMessage:'正在读取当前可用媒体组合...',
          probeError:false,
          catalogFinished:false,
          probeToken:0,
          probeController:null,
          pollTimer:null,
          refineTimer:null,
           activeProbe:null,
           queuedRefineKey:null,
           refinementPendingKey:null,
           refinedKeys:new Set(),
           unknownSizeKeys:new Set(),
           sizeConfirmationKey:null,
           confirmingUnknownSize:false,
         };
        const title = elements.encodingRetryTitle;
        const copy = elements.encodingRetryCopy;
        const submit = elements.encodingRetrySubmitBtn;
        if (title) title.textContent = '重新选择画质与编码';
        if (copy) copy.textContent = mode === 'quality'
          ? '先读取当前可用媒体组合和大小，再生成独立的新版本。现有归档不会进入覆盖或删除流程。'
          : '先读取当前可用媒体组合和大小，再在隔离目录严格下载。原文件会保留到新文件完成远端确认。';
        if (submit) {
          submit.textContent = mode === 'quality' ? '开始严格重调' : '开始严格重试';
          submit.disabled = true;
        }
        elements.encodingRetryQuality.value = '';
        elements.encodingRetryEncoding.value = '';
        const status = elements.encodingRetryStatus;
        if (status) status.textContent = '';
        const strict = elements.encodingRetryStrict;
        if (strict) strict.checked = true;
        renderEncodingRetryCombinations();
        openModal('encodingRetryModal', trigger);
        void startEncodingRetryProbe('catalog');
      });
    }


  function deactivate() {
    const pending = encodingRetryDialogState;
    if (!pending) return;
    cleanupEncodingRetryDialog(pending);
    encodingRetryDialogState = null;
    pending.resolve(null);
  }
  function init() {
    if (events) return;
    events = new AbortController();
    const signal = events.signal;
    function listen(element: HTMLElement, event: string, callback: () => void) { element.addEventListener(event, callback, {signal}); }
    listen(elements.encodingRetrySubmitBtn, 'click', () => {
      const state = encodingRetryDialogState;
      if (!state || state.confirmingUnknownSize) return;
      const selected = currentEncodingRetrySelection();
      if (!selected || (!selected.quality && !selected.encoding)) {
        elements.encodingRetryStatus.textContent = '请选择一个可用组合，或明确选择要严格尝试的画质或编码。';
        return;
      }
      const selectedKey = state.selected ? mediaRetryCombinationKey(state.selected) : '';
      const refinementPending = Boolean(
        state.activeProbe
        || state.refineTimer
        || (selectedKey && state.refinementPendingKey === selectedKey),
      );
      if (refinementPending) {
        elements.encodingRetryStatus.textContent = '正在读取所选组合的精确大小，请稍候。';
        return;
      }
      const unknownSize = state.manual && !state.selected
        || Boolean(selectedKey && state.unknownSizeKeys?.has(selectedKey));
      if (!unknownSize || state.sizeConfirmationKey === (selectedKey || JSON.stringify(selected))) {
        finishEncodingRetryDialog(selected);
        return;
      }
      const confirmationKey = selectedKey || JSON.stringify(selected);
      state.confirmingUnknownSize = true;
      updateEncodingRetrySelectionState();
      void confirmAction({
        title: '大小尚未精确取得',
        message: '当前组合只能提供估算或大小读取失败，仍要严格尝试吗？',
        detail: '系统仍会逐分P严格校验画质和编码；如果源不存在、空间不足或实际大小异常，任务会进入待处理，原归档不会被覆盖。',
        confirmText: '仍然严格尝试',
        danger: false,
        trigger: elements.encodingRetrySubmitBtn,
      }).then((confirmed) => {
        if (encodingRetryDialogState !== state) return;
        state.confirmingUnknownSize = false;
        if (!confirmed) {
          updateEncodingRetrySelectionState();
          return;
        }
        state.sizeConfirmationKey = confirmationKey;
        finishEncodingRetryDialog(selected);
      });
    });
    listen(elements.encodingRetryProbeBtn, 'click', () => {
      if (!encodingRetryDialogState) return;
      void startEncodingRetryProbe(encodingRetryDialogState.selected ? 'refine' : 'catalog');
    });
    listen(elements.encodingRetryQuality, 'change', () => {
      if (!encodingRetryDialogState) return;
      encodingRetryDialogState.selected = null;
      encodingRetryDialogState.manual = true;
      updateEncodingRetrySelectionState();
    });
    listen(elements.encodingRetryEncoding, 'change', () => {
      if (!encodingRetryDialogState) return;
      encodingRetryDialogState.selected = null;
      encodingRetryDialogState.manual = true;
      updateEncodingRetrySelectionState();
    });
    listen(elements.encodingRetryCancelBtn, 'click', () => finishEncodingRetryDialog(null));

  }
  function destroy() { deactivate(); events?.abort(); events = null; }
  return { init, destroy, deactivate, open: openEncodingRetryDialog, encodingPriority: mediaRetryEncodingPriority };
}
