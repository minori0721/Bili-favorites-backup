import type { StateFile } from '../../src/state.js';
export function verificationState(localDir: string): StateFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: {
      BVVERIFY: { bvid: "BVVERIFY", title: "Verify", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available" as const, backupStatus: "uploaded" as const, localDir },
    },
    relations: {
      "u1:1:BVVERIFY": {
        userId: "u1", mediaId: 1, bvid: "BVVERIFY", folderTitle: "Favorites", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "uploaded" as const, remotePath: "/target",
        remoteFiles: [{ name: "video.mp4", path: "/target/video.mp4", size: 12, localRelativePath: "video.mp4", verificationStatus: "awaiting_verification" as const, putCompletedAt: now }],
      },
    },
  };
}
