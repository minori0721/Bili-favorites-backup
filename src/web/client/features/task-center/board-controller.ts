import type { QueueSnapshot } from '../../../../shared/api/queue-snapshot.js';

export interface QueueBoardRoot {
  ownerDocument: {
    hidden: boolean;
    createElement(tagName: string): HTMLElement;
  };
  querySelector<T extends Element = HTMLElement>(selectors: string): T | null;
  querySelectorAll<T extends Element = HTMLElement>(selectors: string): Iterable<T> & { forEach(callbackfn: (value: T) => void): void };
  setAttribute(qualifiedName: string, value: string): void;
  prepend(node: Node): void;
  innerHTML: string;
}

interface Options {
  root: QueueBoardRoot;
  request(signal: AbortSignal): Promise<QueueSnapshot>;
  render(snapshot: QueueSnapshot): void;
  tick(): void;
  resetView(): void;
  loadingMarkup(): string;
  formatDateTime(value: number): string;
}

export function queueBoardRefreshDelay(snapshot: QueueSnapshot) {
  const items = [...snapshot.downloadPending, ...snapshot.downloadRunning, ...snapshot.uploadPending, ...snapshot.uploadRunning];
  if (items.some(item => item.phase === 'running' || item.phase === 'remote_verifying')) return 2_000;
  return items.length || snapshot.maintenance ? 5_000 : 15_000;
}

/** Owns the board subscription, retry timer and last successful render time. */
export function createQueueBoardController(options: Options) {
  const { root } = options;
  let active = false;
  let generation = 0;
  let request: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let lastUpdatedAt: number | undefined;

  function notice(message: string, error = false) {
    let element = root.querySelector<HTMLElement>('[data-queue-board-notice="1"]');
    if (!message) { element?.remove(); return undefined; }
    if (!element) {
      element = root.ownerDocument.createElement('div');
      element.dataset.queueBoardNotice = '1';
      root.prepend(element);
    }
    element.className = 'queue-board-notice' + (error ? ' error' : '');
    element.textContent = message;
    return element;
  }

  function schedule(delay: number) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    if (!active || root.ownerDocument.hidden) return;
    pollTimer = setTimeout(() => { pollTimer = undefined; void refresh(); }, delay);
  }

  async function refresh() {
    if (!active || request || root.ownerDocument.hidden) return;
    clearTimeout(pollTimer);
    pollTimer = undefined;
    if (!root.querySelector('.queue-board')) root.innerHTML = options.loadingMarkup();
    if (lastUpdatedAt === undefined) root.setAttribute('aria-busy', 'true');
    const token = generation;
    const controller = new AbortController();
    request = controller;
    try {
      const snapshot = await options.request(controller.signal);
      if (generation !== token || !active) return;
      options.render(snapshot);
      lastUpdatedAt = Date.now();
      root.setAttribute('aria-busy', 'false');
      notice('');
      schedule(queueBoardRefreshDelay(snapshot));
    } catch (error) {
      if (generation !== token || controller.signal.aborted) return;
      root.setAttribute('aria-busy', 'false');
      if (lastUpdatedAt !== undefined) {
        notice('更新失败，继续显示 ' + options.formatDateTime(lastUpdatedAt) + ' 的状态；稍后自动重试。', true);
      } else {
        const element = notice('队列看板暂时无法加载，稍后自动重试。', true);
        root.querySelectorAll('[data-queue-loading="1"]').forEach(item => { item.textContent = '暂未取得任务状态'; });
        const retry = root.ownerDocument.createElement('button');
        retry.setAttribute('type', 'button');
        retry.textContent = '重试';
        retry.addEventListener('click', () => { void refresh(); });
        element?.appendChild(retry);
      }
      schedule(10_000);
    } finally {
      if (generation === token) request = undefined;
    }
  }

  function stop() {
    active = false;
    generation += 1;
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    pollTimer = undefined;
    clockTimer = undefined;
    request?.abort();
    request = undefined;
    root.setAttribute('aria-busy', 'false');
  }

  function start() {
    if (active || root.ownerDocument.hidden) return;
    active = true;
    clockTimer = setInterval(options.tick, 1_000);
    void refresh();
  }

  function reset() {
    stop();
    lastUpdatedAt = undefined;
    options.resetView();
  }

  return { start, stop, refresh, reset, destroy: reset };
}
