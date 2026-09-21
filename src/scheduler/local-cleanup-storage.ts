import type { StateManager } from '../state.js';

/** Resolve each read through the state facade; never retain a database connection across an await. */
export function createLocalCleanupStorage(state: Pick<StateManager, 'getVideoForLocalCleanup' | 'getLocalCleanupSessionStamp' | 'getLocalCleanupTrackedDirectories'>) {
  return {
    video(bvid: string) { return state.getVideoForLocalCleanup(bvid); },
    sessionStamp(bvid: string) { return state.getLocalCleanupSessionStamp(bvid); },
    trackedDirectories(bvid: string) { return state.getLocalCleanupTrackedDirectories(bvid); },
  };
}
