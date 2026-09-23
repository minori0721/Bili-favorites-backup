import { parseQueueBoardItem, type QueueBoardDisplayItem, type QueueBoardStage } from '../../../../shared/api/queue-item.js';
import type { QueueSnapshot } from '../../../../shared/api/queue-snapshot.js';
import { queuePhaseLabel, queueTimeLabel, makeQueueCardKey } from './queue-labels.js';

interface QueueCard extends HTMLDivElement {
  __queueItem?: QueueBoardDisplayItem;
  __queueCoverKey?: string;
  __diagnosticOpen?: boolean;
}
interface Column { root: HTMLElement; list: HTMLElement; count: HTMLElement }
interface Options {
  root: HTMLElement;
  renderStatus(grid: HTMLElement, snapshot: QueueSnapshot): void;
  renderActions(card: HTMLElement, item: QueueBoardDisplayItem): void;
}
const stages: Record<string, QueueBoardStage> = {
  downloadPending: 'download_pending', downloadRunning: 'download_running',
  uploadPending: 'upload_pending', uploadRunning: 'upload_running',
};
function safeText(value: unknown, fallback = '未知') { return String(value ?? '').trim() || fallback; }
function localCoverUrl(item: QueueBoardDisplayItem) {
  const path = (item.coverLocalPath || '').trim();
  return path ? '/' + path.split('/').filter(Boolean).join('/') : '';
}
export function createQueueBoardView({ root, renderStatus, renderActions }: Options) {
  const document = root.ownerDocument;
  const queueBoardState: { columns: Record<string, Column>; cards: Map<string, QueueCard>; renderLimit: number } = {
    columns: {}, cards: new Map(), renderLimit: 80,
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const frames = new Set<number>();
  const animations = new Set<Animation>();
  function later(callback: () => void, delay: number) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  }
    function updateQueueCover(card: QueueCard, item: QueueBoardDisplayItem) {
      const label = safeText(item.title || item.bvid, '视频封面');
      const urls = [localCoverUrl(item), typeof item.cover === 'string' ? item.cover.trim().replace('http://', 'https://') : '']
        .filter(Boolean).map((value) => { try { return new URL(value, location.href).href; } catch { return ''; } }).filter(Boolean);
      const candidates = Array.from(new Set(urls));
      const key = JSON.stringify(candidates);
      const current = card.querySelector<HTMLElement>('.queue-cover');
      if (current instanceof HTMLImageElement) current.alt = label;
      if (card.__queueCoverKey === key) return;
      card.__queueCoverKey = key;
      function placeholder() {
        const cover = document.createElement('div');
        cover.className = 'queue-cover';
        cover.textContent = '封面';
        cover.setAttribute('aria-hidden', 'true');
        card.querySelector<HTMLElement>('.queue-cover')?.replaceWith(cover);
      }
      if (!candidates.length) { placeholder(); return; }
      const img = document.createElement('img');
      img.className = 'queue-cover';
      img.alt = label;
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      let index = 0;
      img.onerror = () => {
        if (card.__queueCoverKey !== key || !card.contains(img)) return;
        if (++index < candidates.length) img.src = candidates[index];
        else { img.onerror = null; placeholder(); }
      };
      current?.replaceWith(img);
      img.src = candidates[0];
    }

    function updateQueueCard(card: QueueCard, item: QueueBoardDisplayItem, nowMs: number) {
      card.__queueItem = item;
      card.dataset.queueStage = item.stage || '';
      card.dataset.queuePhase = item.phase || '';
      const titleEl = card.querySelector<HTMLElement>('.queue-title');
      const metaEl = card.querySelector<HTMLElement>('.queue-meta');
      const extraEl = card.querySelector<HTMLElement>('.queue-extra');
      updateQueueCover(card, item);
      if (titleEl) {
        titleEl.textContent = safeText(item.title || item.bvid, '未知任务');
        titleEl.title = safeText(item.title || item.bvid, '未知任务');
      }
      if (metaEl) {
        const folder = item.folderTitle ? ' · 收藏夹：' + safeText(item.folderTitle, '') : '';
        metaEl.textContent = safeText(item.upperName || item.ownerName, '未知UP') + ' · ' + safeText(item.bvid, '-') + folder;
      }
      if (extraEl) {
        extraEl.innerHTML = '';
        if (item.detail || queuePhaseLabel(item)) {
          const phase = queuePhaseLabel(item);
          if (phase && item.detail && String(item.detail) !== phase) {
            const stage = document.createElement('span');
            stage.className = 'queue-phase';
            stage.textContent = phase;
            extraEl.appendChild(stage);
          }
          const detail = document.createElement('span');
          detail.className = 'queue-status';
          detail.textContent = String(item.detail || queuePhaseLabel(item));
          if (item.detail && (String(item.detail).length > 80 || /HTTP|ENOENT|failed|Error:/.test(String(item.detail)))) {
            const diagnostic = document.createElement('details');
            diagnostic.className = 'queue-diagnostic';
            diagnostic.open = Boolean(card.__diagnosticOpen);
            diagnostic.addEventListener('toggle', () => { card.__diagnosticOpen = diagnostic.open; });
            const summary = document.createElement('summary');
            summary.textContent = '查看原因';
            detail.style.display = 'block';
            diagnostic.append(summary, detail);
            extraEl.appendChild(diagnostic);
          } else extraEl.appendChild(detail);
        }
        if (item.phase === 'retry_wait') {
          const retry = document.createElement('span');
          retry.className = 'queue-pill';
          retry.textContent = '重试 ' + Number(item.retries || 0) + '/' + Number(item.maxRetries || 0);
          extraEl.appendChild(retry);
        }
        const time = document.createElement('span');
        time.className = 'queue-pill';
        time.dataset.queueTime = '1';
        const timeLabel = queueTimeLabel(item, nowMs);
        time.textContent = timeLabel;
        time.hidden = timeLabel === queuePhaseLabel(item);
        extraEl.appendChild(time);
      }
      renderActions(card, item);
    }

    function updateQueueBoardClock() {
      const nowMs = Date.now();
      for (const card of queueBoardState.cards.values()) {
        const item = card.__queueItem;
        const time = card.querySelector<HTMLElement>('[data-queue-time="1"]');
        if (item && time) {
          const label = queueTimeLabel(item, nowMs);
          time.textContent = label;
          time.hidden = label === queuePhaseLabel(item);
        }
      }
    }

    function renderQueueCard(item: QueueBoardDisplayItem, nowMs: number) {
      const card: QueueCard = document.createElement('div');
      card.className = 'queue-card';
      card.dataset.queueKey = makeQueueCardKey(item);
      const cover = document.createElement('div');
      cover.className = 'queue-cover';
      card.appendChild(cover);
      const info = document.createElement('div');
      info.className = 'queue-info';
      const title = document.createElement('div');
      title.className = 'queue-title';
      title.textContent = safeText(item.title || item.bvid, '未知任务');
      title.title = safeText(item.title || item.bvid, '未知任务');
      const meta = document.createElement('div');
      meta.className = 'queue-meta';
      const extra = document.createElement('div');
      extra.className = 'queue-extra';
      info.appendChild(title);
      info.appendChild(meta);
      info.appendChild(extra);
      card.appendChild(info);
      updateQueueCard(card, item, nowMs);
      return card;
    }

    function ensureQueueColumn(parent: HTMLElement, id: string, title: string): Column {
      const existing = queueBoardState.columns[id];
      if (existing && existing.root && existing.root.parentElement === parent) {
        return existing;
      }
      const initial = parent.querySelector<HTMLElement>('[data-queue-column="' + id + '"]');
      if (initial) {
        const column = { root: initial, list: initial.querySelector<HTMLElement>('.queue-list')!, count: initial.querySelector<HTMLElement>('.queue-col-count')! };
        queueBoardState.columns[id] = column;
        return column;
      }
      const col = document.createElement('div');
      col.className = 'queue-col';
      col.dataset.queueColumn = id;
      const h = document.createElement('div');
      h.className = 'queue-col-title';
      const left = document.createElement('span');
      left.textContent = title;
      const right = document.createElement('span');
      right.className = 'queue-col-count';
      right.textContent = '0';
      h.appendChild(left);
      h.appendChild(right);
      col.appendChild(h);
      const list = document.createElement('div');
      list.className = 'queue-list';
      col.appendChild(list);
      parent.appendChild(col);
      queueBoardState.columns[id] = { root: col, list, count: right };
      return queueBoardState.columns[id];
    }

    function setQueueEmptyState(column: Column, isEmpty: boolean) {
      let empty = column.list.querySelector<HTMLElement>('[data-queue-empty="1"]');
      if (isEmpty) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'queue-empty';
          empty.dataset.queueEmpty = '1';
          empty.textContent = '空队列';
          column.list.appendChild(empty);
        }
      } else if (empty) {
        empty.remove();
      }
    }

    function renderQueueColumn(parent: HTMLElement, id: string, title: string, items: Record<string, unknown>[], nowMs: number, seenKeys: Set<string>) {
      const column = ensureQueueColumn(parent, id, title);
      column.list.querySelector('[data-queue-loading="1"]')?.remove();
      const allItems = items.map(item => parseQueueBoardItem(item, stages[id] ?? 'download_pending'));
      const visibleItems = allItems.slice(0, queueBoardState.renderLimit);
      column.count.textContent = String(allItems.length);
      setQueueEmptyState(column, visibleItems.length === 0);
      const oldMore = column.list.querySelector('[data-queue-more="1"]');
      if (oldMore) oldMore.remove();
      visibleItems.forEach((item) => {
        const key = makeQueueCardKey(item);
        seenKeys.add(key);
        let card = queueBoardState.cards.get(key);
        if (!card) {
          card = renderQueueCard(item, nowMs);
          card.classList.add('entering');
          queueBoardState.cards.set(key, card);
          const entered = card;
          later(() => entered.classList.remove('entering'), 260);
        } else {
          updateQueueCard(card, item, nowMs);
        }
        column.list.appendChild(card);
      });
      if (allItems.length > visibleItems.length) {
        const more = document.createElement('div');
        more.className = 'queue-more';
        more.dataset.queueMore = '1';
        more.textContent = '还有 ' + (allItems.length - visibleItems.length) + ' 个任务未展开';
        column.list.appendChild(more);
      }
    }

    function animateQueueBoard(firstRects: Map<string, DOMRect>) {
      for (const [key, card] of queueBoardState.cards.entries()) {
        const first = firstRects.get(key);
        if (!first || !card.isConnected) continue;
        const last = card.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        const animation = card.animate(
          [
            { transform: 'translate(' + dx + 'px,' + dy + 'px)' },
            { transform: 'translate(0,0)' }
          ],
          { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
        );
        animations.add(animation);
        animation.onfinish = () => animations.delete(animation);
      }
    }

    function renderQueueBoardSnapshot(snapshot: QueueSnapshot) {
        const board = root;
        const nowMs = Date.now();
        let grid = board.querySelector<HTMLElement>('.queue-board');
        if (!grid) {
          board.innerHTML = '';
          grid = document.createElement('div');
          grid.className = 'queue-board';
          board.appendChild(grid);
          queueBoardState.columns = {};
        }
        grid.classList.toggle('is-empty', [snapshot.downloadPending, snapshot.downloadRunning, snapshot.uploadPending, snapshot.uploadRunning].every(items => items.length === 0));
        renderStatus(grid, snapshot);
        const firstRects = new Map();
        for (const [key, card] of queueBoardState.cards.entries()) {
          if (card.isConnected) firstRects.set(key, card.getBoundingClientRect());
        }
        const seenKeys = new Set<string>();
        renderQueueColumn(grid, 'downloadPending', '待下载', snapshot.downloadPending || [], nowMs, seenKeys);
        renderQueueColumn(grid, 'downloadRunning', '下载中', snapshot.downloadRunning || [], nowMs, seenKeys);
        renderQueueColumn(grid, 'uploadPending', '待上传/收尾', snapshot.uploadPending || [], nowMs, seenKeys);
        renderQueueColumn(grid, 'uploadRunning', '上传/收尾中', snapshot.uploadRunning || [], nowMs, seenKeys);
        for (const [key, card] of Array.from(queueBoardState.cards.entries())) {
          if (seenKeys.has(key)) continue;
          queueBoardState.cards.delete(key);
          if (card.isConnected) {
            card.classList.add('leaving');
            later(() => card.remove(), 220);
          }
        }
        const frame = requestAnimationFrame(() => { frames.delete(frame); animateQueueBoard(firstRects); });
        frames.add(frame);
    }

    function resetQueueBoardView() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const frame of frames) cancelAnimationFrame(frame);
      frames.clear();
      for (const animation of animations) animation.cancel();
      animations.clear();
      queueBoardState.columns = {};
      queueBoardState.cards.clear();
      const board = root;
      if (board) {
        board.parentElement?.querySelector('[data-local-cache-status="1"]')?.remove();
        board.parentElement?.querySelector('[data-download-api-health-status="1"]')?.remove();
        board.parentElement?.querySelector('[data-upload-health-status="1"]')?.remove();
        board.innerHTML = '';
      }
    }


  return { render: renderQueueBoardSnapshot, tick: updateQueueBoardClock, reset: resetQueueBoardView, destroy: resetQueueBoardView };
}
