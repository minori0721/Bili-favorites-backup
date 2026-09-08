import type { QueueBoardItem } from '../../../../shared/api/queue-item.js';

    export function formatElapsed(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) return '0s';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + 'm ' + s + 's';
    }

    export function queuePhaseLabel(item: Partial<QueueBoardItem>) {
      const phase = item.phase || '';
      if (item.lifecycleState === 'conflict_candidate') return '正在生成隔离候选';
      if (item.lifecycleState === 'remote_visibility_wait') return '等待远端确认';
      if (item.lifecycleState === 'partial_upload') return '部分分P';
      if (item.lifecycleState === 'manual_required') return '等待处理';
      if (phase === 'running') return item.stage === 'download_running' ? '正在下载' : '正在上传';
      if (phase === 'remote_verifying') return '正在确认远端';
      if (phase === 'retry_wait') return '等待重试';
      if (phase === 'background_wait') return '等待系统复核';
      if (phase === 'manual_action') return '等待处理';
      if (phase === 'leased') return '已领取，等待执行';
      return '排队等待';
    }

    export function queueTimeLabel(item: Partial<QueueBoardItem>, nowMs: number) {
      const nextAt = Number(item.nextActionAt || 0);
      if (nextAt > 0) {
        if (nextAt > nowMs) {
          const prefix = item.nextAction === 'recheck' ? '约 ' : '';
          const action = item.nextAction === 'recheck'
            ? '后自动复核'
            : item.nextAction === 'verify' ? '后确认' : '后重试';
          return prefix + formatElapsed(nextAt - nowMs) + action;
        }
        if (item.nextAction === 'recheck') return '复核时间已到，等待调度';
        return item.nextAction === 'verify' ? '等待确认调度' : '等待重试调度';
      }
      if (item.phase === 'running' || item.phase === 'remote_verifying') {
        const startedAt = Number(item.startedAt || 0);
        return startedAt > 0 ? '已运行 ' + formatElapsed(Math.max(0, nowMs - startedAt)) : '正在处理';
      }
      if (item.phase === 'queued' && Number(item.queuedAt || 0) > 0) {
        return '已等待 ' + formatElapsed(Math.max(0, nowMs - Number(item.queuedAt)));
      }
      return item.phase === 'background_wait' ? '等待系统复核' : '等待处理';
    }

    export function makeQueueCardKey(item: Partial<QueueBoardItem>) {
      const userId = item.userId || '';
      const mediaId = item.mediaId || '';
      const bvid = item.bvid || item.id || '';
      const remotePath = item.remotePath || '';
      return [userId, mediaId, bvid, remotePath].join(':');
    }
