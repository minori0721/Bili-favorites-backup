import type { PersistentJobRecord } from '../database.js';
import { logManager } from '../logger.js';
import { sanitizeDiagnosticText } from '../diagnostics.js';

export interface QualityRecoveryAdmissionDependencies<TTask> {
  build(job: PersistentJobRecord): TTask | null;
  park(jobId: string, summary: string): boolean;
  now(): number;
  log?: (entry: Parameters<typeof logManager.push>[0]) => void;
}

/** Owns the fail-closed transition when a persisted quality task is ambiguous. */
export function createQualityRecoveryAdmission<TTask>(dependencies: QualityRecoveryAdmissionDependencies<TTask>) {
  return {
    build(job: PersistentJobRecord): TTask | null {
      try {
        return dependencies.build(job);
      } catch (error) {
        const summary = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error || '画质升级任务无法恢复'), 500);
        if (!dependencies.park(job.id, summary)) {
          throw Object.assign(new Error(`Failed to persist the paused quality recovery state for job ${job.id}`), { cause: error });
        }
        (dependencies.log || logManager.push)({
          timestamp: new Date(dependencies.now()).toISOString(),
          type: 'upload',
          level: 'error',
          summary: `画质升级任务已暂停：${summary}`,
          raw: `[QualityUpgrade] paused job=${job.id} bvid=${job.bvid || ''} reason=${summary}`,
          bvid: job.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return null;
      }
    },
  };
}
