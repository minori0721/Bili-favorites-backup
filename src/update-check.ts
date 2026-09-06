import { appInfo, type AppInfo } from "./app-info.js";
import { renderReleaseNotes } from "./release-notes.js";

const endpoint = "https://api.github.com/repos/minori0721/Bili-favorites-backup/releases";
const releases = "https://github.com/minori0721/Bili-favorites-backup/releases";
export const applicationReleaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type Release = { version: string; publishedAt: string; notes: string; notesHtml: string; truncated: boolean; url: string; changelogUrl: string };
type Snapshot = { release: Release | null; checkedAt: string; error: string | null; errorCode?: string };

class UpdateError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function compareReleaseVersions(a: string, b: string): number {
  const parse = (v: string) => {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw new Error("invalid version");
    return v.replace(/^v/, "").split(".").map(BigInt);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpdateError("invalid_response", "更新源返回格式异常");
  const data = value as Record<string, unknown>;
  if (typeof data.tag_name !== "string" || typeof data.draft !== "boolean" || typeof data.prerelease !== "boolean") throw new UpdateError("invalid_response", "更新源返回格式异常");
  if (!applicationReleaseTag.test(data.tag_name) || data.draft || data.prerelease) return null;
  if (typeof data.published_at !== "string" || !Number.isFinite(Date.parse(data.published_at))) throw new UpdateError("invalid_response", "应用发布记录缺少有效日期");
  const raw = typeof data.body === "string" ? data.body : "";
  const notes = raw.slice(0, 24000);
  return { version: data.tag_name, publishedAt: data.published_at, notes, notesHtml: renderReleaseNotes(notes),
    truncated: raw.length > notes.length, url: releases + "/tag/" + encodeURIComponent(data.tag_name),
    changelogUrl: "https://github.com/minori0721/Bili-favorites-backup/blob/" + data.tag_name + "/CHANGELOG.md" };
}

export class UpdateCheckService {
  private snapshot?: Snapshot;
  private pending?: Promise<Snapshot>;
  private expiresAt = 0;
  private refreshAfter = 0;
  constructor(private request: typeof fetch = fetch, private now = Date.now, private current: AppInfo = appInfo) {}

  async check(refresh = false) {
    const now = this.now();
    if (!this.pending && (!this.snapshot || (now >= this.expiresAt || refresh) && now >= this.refreshAfter)) {
      this.pending = this.load().finally(() => { this.pending = undefined; });
    }
    const snapshot = this.pending ? await this.pending : this.snapshot!;
    const stable = (this.current.buildRef === "v" + this.current.version || this.current.buildRef === "main") && /^\d+\.\d+\.\d+$/.test(this.current.version);
    let comparison = snapshot.error ? "unknown" : "reference";
    if (stable && snapshot.release && !snapshot.error) {
      const order = compareReleaseVersions(snapshot.release.version, this.current.version);
      comparison = order > 0 ? "update_available" : order === 0 ? "up_to_date" : "ahead";
    }
    return { ...snapshot, current: this.current, comparison, releasesUrl: releases, nextRefreshAt: new Date(this.refreshAfter).toISOString() };
  }

  private async load(): Promise<Snapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    timer.unref();
    let response: Response | undefined;
    let totalBytes = 0;
    const read = async (suffix: string) => {
      response = await this.request(endpoint + suffix, { signal: controller.signal, redirect: "error", headers: {
        Accept: "application/vnd.github+json", "User-Agent": "BFB-update-check", "X-GitHub-Api-Version": "2022-11-28",
      } });
      try {
        if (response.status === 404 && suffix === "/latest") return { data: null, next: false };
        if (!response.ok) {
          if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") throw new UpdateError("rate_limited", "GitHub查询已限流，请稍后重试");
          throw new UpdateError("upstream_error", "更新源请求失败，请稍后重试");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new UpdateError("invalid_response", "更新源返回为空");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            totalBytes += value.length;
            if (size > 1024 * 1024 || totalBytes > 2 * 1024 * 1024) throw new UpdateError("response_limit", "发布记录过大，无法完整确认最新版本");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        try { return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, next: /rel="next"/.test(response.headers.get("link") || "") }; }
        catch { throw new UpdateError("invalid_response", "更新源返回格式异常"); }
      } finally { await response.body?.cancel().catch(() => {}); }
    };
    try {
      const latest = await read("/latest");
      let release = latest.data === null ? null : parseRelease(latest.data);
      // Tool releases can own GitHub's Latest marker; only this case needs bounded pagination.
      if (!release) {
        for (let page = 1; page <= 3; page++) {
          const result = await read("?per_page=30&page=" + page);
          if (!Array.isArray(result.data) || result.data.length > 30) throw new UpdateError("invalid_response", "发布列表格式异常");
          for (const entry of result.data) {
            const candidate = parseRelease(entry);
            if (candidate && (!release || compareReleaseVersions(candidate.version, release.version) > 0)) release = candidate;
          }
          if (!result.next) break;
          if (page === 3) throw new UpdateError("incomplete", "发布列表未读取完整，暂时无法确认最新版本");
        }
      }
      this.snapshot = { release, checkedAt: new Date(this.now()).toISOString(), error: null };
      this.expiresAt = this.now() + 6 * 3600000;
      this.refreshAfter = this.now() + 60000;
    } catch (error) {
      this.snapshot = { release: this.snapshot?.release || null, checkedAt: this.snapshot?.checkedAt || "",
        error: error instanceof UpdateError ? error.message : "暂时无法连接更新源，请稍后重试",
        errorCode: error instanceof UpdateError ? error.code : "network_error" };
      this.expiresAt = this.now() + 60000;
      const retry = response?.headers.get("retry-after");
      const reset = error instanceof UpdateError && error.code === "rate_limited" ? response?.headers.get("x-ratelimit-reset") : null;
      const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now())
        : reset ? Number(reset) * 1000 - this.now() : 60000;
      this.refreshAfter = this.now() + Math.min(3600000, Math.max(60000, Number.isFinite(delay) ? delay : 60000));
    } finally { clearTimeout(timer); }
    return this.snapshot;
  }
}
