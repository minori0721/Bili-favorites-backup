import type { StateManager } from '../../src/state.js';
export function seedQueuedDownload(state: StateManager, bvid: string) {
  const now = new Date().toISOString();
  const user = {
    id: "u1",
    uid: 1,
    name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Favorites" }],
    enabled: true,
    lastLoginAt: now,
  };
  state.replaceStateSnapshot({
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: {
      [bvid]: {
        bvid,
        title: bvid,
        upperName: "Tester",
        firstSeenAt: now,
        lastSeenAt: now,
        biliStatus: "available" as const,
        backupStatus: "queued" as const,
      },
    },
    relations: {
      [`u1:1:${bvid}`]: {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Favorites",
        firstSeenAt: now,
        lastSeenAt: now,
        activeInFavorite: true,
        backupStatus: "queued" as const,
      },
    },
  });
  return user;
}
