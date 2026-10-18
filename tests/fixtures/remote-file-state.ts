import type { StateFile, RemoteFileRecord } from '../../src/state.js';
export const remoteFileFixtureTime = '2026-09-18T00:00:00.000Z';
const at = remoteFileFixtureTime;
export function remoteFileFixture(count = 1): StateFile {
  const state: StateFile = { schemaVersion: 13, processedByUser: {}, failedByUser: {},
    userCooldowns: {}, folderScans: {}, videos: {}, relations: {} };
  for (let n = 0; n < count; n++) {
    const bvid = `BVFIXTURE${String(n).padStart(5, '0')}`;
    const file: RemoteFileRecord = { name: 'part.mp4', path: `/archive/${bvid}/part.mp4`, size: 42,
      verificationStatus: 'verified' as const, putCompletedAt: at };
    state.videos![bvid] = { bvid, title: 'Fixture', upperName: 'Fixture', firstSeenAt: at, lastSeenAt: at,
      backupStatus: 'verified' as const, biliStatus: 'available' as const, remotePath: `/archive/${bvid}`, remoteFiles: [file] };
    state.relations![`u:1:${bvid}`] = { userId: 'u', mediaId: 1, bvid, folderTitle: 'Fixture',
      firstSeenAt: at, lastSeenAt: at, activeInFavorite: true, backupStatus: 'verified' as const,
      remotePath: `/archive/${bvid}`, remoteFiles: [structuredClone(file)] };
  }
  return state;
}
