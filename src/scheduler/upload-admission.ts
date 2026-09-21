import type { RecoveryUploadItem } from './upload-work.js';
import type { EnqueuePersistentJob, JobRepository } from '../repositories/jobs.js';
interface Dependencies {
  blocked(userId: string, mediaId: number, bvid: string): boolean;
  jobs: Pick<JobRepository, 'enqueue'>;
  build(item: RecoveryUploadItem): EnqueuePersistentJob;
  wake(): void;
}
export function createUploadAdmission(deps: Dependencies) {
  return (item: RecoveryUploadItem, dispatch = true) => {
    const mediaId = Number(item.mediaId);
    if (item.userId && Number.isInteger(mediaId) && deps.blocked(item.userId, mediaId, item.bvid)) return false;
    const result = deps.jobs.enqueue(deps.build(item));
    if (dispatch) deps.wake();
    return result.id;
  };
}
