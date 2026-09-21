import type { StateManager } from './state.js';
import type { OnlineArchiveStateResolver } from './online-content.js';
export function createOnlineArchiveProjection(state: Pick<StateManager, 'listRelationsForBvids'>): OnlineArchiveStateResolver { return (items) => {
  const bvids = [...new Set(items.map((item) => item.bvid).filter((bvid): bvid is string => Boolean(bvid)))];
  const relations = state.listRelationsForBvids(bvids);
  const byBvid = new Map<string, typeof relations>();
  for (const relation of relations) {
    const current = byBvid.get(relation.bvid) || [];
    current.push(relation);
    byBvid.set(relation.bvid, current);
  }
  const states = new Map<string, "archived" | "processing" | "unarchived">();
  for (const bvid of bvids) {
    const currentRelations = byBvid.get(bvid) || [];
    const state = currentRelations.some((relation) => ["verified", "partial_verified"].includes(String(relation.backupStatus || ""))
      && (relation.remoteFiles || []).some((file) => file.verificationStatus === "verified" || file.verificationStatus === undefined))
      ? "archived" as const
      : currentRelations.some((relation) => ["discovered", "queued", "downloading", "downloaded", "uploading", "uploaded"].includes(String(relation.backupStatus || "")))
        ? "processing" as const
        : "unarchived" as const;
    states.set(bvid, state);
  }
  return states;
};

}
