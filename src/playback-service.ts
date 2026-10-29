import type { AppConfig } from './config.js';
import type { StateManager } from './state.js';
import type { UserStore } from './users.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { getPlaybackDeliveryStatus, getPlaybackQueue, getPlaybackSearch, getPlaybackPreparationTargets, playbackFileAlistLocation, resolvePlaybackFile, streamPlaybackFile, fetchPlaybackUpstream, PlaybackHttpError, type PlaybackTransportOptions } from './playback.js';
import { PlaybackDirectLinks, PlaybackDirectoryPreparation } from './playback-preparation.js';
import { playbackFileFingerprint } from './playback-file-identity.js';
import { buildDavClient } from './remote-storage.js';
import { buildStorageDavFileUrl, parseStorageBaseUrl } from './storage-url.js';

export function createPlaybackService(deps: {
  database(): Parameters<typeof getPlaybackQueue>[0];
  config(): AppConfig;
  users: Pick<UserStore, 'getById'>;
  isKnownOwner(userId: string): boolean;
  updateMetadata: StateManager['updatePlaybackMediaMetadata'];
  transport?: PlaybackTransportOptions;
  readDirectory?: (config: Pick<AppConfig, 'alistUrl'|'alistUsername'|'alistPassword'>, directory: string, signal: AbortSignal) => Promise<void>;
}) {
  const links = new PlaybackDirectLinks();
  const directories = new PlaybackDirectoryPreparation();
  let previous: { database: ReturnType<typeof deps.database>; stamp: string } | undefined;
  function context() {
    const database = deps.database(), config = deps.config();
    const stamp = crypto.createHash('sha256').update(JSON.stringify([
      config.alistUrl, config.alistUsername, config.alistPassword, config.playbackDeliveryMode,
    ])).digest('hex');
    if (previous && (previous.database !== database || previous.stamp !== stamp)) {
      links.clear(); directories.clear();
    }
    previous = { database, stamp };
    return { database, config, stamp };
  }
  function assertCurrent(snapshot: ReturnType<typeof context>) {
    const current = context();
    if (snapshot.database !== current.database || snapshot.stamp !== current.stamp) {
      throw new PlaybackHttpError(409, 'PLAYBACK_STORAGE_CHANGED', '播放存储已变化，请重新打开视频');
    }
  }
  async function preparePlayback(userId: string, mediaId: number, fileId: number, kind: 'directory' | 'link', signal: AbortSignal) {
    const snapshot = context();
    const file = resolvePlaybackFile(snapshot.database, userId, mediaId, fileId);
    let prepared = false;
    try {
      if (kind === 'directory') {
        const directory = path.posix.dirname(file.remotePath);
        await directories.prepare(directory, async sharedSignal => {
          assertCurrent(snapshot);
          resolvePlaybackFile(snapshot.database, userId, mediaId, fileId);
          const timeout = AbortSignal.any([sharedSignal, AbortSignal.timeout(15_000)]);
          if (deps.readDirectory) await deps.readDirectory(snapshot.config, directory, timeout);
          else await buildDavClient(snapshot.config).getDirectoryContents(directory, { signal: timeout });
          assertCurrent(snapshot);
        }, signal, error => !(error instanceof PlaybackHttpError));
        prepared = true;
      } else if (snapshot.config.playbackDeliveryMode !== 'proxy') {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const result = await links.resolve(playbackFileFingerprint(file), async () => {
          const { config } = snapshot;
          const response = await fetchPlaybackUpstream(buildStorageDavFileUrl(config.alistUrl, file.remotePath), parseStorageBaseUrl(config.alistUrl), 'HEAD', {
            Authorization: `Basic ${Buffer.from(`${config.alistUsername}:${config.alistPassword}`).toString('base64')}`,
          }, timeout, true, deps.transport ?? {});
          try { assertCurrent(snapshot); }
          catch (error) { await response.response?.body?.cancel(); throw error; }
          return response;
        }, timeout);
        await result.response?.body?.cancel();
        if (result.response && result.response.status >= 400) {
          throw new PlaybackHttpError(503, 'PLAYBACK_PREPARATION_UNAVAILABLE', '远端存储暂时无法准备播放地址');
        }
        prepared = Boolean(result.directLocation);
      }
      assertCurrent(snapshot);
      return prepared;
    } catch (error) {
      if (error instanceof PlaybackHttpError || signal.aborted) throw error;
      // WebDAV errors can contain credential-bearing URLs and response bodies.
      throw new PlaybackHttpError(503, 'PLAYBACK_PREPARATION_UNAVAILABLE', '播放预热暂时不可用');
    }
  }
  return {
    getUser: (userId: string) => deps.users.getById(userId),
    ownerExists: (userId: string) => Boolean(deps.users.getById(userId) || deps.isKnownOwner(userId)),
    queue: (userId: string, mediaId: number, options: Parameters<typeof getPlaybackQueue>[3]) => getPlaybackQueue(deps.database(), userId, mediaId, options),
    search: (userId: string, mediaId: number, options: Parameters<typeof getPlaybackSearch>[3]) => getPlaybackSearch(deps.database(), userId, mediaId, options),
    updateMetadata(userId: string, mediaId: number, fileId: number, metadata: Parameters<StateManager['updatePlaybackMediaMetadata']>[3]) {
      resolvePlaybackFile(deps.database(), userId, mediaId, fileId);
      return deps.updateMetadata(userId, mediaId, fileId, metadata);
    },
    deliveryStatus: getPlaybackDeliveryStatus,
    preparationTargets: (preferred: {userId?: string; mediaId?: number}) => getPlaybackPreparationTargets(deps.database(),
      userId => Boolean(deps.users.getById(userId) || deps.isKnownOwner(userId)), preferred),
    preparePlayback,
    close() { links.clear(); directories.clear(); },
    alistLocation: (userId: string, mediaId: number, fileId: number) => playbackFileAlistLocation(deps.database(), deps.config(), userId, mediaId, fileId),
    stream(req: Parameters<typeof streamPlaybackFile>[2], res: Parameters<typeof streamPlaybackFile>[3], options: Parameters<typeof streamPlaybackFile>[4]) {
      const snapshot = context();
      return streamPlaybackFile(snapshot.database, snapshot.config, req, res, {
        ...options, directLinks: links, transport: deps.transport, assertCurrent: file => {
          assertCurrent(snapshot);
          const current = resolvePlaybackFile(snapshot.database, options.userId, options.mediaId, options.fileId);
          if (playbackFileFingerprint(current) !== playbackFileFingerprint(file)) {
            throw new PlaybackHttpError(409, 'PLAYBACK_FILE_CHANGED', '归档文件已变化，请重新打开视频');
          }
        },
      });
    },
  };
}
