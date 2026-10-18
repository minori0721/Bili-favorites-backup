import { renderReleaseNotes } from './release-notes.js';
import type { AppInfo } from './app-info.js';
import type { ReleaseNotes, UpdateChannel } from './shared/api/updates.js';

export const releasesUrl = 'https://github.com/minori0721/Bili-favorites-backup/releases';
export const repositoryUrl = 'https://github.com/minori0721/Bili-favorites-backup';
export const applicationReleaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const developmentVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev)?$/;
export const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class UpdateError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function compareReleaseVersions(a: string, b: string): number {
  const parse = (value: string) => {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('invalid version');
    return value.replace(/^v/, '').split('.').map(BigInt);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function buildChannel(current: AppInfo): UpdateChannel | 'local' {
  if (current.buildRef === 'dev') return 'dev';
  if ((current.buildRef === 'main' || current.buildRef === 'v' + current.version) && /^\d+\.\d+\.\d+$/.test(current.version)) return 'stable';
  return 'local';
}

export function releaseNotes(channel: UpdateChannel, version: string, revision: string, publishedAt: string, raw: string): ReleaseNotes {
  const notes = raw.slice(0, 24000);
  const ref = revision || version;
  return { channel, version, revision, publishedAt, notes, notesHtml: renderReleaseNotes(notes), truncated: raw.length > notes.length,
    url: channel === 'dev' ? releasesUrl + '/tag/dev-preview' : releasesUrl + '/tag/' + version,
    changelogUrl: `${repositoryUrl}/blob/${ref}/CHANGELOG.md` };
}

export function parseRelease(value: unknown, channel: UpdateChannel): ReleaseNotes | null {
  if (!isObject(value) || typeof value.tag_name !== 'string' || typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') {
    throw new UpdateError('invalid_response', '更新源返回格式异常');
  }
  if (value.draft) return null;
  if (channel === 'stable' && (!applicationReleaseTag.test(value.tag_name) || value.prerelease)) return null;
  if (channel === 'dev' && (value.tag_name !== 'dev-preview' || !value.prerelease)) throw new UpdateError('invalid_response', '开发预览发布身份异常');
  const publishedAt = channel === 'dev' ? value.updated_at : value.published_at;
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) throw new UpdateError('invalid_response', '应用发布记录缺少有效日期');
  if (value.body !== undefined && value.body !== null && typeof value.body !== 'string') throw new UpdateError('invalid_response', '发布说明格式异常');
  const raw = typeof value.body === 'string' ? value.body : '';
  if (channel === 'stable') return releaseNotes(channel, value.tag_name, '', publishedAt, raw);

  const markers = [...raw.matchAll(/<!-- bfb-build:(.*?)-->/gs)];
  let metadata: unknown;
  if (markers.length === 1) {
    try { metadata = JSON.parse(markers[0][1]); }
    catch { throw new UpdateError('invalid_response', '开发预览构建信息损坏'); }
  } else if (markers.length === 0) {
    // Compatibility with the first rolling preview, before machine-readable metadata.
    const version = /^- 程序版本：`([^`]+)`$/m.exec(raw)?.[1];
    const revision = /^- 对应提交：\[`([a-f0-9]{40})`\]/m.exec(raw)?.[1];
    metadata = { version, revision };
  }
  if (!isObject(metadata) || typeof metadata.version !== 'string' || !developmentVersion.test(metadata.version)
    || typeof metadata.revision !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.revision)) {
    throw new UpdateError('invalid_response', '开发预览缺少有效版本与提交信息');
  }
  return releaseNotes(channel, 'v' + metadata.version, metadata.revision, publishedAt, raw.replace(/<!-- bfb-build:.*?-->/gs, '').trim());
}
