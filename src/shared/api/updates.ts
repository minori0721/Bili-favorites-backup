export type UpdateChannel = 'stable' | 'dev';
export type UpdateComparison = 'update_available' | 'up_to_date' | 'ahead' | 'reference' | 'unknown';

export interface ReleaseNotes {
  channel: UpdateChannel;
  version: string;
  revision: string;
  publishedAt: string;
  notes: string;
  notesHtml: string;
  truncated: boolean;
  url: string;
  changelogUrl: string;
}

export interface ChannelUpdate {
  release: ReleaseNotes | null;
  comparison: UpdateComparison;
  checkedAt: string;
  error: string | null;
  errorCode?: string;
}

export interface UpdateNotification {
  id: string;
  channel: UpdateChannel;
  kind: 'update' | 'stable_available';
  label: string;
}

export interface UpdatesResponse {
  current: { version: string; buildRef: string; revision: string; versionLabel: string };
  channel: UpdateChannel | 'local';
  currentRelease: ReleaseNotes | null;
  channels: { stable: ChannelUpdate; dev: ChannelUpdate | null };
  notification: UpdateNotification | null;
  nextRefreshAt: string;
  checkAfter: string;
  releasesUrl: string;
  installedNotice?: string | null;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const comparisons = new Set(['update_available', 'up_to_date', 'ahead', 'reference', 'unknown']);
const date = (value: unknown) => typeof value === 'string' && (value === '' || Number.isFinite(Date.parse(value)));
const link = (value: unknown) => typeof value === 'string' && /^https:\/\/github\.com\/minori0721\/Bili-favorites-backup(?:\/|$)/.test(value);

export function isReleaseNotes(value: unknown): value is ReleaseNotes {
  return object(value) && (value.channel === 'stable' || value.channel === 'dev')
    && typeof value.version === 'string' && /^v?\d+\.\d+\.\d+(?:-dev)?$/.test(value.version)
    && typeof value.revision === 'string' && (value.revision === '' || /^[a-f0-9]{40}$/.test(value.revision))
    && date(value.publishedAt) && typeof value.notes === 'string' && typeof value.notesHtml === 'string'
    && typeof value.truncated === 'boolean' && link(value.url) && link(value.changelogUrl);
}

function isChannel(value: unknown): value is ChannelUpdate {
  return object(value) && (value.release === null || isReleaseNotes(value.release))
    && typeof value.comparison === 'string' && comparisons.has(value.comparison)
    && date(value.checkedAt) && (value.error === null || typeof value.error === 'string');
}

function isUpdatesResponse(value: unknown): value is UpdatesResponse {
  if (!object(value) || !object(value.current) || !object(value.channels)) return false;
  const current = value.current;
  const notification = value.notification;
  if (![current.version, current.buildRef, current.revision, current.versionLabel].every(item => typeof item === 'string')
    || !(value.channel === 'stable' || value.channel === 'dev' || value.channel === 'local')
    || !(value.currentRelease === null || isReleaseNotes(value.currentRelease))
    || !isChannel(value.channels.stable) || !(value.channels.dev === null || isChannel(value.channels.dev))
    || !date(value.nextRefreshAt) || !date(value.checkAfter) || !link(value.releasesUrl)
    || !(value.installedNotice === undefined || value.installedNotice === null || typeof value.installedNotice === 'string' && value.installedNotice.length > 0 && value.installedNotice.length < 200)
    || !(notification === null || object(notification) && typeof notification.id === 'string'
      && typeof notification.label === 'string' && (notification.channel === 'stable' || notification.channel === 'dev')
      && (notification.kind === 'update' || notification.kind === 'stable_available'))) return false;
  return true;
}

export function decodeUpdatesResponse(value: unknown): UpdatesResponse {
  if (!isUpdatesResponse(value)) throw new Error('版本信息格式异常');
  return value;
}
