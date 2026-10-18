import { appInfo, type AppInfo } from './app-info.js';
import { readCurrentRelease } from './current-release.js';
import { buildChannel, compareReleaseVersions, isObject, parseRelease, releasesUrl, UpdateError } from './update-release.js';
import type { ChannelUpdate, ReleaseNotes, UpdateChannel, UpdateComparison, UpdateNotification, UpdatesResponse } from './shared/api/updates.js';
export { applicationReleaseTag, compareReleaseVersions } from './update-release.js';

const endpoint = 'https://api.github.com/repos/minori0721/Bili-favorites-backup';
type CachedChannel = ChannelUpdate & { expiresAt: number; refreshAfter: number; lastComparison: UpdateComparison };

export class UpdateCheckService {
  private readonly snapshots: Partial<Record<UpdateChannel, CachedChannel>> = {};
  private pending?: Promise<void>;
  constructor(private request: typeof fetch = fetch, private now = Date.now, private current: AppInfo = appInfo,
    private currentRelease: ReleaseNotes | null = current === appInfo ? readCurrentRelease(current) : null) {}

  async check(refresh = false): Promise<UpdatesResponse & { release: ReleaseNotes | null; comparison: UpdateComparison; checkedAt: string; error: string | null; errorCode?: string }> {
    const channel = buildChannel(this.current);
    const wanted: UpdateChannel[] = channel === 'dev' ? ['dev', 'stable'] : ['stable'];
    const due = wanted.filter(name => {
      const cached = this.snapshots[name];
      return !cached || (refresh || this.now() >= cached.expiresAt) && this.now() >= cached.refreshAfter;
    });
    if (!this.pending && due.length) {
      this.pending = (async () => { for (const name of due) this.snapshots[name] = await this.load(name); })()
        .finally(() => { this.pending = undefined; });
    }
    await this.pending;
    const stable = this.snapshots.stable!;
    const dev = channel === 'dev' ? this.snapshots.dev! : null;
    const primary = dev || stable;
    const active = wanted.map(name => this.snapshots[name]!);
    const notification = this.notification(channel, stable, dev);
    return { current: this.current, channel, currentRelease: this.currentRelease,
      channels: { stable, dev }, notification, releasesUrl,
      nextRefreshAt: new Date(Math.max(...active.map(item => item.refreshAfter))).toISOString(),
      checkAfter: new Date(Math.min(...active.map(item => Math.max(item.expiresAt, item.refreshAfter)))).toISOString(),
      // Preserve existing HTTP fields for clients that only display the primary channel.
      release: primary.release, comparison: primary.comparison, checkedAt: primary.checkedAt, error: primary.error, errorCode: primary.errorCode };
  }

  private notification(channel: UpdateChannel | 'local', stable: CachedChannel, dev: CachedChannel | null): UpdateNotification | null {
    if (channel === 'local') return null;
    if (dev && dev.lastComparison === 'update_available' && dev.release) {
      return { id: 'dev:' + dev.release.revision, channel: 'dev', kind: 'update', label: '有新的版本！' + dev.release.version };
    }
    if (stable.release) {
      if (channel === 'stable' && stable.lastComparison === 'update_available') {
        return { id: 'stable:' + stable.release.version, channel: 'stable', kind: 'update', label: '有新的版本！' + stable.release.version };
      }
      if (channel === 'dev' && compareReleaseVersions(stable.release.version, this.current.version.replace(/-dev$/, '')) >= 0) {
        return { id: 'stable:' + stable.release.version, channel: 'stable', kind: 'stable_available', label: '正式版已发布！' + stable.release.version };
      }
    }
    return null;
  }

  private async load(channel: UpdateChannel): Promise<CachedChannel> {
    const previous = this.snapshots[channel];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    timer.unref();
    let response: Response | undefined;
    let totalBytes = 0;
    const read = async (suffix: string, missing = false) => {
      response = await this.request(endpoint + suffix, { signal: controller.signal, redirect: 'error', headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'BFB-update-check', 'X-GitHub-Api-Version': '2022-11-28',
      } });
      let readerOwnsBody = false;
      try {
        if (response.status === 404 && missing) return { data: null, next: false };
        if (!response.ok) {
          if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new UpdateError('rate_limited', 'GitHub查询已限流，请稍后重试');
          throw new UpdateError('upstream_error', '更新源请求失败，请稍后重试');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new UpdateError('invalid_response', '更新源返回为空');
        readerOwnsBody = true;
        const chunks: Uint8Array[] = [];
        let size = 0;
        let completed = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            totalBytes += value.length;
            if (size > 1024 * 1024 || totalBytes > 2 * 1024 * 1024) throw new UpdateError('response_limit', '发布记录过大，无法完整确认最新版本');
            chunks.push(value);
          }
          completed = true;
        } finally {
          if (!completed) await reader.cancel().catch(error => { console.debug(`[Update] reader cancellation: ${String(error)}`); });
          reader.releaseLock();
        }
        try { return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, next: /rel="next"/.test(response.headers.get('link') || '') }; }
        catch { throw new UpdateError('invalid_response', '更新源返回格式异常'); }
      } finally {
        if (!readerOwnsBody) await response.body?.cancel().catch(error => { console.debug(`[Update] response cancellation: ${String(error)}`); });
      }
    };
    try {
      const latest = await read(channel === 'dev' ? '/releases/tags/dev-preview' : '/releases/latest', true);
      let release = latest.data === null ? null : parseRelease(latest.data, channel);
      if (!release && channel === 'stable') {
        for (let page = 1; page <= 3; page++) {
          const result = await read('/releases?per_page=30&page=' + page);
          if (!Array.isArray(result.data) || result.data.length > 30) throw new UpdateError('invalid_response', '发布列表格式异常');
          for (const entry of result.data) {
            const candidate = parseRelease(entry, 'stable');
            if (candidate && (!release || compareReleaseVersions(candidate.version, release.version) > 0)) release = candidate;
          }
          if (!result.next) break;
          if (page === 3) throw new UpdateError('incomplete', '发布列表未读取完整，暂时无法确认最新版本');
        }
      }
      let comparison: UpdateComparison = 'reference';
      if (release && channel === 'stable' && buildChannel(this.current) === 'stable') {
        const order = compareReleaseVersions(release.version, this.current.version);
        comparison = order > 0 ? 'update_available' : order === 0 ? 'up_to_date' : 'ahead';
      }
      if (release && channel === 'stable' && buildChannel(this.current) === 'dev') {
        comparison = compareReleaseVersions(release.version, this.current.version.replace(/-dev$/, '')) >= 0 ? 'update_available' : 'ahead';
      }
      if (release && channel === 'dev' && /^[a-f0-9]{40}$/.test(this.current.revision)) {
        if (release.revision === this.current.revision) comparison = 'up_to_date';
        else {
          const result = await read('/compare/' + this.current.revision + '...' + release.revision);
          if (!isObject(result.data) || typeof result.data.status !== 'string' || !['ahead', 'behind', 'identical', 'diverged'].includes(result.data.status)) {
            throw new UpdateError('invalid_response', '开发版本提交比较结果异常');
          }
          if (result.data.status === 'diverged') throw new UpdateError('diverged', '当前构建与开发预览的提交已分叉，无法确认更新顺序');
          comparison = result.data.status === 'ahead' ? 'update_available' : result.data.status === 'behind' ? 'ahead' : 'up_to_date';
        }
      }
      return { release, comparison, lastComparison: comparison, checkedAt: new Date(this.now()).toISOString(), error: null,
        expiresAt: this.now() + (channel === 'dev' ? 30 * 60000 : 6 * 3600000), refreshAfter: this.now() + 60000 };
    } catch (error) {
      const retry = response?.headers.get('retry-after');
      const reset = error instanceof UpdateError && error.code === 'rate_limited' ? response?.headers.get('x-ratelimit-reset') : null;
      const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now())
        : reset ? Number(reset) * 1000 - this.now() : 60000;
      return { release: previous?.release || null, comparison: 'unknown', lastComparison: previous?.lastComparison || 'unknown', checkedAt: previous?.checkedAt || '',
        error: error instanceof UpdateError ? error.message : '暂时无法连接更新源，请稍后重试',
        errorCode: error instanceof UpdateError ? error.code : 'network_error', expiresAt: this.now() + 60000,
        refreshAfter: this.now() + Math.min(3600000, Math.max(60000, Number.isFinite(delay) ? delay : 60000)) };
    } finally { clearTimeout(timer); }
  }
}
