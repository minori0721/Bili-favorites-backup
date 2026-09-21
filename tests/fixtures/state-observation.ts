import type { StateManager } from '../../src/state.js';

export function relationFor(state: Pick<StateManager, 'listRelationsForBvid'>, userId: string, mediaId: number, bvid: string) {
  return state.listRelationsForBvid(bvid).find(relation => relation.userId === userId && relation.mediaId === mediaId) ?? null;
}
