import type { PersistentJobRecord } from '../database.js';
import { sanitizeDiagnosticText } from '../diagnostics.js';
import { isRecord } from '../shared/api/value.js';

/** Read-only projection: callers provide a snapshot, never a writable store. */
export function projectQualityUpgradeState(jobs: readonly PersistentJobRecord[], targetCount: (payload: unknown) => number) {
  const running = jobs.map(job => {
    const payload = isRecord(job.payload) ? job.payload : {};
    const target = isRecord(payload.target) ? payload.target : {};
    const count = job.kind === 'quality_download' ? Math.max(1,targetCount(payload)) : 1;
    const started = job.status === 'leased' || job.status === 'running';
    return {
      key:job.kind === 'quality_download' ? `artifact:${payload.artifactKey || job.id}` : `${job.userId || payload.userId}:${job.mediaId || payload.mediaId}:${job.bvid || payload.bvid}`,
      id:job.id,
      bvid:job.bvid || payload.bvid,
      artifactKey:payload.artifactKey,
      targetCount:count,
      title:payload.videoTitle || job.bvid,
      folderTitle:job.kind === 'quality_download' && count > 1 ? `${count}个目标` : (payload.folderTitle || target.folderTitle || ''),
      userId:job.userId || payload.userId || '',
      mediaId:job.mediaId || payload.mediaId || 0,
      status:job.status === 'failed' ? 'error' : job.status === 'retry_wait' ? 'retry_wait' : started ? 'running' : 'pending',
      error:job.lastError ? sanitizeDiagnosticText(job.lastError,500) : undefined,
      stageLabel:job.kind === 'quality_cleanup' && job.status === 'retry_wait' ? '旧文件清理重试中'
        : job.kind === 'quality_download' ? `${String(payload.qualityStageLabel || '下载新版').split(' · ')[0]}${count > 1 ? ` · ${count}个目标` : ''}` : String(payload.qualityStageLabel || ''),
      queuedAt:job.createdAt,
      startedAt:started ? job.updatedAt : undefined,
    };
  });
  return {running,completed:[]};
}

export function createQualityUpgradeProjection(dependencies: {
  jobs(): readonly PersistentJobRecord[];
  targetCount(payload: unknown): number;
}) {
  return {
    getState: () => projectQualityUpgradeState(dependencies.jobs(), dependencies.targetCount),
  };
}
