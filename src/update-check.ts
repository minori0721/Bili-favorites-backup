import { appInfo, type AppInfo } from "./app-info.js";

const endpoint = "https://api.github.com/repos/minori0721/Bili-favorites-backup/releases/latest";
const releases = "https://github.com/minori0721/Bili-favorites-backup/releases";
type Release = { version: string; publishedAt: string; notes: string; url: string };
type Snapshot = { release: Release | null; checkedAt: string; error: string | null };

export function compareReleaseVersions(a: string, b: string): number {
  const parse = (v: string) => {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) throw new Error("invalid version");
    return v.replace(/^v/, "").split(".").map(BigInt);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
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
    const stable = this.current.buildRef === `v${this.current.version}` && /^\d+\.\d+\.\d+$/.test(this.current.version);
    let comparison = "reference";
    if (stable && snapshot.release) {
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
    try {
      response = await this.request(endpoint, { signal: controller.signal, redirect: "error", headers: {
        Accept: "application/vnd.github+json", "User-Agent": "BFB-update-check", "X-GitHub-Api-Version": "2022-11-28",
      } });
      if (!response.ok && response.status !== 404) throw new Error("upstream");
      let release: Release | null = null;
      if (response.ok) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("empty");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 512 * 1024) throw new Error("oversize");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (data.draft !== false || data.prerelease !== false || typeof data.tag_name !== "string") throw new Error("invalid release");
        compareReleaseVersions(data.tag_name, "0.0.0");
        if (typeof data.published_at !== "string" || !Number.isFinite(Date.parse(data.published_at))) throw new Error("invalid date");
        release = { version: data.tag_name, publishedAt: data.published_at,
          notes: typeof data.body === "string" ? data.body.slice(0, 24000) : "",
          url: `${releases}/tag/${encodeURIComponent(data.tag_name)}` };
      }
      this.snapshot = { release, checkedAt: new Date(this.now()).toISOString(), error: null };
      this.expiresAt = this.now() + 6 * 3600000;
      this.refreshAfter = this.now() + 60000;
    } catch {
      this.snapshot = { release: this.snapshot?.release || null, checkedAt: this.snapshot?.checkedAt || "", error: "暂时无法连接更新源，请稍后重试" };
      this.expiresAt = this.now() + 60000;
      const retry = response?.headers.get("retry-after");
      const reset = response?.headers.get("x-ratelimit-reset");
      const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now())
        : reset ? Number(reset) * 1000 - this.now() : 60000;
      this.refreshAfter = this.now() + Math.min(3600000, Math.max(60000, Number.isFinite(delay) ? delay : 60000));
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => {});
    }
    return this.snapshot;
  }
}
