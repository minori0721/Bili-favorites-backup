import type { BBDownApiMode } from "./config.js";

export type DownloadApiHealthState = "healthy" | "cooldown" | "half_open";

export interface PersistedDownloadApiCooldown {
  until: number;
  reason: string;
  probeBvid: string;
  probeUserId: string;
  probeMode: BBDownApiMode;
  setAt: string;
}

export interface DownloadApiTaskIdentity {
  bvid: string;
  userId: string;
  hasAppToken: boolean;
}

export interface DownloadApiStartDecision {
  allowed: boolean;
  probe: boolean;
  apiModeOverride?: BBDownApiMode;
}

export class DownloadApiHealth {
  private configuredMode: BBDownApiMode = "web";
  private state: DownloadApiHealthState = "healthy";
  private reason = "";
  private retryAt?: number;
  private probeBvid = "";
  private probeUserId = "";
  private probeMode: BBDownApiMode = "web";
  private probeInFlight = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = 180_000
  ) {}

  configure(mode: BBDownApiMode) {
    this.configuredMode = mode;
    if (mode === "app") this.clear();
  }

  restore(value?: PersistedDownloadApiCooldown | null) {
    if (this.configuredMode !== "web" || !value?.probeBvid || !value?.probeUserId) {
      this.clear();
      return;
    }
    this.state = "cooldown";
    this.reason = value.reason || "B站触发播放接口风控";
    this.retryAt = Number(value.until || this.now());
    this.probeBvid = value.probeBvid;
    this.probeUserId = value.probeUserId;
    this.probeMode = value.probeMode === "app" ? "app" : "web";
    this.probeInFlight = false;
  }

  open(task: DownloadApiTaskIdentity, reason = "B站返回 v_voucher 风控响应") {
    if (this.configuredMode !== "web") return null;
    if (this.state === "healthy") {
      this.probeBvid = task.bvid;
      this.probeUserId = task.userId;
      this.probeMode = task.hasAppToken ? "app" : "web";
      this.retryAt = this.now() + this.cooldownMs;
    } else if (this.state === "half_open" && this.matches(task)) {
      this.retryAt = this.now() + this.cooldownMs;
    }
    this.state = "cooldown";
    this.reason = reason;
    this.probeInFlight = false;
    return this.toPersisted();
  }

  claimStart(task: DownloadApiTaskIdentity): DownloadApiStartDecision {
    if (this.configuredMode === "app" || this.state === "healthy") {
      return { allowed: true, probe: false };
    }
    if (this.state === "cooldown") {
      if ((this.retryAt || 0) > this.now()) return { allowed: false, probe: false };
      this.state = "half_open";
      this.probeInFlight = false;
    }
    if (!this.matches(task) || this.probeInFlight) {
      return { allowed: false, probe: false };
    }
    this.probeInFlight = true;
    return { allowed: true, probe: true, apiModeOverride: this.probeMode };
  }

  canQueueRecovery(task: Pick<DownloadApiTaskIdentity, "bvid" | "userId">) {
    if (this.configuredMode === "app" || this.state === "healthy") return true;
    if ((this.retryAt || 0) > this.now()) return false;
    return this.probeBvid === task.bvid && this.probeUserId === task.userId;
  }

  ready(task: Pick<DownloadApiTaskIdentity, "bvid" | "userId">) {
    if (this.state !== "half_open" || !this.matches(task)) return false;
    this.clear();
    return true;
  }

  probeFailed(task: Pick<DownloadApiTaskIdentity, "bvid" | "userId">, reason: string, permanent = false) {
    if (this.state !== "half_open" || !this.matches(task)) return null;
    if (permanent) {
      this.clear();
      return null;
    }
    this.state = "cooldown";
    this.reason = reason || "风控探测失败";
    this.retryAt = this.now() + this.cooldownMs;
    this.probeInFlight = false;
    return this.toPersisted();
  }

  getRetryAt() {
    return this.retryAt;
  }

  getProbeIdentity() {
    if (this.state === "healthy" || !this.probeBvid || !this.probeUserId) return null;
    return { bvid: this.probeBvid, userId: this.probeUserId };
  }

  abandonProbe() {
    if (this.state === "healthy") return false;
    this.clear();
    return true;
  }

  getSnapshot() {
    return {
      configuredMode: this.configuredMode,
      activeMode: this.state === "healthy" ? this.configuredMode : this.probeMode,
      state: this.state,
      reason: this.reason,
      retryAt: this.retryAt,
      probeBvid: this.probeBvid,
    };
  }

  private matches(task: Pick<DownloadApiTaskIdentity, "bvid" | "userId">) {
    return this.probeBvid === task.bvid && this.probeUserId === task.userId;
  }

  private toPersisted(): PersistedDownloadApiCooldown | null {
    if (this.state === "healthy" || !this.retryAt) return null;
    return {
      until: this.retryAt,
      reason: this.reason,
      probeBvid: this.probeBvid,
      probeUserId: this.probeUserId,
      probeMode: this.probeMode,
      setAt: new Date(this.now()).toISOString(),
    };
  }

  private clear() {
    this.state = "healthy";
    this.reason = "";
    this.retryAt = undefined;
    this.probeBvid = "";
    this.probeUserId = "";
    this.probeMode = this.configuredMode;
    this.probeInFlight = false;
  }
}
