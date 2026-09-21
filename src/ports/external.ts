import type { BiliCookie } from '../users.js';
import type { VideoPageSnapshotResult, listFavoriteItemsPage, refreshUserAuth, resolveSelfVisibleFavoriteItem } from '../bili.js';
import type { AppConfig } from '../config.js';
import type { BBDownProbePage, BBDownProbeTarget } from '../downloader.js';
import type { inspectRemoteFileSize, verifyRemoteFiles } from '../uploader.js';
export interface BiliContentPort {
  listPage: typeof listFavoriteItemsPage;
  refreshAuth: typeof refreshUserAuth;
  selfVisible: typeof resolveSelfVisibleFavoriteItem;
  videoProbe(cookie: BiliCookie, bvid: string): Promise<VideoPageSnapshotResult>;
}
export interface RemoteStoragePort {
  list(path: string): Promise<string[]>;
  verify: typeof verifyRemoteFiles;
  inspect: typeof inspectRemoteFileSize;
}
export interface MediaToolPort {
  probe(bvid: string, cookie: BiliCookie, config: AppConfig, target?: BBDownProbeTarget):
    Promise<{ bvid: string; pages: BBDownProbePage[]; source: 'bbdown' }>;
}
export interface ClockPort { now(): number; sleep(ms: number): Promise<void>; random(): number; }
