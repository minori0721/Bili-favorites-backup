import type { AppConfig } from './config.js';
import type { StateManager } from './state.js';
import type { UserStore } from './users.js';
import { getPlaybackDeliveryStatus, getPlaybackQueue, getPlaybackSearch, playbackFileAlistLocation, resolvePlaybackFile, streamPlaybackFile } from './playback.js';

export function createPlaybackService(deps: {
  database(): Parameters<typeof getPlaybackQueue>[0];
  config(): AppConfig;
  users: Pick<UserStore, 'getById'>;
  isKnownOwner(userId: string): boolean;
  updateMetadata: StateManager['updatePlaybackMediaMetadata'];
}) {
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
    alistLocation: (userId: string, mediaId: number, fileId: number) => playbackFileAlistLocation(deps.database(), deps.config(), userId, mediaId, fileId),
    stream: (req: Parameters<typeof streamPlaybackFile>[2], res: Parameters<typeof streamPlaybackFile>[3], options: Parameters<typeof streamPlaybackFile>[4]) => streamPlaybackFile(deps.database(), deps.config(), req, res, options),
  };
}
