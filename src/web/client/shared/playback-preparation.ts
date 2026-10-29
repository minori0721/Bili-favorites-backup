import type { ApiClient } from './api.js';
import { ApiError } from './api.js';
import { isRecord, ResponseFormatError } from '../../../shared/api/value.js';
import { parsePlaybackPreparationTargets } from '../../../shared/api/playback-queue.js';

/** A visible library visit owns one cancellable pass, not a periodic keepalive. */
export function createArchivePlaybackPreparation(deps: {
  api: ApiClient;
  visible(): boolean;
  context(): {userId?: string | null; mediaId?: number | null};
  preparePlayer(): Promise<unknown>;
}) {
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const completed = new Set<string>();

  function stop() {
    controller?.abort(); controller = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }
  async function run(own: AbortController) {
    try {
      const context = deps.context(), params = new URLSearchParams();
      if (context.userId) params.set('userId', context.userId);
      if (context.userId && context.mediaId != null) params.set('mediaId', String(context.mediaId));
      const targets = parsePlaybackPreparationTargets(await deps.api.silent('/api/playback/preparation-targets?' + params, {signal:own.signal}));
      for (const target of targets) {
        if (own.signal.aborted || !deps.visible()) return;
        if (completed.has(target.directoryId)) continue;
        try {
          const data = await deps.api.silent(`/api/users/${encodeURIComponent(target.userId)}/favorites/${target.mediaId}/playback/files/${target.fileId}/prepare`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:'directory'}), signal:own.signal,
          });
          if (!isRecord(data) || data.prepared !== true) throw new ResponseFormatError('播放预热结果格式错误');
          completed.add(target.directoryId);
        } catch (error) {
          // A representative removed after enumeration must not stop the
          // other independent directories. Storage failures stop this pass.
          if (error instanceof ApiError && error.status === 404) continue;
          throw error;
        }
      }
    } catch (error) {
      if (!own.signal.aborted) console.debug('[Playback] library preparation stopped');
    } finally { if (controller === own) controller = null; }
  }
  return {
    stop,
    start(reset = false) {
      stop();
      if (reset) completed.clear();
      if (!deps.visible()) return;
      void deps.preparePlayer().catch(() => { console.debug('[Playback] player preloading unavailable'); });
      const own = new AbortController(); controller = own;
      timer = setTimeout(() => { timer = null; void run(own); }, 500);
    },
  };
}
