import type { StateManager } from '../state.js';
import type { BiliUser } from '../users.js';
interface Dependencies {
  users(): BiliUser[];
  eligible(user: BiliUser): boolean;
  limit(): number;
  state: Pick<StateManager, 'runBatch' | 'listRetryCandidatesForFolder'>;
  enqueue(user: BiliUser, mediaId: number, folderTitle: string, bvid: string): boolean;
}

/** A cycle has one budget across all eligible accounts and folders. */
export function createRetryPendingRecovery(deps: Dependencies) {
  function run() {
    let remaining = Math.max(1, deps.limit() || 20);
    let queued = 0;
    deps.state.runBatch(() => {
      for (const user of deps.users().filter(deps.eligible)) {
        for (const folder of user.favorites) {
          if (remaining <= 0) return;
          for (const bvid of deps.state.listRetryCandidatesForFolder(user.id, folder.mediaId, remaining)) {
            if (remaining <= 0) return;
            if (deps.enqueue(user, folder.mediaId, folder.title, bvid)) {
              queued++;
              remaining--;
            }
          }
        }
      }
    });
    return queued;
  }
  return { run };
}

export function requeueRetryPending(deps: Dependencies) {
  return createRetryPendingRecovery(deps).run();
}
