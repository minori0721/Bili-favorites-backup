export type RecoveryIssueKind =
  | "remote_visibility_timeout"
  | "remote_visibility_stalled"
  | "remote_write_rejected"
  | "remote_size_conflict"
  | "remote_size_limit"
  | "partial_remote_state"
  | "local_file_missing"
  | "local_file_changed"
  | "remote_connection"
  | "remote_permission"
  | "remote_unsupported"
  | "remote_unknown"
  | "unknown_same_size"
  | "legacy_conflict_interrupted"
  | "conflict_candidate_ready"
  | "encoding_retry_failed"
  | "manual_review"
  | "download_retry_exhausted"
  | "download_account_required"
  | "download_tool_failure"
  | "quality_failed"
  | "storage_backend";

export type RecoveryIssueActionId =
  | "recheck"
  | "reupload"
  | "create_candidate"
  | "redownload"
  | "redownload_with_encoding"
  | "redownload_with_quality"
  | "retry_download"
  | "retry_download_with_account"
  | "defer_download"
  | "keep_existing"
  | "use_candidate"
  | "retry_quality"
  | "retry_quality_with_encoding"
  | "retry_quality_with_quality"
  | "open_settings";

export interface RecoveryIssueActionChoice {
  value: string;
  label: string;
}

export interface RecoveryIssueAction {
  id: RecoveryIssueActionId;
  label: string;
  description: string;
  danger?: boolean;
  choices?: RecoveryIssueActionChoice[];
  mediaProfile?: {
    quality: boolean;
    encoding: boolean;
  };
}

export type RecoveryIssueDisposition = "background" | "action_required" | "intentional_confirmation";

export type DownloadRecoveryCategory = "transient" | "account" | "tool" | "unknown";

const VISIBILITY_OBSERVATION_MIN_INTERVAL_MS = 5 * 60_000;
const VISIBILITY_ACTION_MIN_AGE_MS = 30 * 60_000;
const VISIBILITY_ACTION_MIN_OBSERVATIONS = 3;

export interface VisibilityObservationState {
  firstObservedAt?: number;
  lastObservedAt?: number;
  consecutiveObservations?: number;
}

export function recordRemoteVisibilityObservation(previous: VisibilityObservationState | null | undefined, now = Date.now()) {
  const priorFirst = Number(previous?.firstObservedAt);
  const priorLast = Number(previous?.lastObservedAt);
  const firstObservedAt = Number.isFinite(priorFirst) && priorFirst > 0 ? priorFirst : now;
  const independent = !Number.isFinite(priorLast)
    || priorLast <= 0
    || now - priorLast >= VISIBILITY_OBSERVATION_MIN_INTERVAL_MS;
  const priorCount = Math.max(0, Math.floor(Number(previous?.consecutiveObservations) || 0));
  const consecutiveObservations = independent ? priorCount + 1 : Math.max(1, priorCount);
  const lastObservedAt = independent ? now : priorLast;
  const ageMs = Math.max(0, now - firstObservedAt);
  const actionRequired = consecutiveObservations >= VISIBILITY_ACTION_MIN_OBSERVATIONS
    && ageMs >= VISIBILITY_ACTION_MIN_AGE_MS;
  const nextDelayMs = ageMs < VISIBILITY_ACTION_MIN_AGE_MS
    ? 5 * 60_000
    : (ageMs < 6 * 60 * 60_000
      ? 30 * 60_000
      : (ageMs < 24 * 60 * 60_000 ? 2 * 60 * 60_000 : 6 * 60 * 60_000));
  return {
    firstObservedAt,
    lastObservedAt,
    consecutiveObservations,
    actionRequired,
    nextCheckAt: now + nextDelayMs,
  };
}

export interface RecoveryPolicyContext {
  domain: "upload" | "download" | "quality" | "storage";
  kind: RecoveryIssueKind;
  jobKind?: string;
  historyOnly?: boolean;
  localStatus?: "available" | "missing" | "changed" | "unknown";
  remoteStatus?: string;
  candidateEligible?: boolean;
  downloadCategory?: DownloadRecoveryCategory;
  alternateAccounts?: RecoveryIssueActionChoice[];
  downloadEncodingEligible?: boolean;
  downloadQualityEligible?: boolean;
  downloadQualityChoices?: RecoveryIssueActionChoice[];
  qualityEncodingEligible?: boolean;
  qualityQualityEligible?: boolean;
  qualityChoices?: RecoveryIssueActionChoice[];
}

const actions = {
  recheck: (): RecoveryIssueAction => ({
    id: "recheck",
    label: "重新检查远端",
    description: "只读取远端状态，不上传或删除文件。",
  }),
  reupload: (): RecoveryIssueAction => ({
    id: "reupload",
    label: "重新上传正式路径",
    description: "仅为当前任务授权一次正式路径上传；远端冲突仍会再次拦截。",
    danger: true,
  }),
  createCandidate: (): RecoveryIssueAction => ({
    id: "create_candidate",
    label: "生成隔离候选",
    description: "把完整本地文件组上传到独立候选目录；正式旧路径不会被覆盖、移动或删除。",
  }),
  redownload: (): RecoveryIssueAction => ({
    id: "redownload",
    label: "重新下载",
    description: "废弃失效补传任务并重新下载，不删除任何远端文件。",
  }),
  redownloadWithEncoding: (quality = false): RecoveryIssueAction => ({
    id: "redownload_with_encoding",
    label: quality ? "重新选择画质与编码" : "换编码重新下载",
    description: quality
      ? "先探测当前可用组合和预计大小，再按选中的画质与编码严格下载；原文件会保留到新文件完成远端确认。"
      : "按本次选择的编码在隔离目录重新下载并上传；原文件会保留到新文件完成远端确认。",
    mediaProfile: { quality, encoding: true },
  }),
  redownloadWithQuality: (choices: RecoveryIssueActionChoice[]): RecoveryIssueAction => ({
    id: "redownload_with_quality",
    label: "换分辨率重新下载",
    description: "严格按选择的 B 站画质档位重新下载；无法提供该档位时会回到待处理，不会上传错误候选。",
    choices,
    mediaProfile: { quality: true, encoding: false },
  }),
  retryDownload: (): RecoveryIssueAction => ({
    id: "retry_download",
    label: "重新下载一次",
    description: "重置本次失败次数并从已验证的本地进度继续，不删除已有文件或远端归档。",
  }),
  retryDownloadWithAccount: (choices: RecoveryIssueActionChoice[]): RecoveryIssueAction => ({
    id: "retry_download_with_account",
    label: "换账号下载",
    description: "只更换本次下载使用的登录账号，收藏来源和上传目标保持不变。",
    choices,
  }),
  deferDownload: (): RecoveryIssueAction => ({
    id: "defer_download",
    label: "暂缓24小时",
    description: "保留真实失败状态和本地进度，24小时后重新进入后台队列。",
  }),
  keepExisting: (): RecoveryIssueAction => ({
    id: "keep_existing",
    label: "保留现有归档",
    description: "继续使用已重新验证的旧归档；候选仍保留在独立目录，不执行删除。",
  }),
  useCandidate: (): RecoveryIssueAction => ({
    id: "use_candidate",
    label: "采用新候选",
    description: "将已验证候选设为当前可播放归档；正式旧路径仍保留，不移动或删除。",
  }),
  retryQuality: (): RecoveryIssueAction => ({
    id: "retry_quality",
    label: "重新尝试画质重调",
    description: "从已保存的安全阶段继续，已验证旧文件不会被直接删除。",
  }),
  retryQualityWithEncoding: (quality = false): RecoveryIssueAction => ({
    id: "retry_quality_with_encoding",
    label: quality ? "重新选择画质与编码" : "换编码重调画质",
    description: quality
      ? "先探测当前可用组合和预计大小，再生成严格匹配的新隔离版本；现有归档继续保留。"
      : "保持目标画质不变，以本次编码顺序生成新的隔离版本；现有归档继续保留。",
    mediaProfile: { quality, encoding: true },
  }),
  retryQualityWithQuality: (choices: RecoveryIssueActionChoice[]): RecoveryIssueAction => ({
    id: "retry_quality_with_quality",
    label: "换分辨率重调画质",
    description: "选择一个新的 B 站画质档位严格重试；如果当前账号没有该档位，任务会回到待处理，现有归档继续保留。",
    choices,
    mediaProfile: { quality: true, encoding: false },
  }),
  openSettings: (): RecoveryIssueAction => ({
    id: "open_settings",
    label: "检查存储配置",
    description: "打开存储设置并进行只读连接检查，不创建、上传、移动或删除文件。",
  }),
};

export function recoveryIssueDisposition(kind: RecoveryIssueKind): RecoveryIssueDisposition {
  if (["remote_visibility_timeout", "remote_connection"].includes(kind)) return "background";
  if (kind === "conflict_candidate_ready") return "intentional_confirmation";
  return "action_required";
}

export function recoveryIssueSeverity(kind: RecoveryIssueKind): "info" | "warning" | "danger" {
  if ([
    "remote_size_conflict",
    "remote_size_limit",
    "partial_remote_state",
    "unknown_same_size",
    "legacy_conflict_interrupted",
    "remote_permission",
    "remote_unsupported",
    "remote_unknown",
    "download_account_required",
    "storage_backend",
  ].includes(kind)) return "danger";
  if ([
    "local_file_missing",
    "local_file_changed",
    "encoding_retry_failed",
    "remote_write_rejected",
    "remote_visibility_stalled",
    "download_retry_exhausted",
    "download_tool_failure",
    "quality_failed",
  ].includes(kind)) return "warning";
  return "info";
}

export function planRecoveryActions(context: RecoveryPolicyContext): RecoveryIssueAction[] {
  if (context.domain === "storage") return [actions.openSettings()];

  if (context.domain === "download") {
    const alternate = context.alternateAccounts || [];
    const strict = [] as RecoveryIssueAction[];
    if (context.downloadEncodingEligible) {
      strict.push(actions.redownloadWithEncoding(Boolean(context.downloadQualityEligible)));
    } else if (context.downloadQualityEligible && context.downloadQualityChoices?.length) {
      strict.push(actions.redownloadWithQuality(context.downloadQualityChoices));
    }
    if (context.downloadCategory === "account" && alternate.length > 0) {
      return [...strict, actions.retryDownloadWithAccount(alternate), actions.retryDownload(), actions.deferDownload()];
    }
    const planned = [...strict, actions.retryDownload()];
    if (alternate.length > 0) planned.push(actions.retryDownloadWithAccount(alternate));
    planned.push(actions.deferDownload());
    return planned;
  }

  if (context.domain === "quality") {
    const planned: RecoveryIssueAction[] = [];
    if (context.qualityEncodingEligible) {
      planned.push(actions.retryQualityWithEncoding(Boolean(context.qualityQualityEligible)));
    } else if (context.qualityQualityEligible && context.qualityChoices?.length) {
      planned.push(actions.retryQualityWithQuality(context.qualityChoices));
    }
    planned.push(actions.retryQuality());
    return planned;
  }

  const candidate = context.candidateEligible ? actions.createCandidate() : undefined;
  switch (context.kind) {
    case "local_file_missing":
    case "local_file_changed":
      return context.remoteStatus === "missing" ? [actions.redownload(), actions.recheck()] : [actions.recheck()];
    case "remote_size_conflict":
    case "partial_remote_state":
    case "unknown_same_size":
    case "legacy_conflict_interrupted":
    case "remote_visibility_stalled":
      return candidate ? [candidate, actions.recheck()] : [actions.recheck()];
    case "remote_size_limit":
      return context.jobKind === "upload" && !context.historyOnly
        ? [actions.redownloadWithEncoding(true), actions.openSettings(), actions.recheck()]
        : [actions.openSettings(), actions.reupload(), actions.recheck()];
    case "encoding_retry_failed":
    case "remote_write_rejected":
      return context.jobKind === "upload" && !context.historyOnly
        ? [actions.redownloadWithEncoding(true), actions.openSettings(), actions.recheck()]
        : [actions.openSettings(), actions.recheck()];
    case "remote_permission":
      return [actions.openSettings(), actions.recheck()];
    case "remote_unsupported":
    case "remote_unknown":
    case "manual_review":
      return candidate ? [candidate, actions.recheck(), actions.openSettings()] : [actions.recheck(), actions.openSettings()];
    case "remote_connection":
    case "remote_visibility_timeout":
      return [actions.recheck()];
    case "conflict_candidate_ready":
      return [actions.keepExisting(), actions.useCandidate(), actions.recheck()];
    default:
      return [actions.recheck()];
  }
}
