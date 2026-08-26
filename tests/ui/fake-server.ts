import express from "express";
import type { Socket } from "node:net";
import { renderAppPage } from "../../src/web.js";

const app = express();
const port = Number(process.env.BFB_FAKE_UI_PORT || 43197);

type TestState = {
  previewCount: number;
  startCount: number;
  accountStartCount: number;
  accountDeleteCount: number;
  accountDeleteDelayMs: number;
  sourceStartDelayMs: number;
  sourceStatusPolls: number;
  sourceCompletionMode: "pending" | "complete";
  sourceDeleted: boolean;
  itemQueries: string[];
  detailQueries: string[];
  recoveryActionCount: number;
  lastRecoveryAction: string;
  lastRecoveryBody: unknown;
  recoveryIssueResolved: boolean;
  recoveryIssueKind: "visibility" | "candidate" | "create_candidate" | "download" | "quality" | "storage";
  recoveryIssueEmpty: boolean;
  storageCheckCount: number;
  storageCheckBody: unknown;
  storageCheckMode: "ok" | "path_error";
  queueBoardMode: "empty" | "manual_wait" | "media_retry" | "partial_upload";
  onlineNavigationCount: number;
  onlineItemQueries: string[];
  mediaProbeStartCount: number;
  mediaProbeBodies: unknown[];
  mediaProbeMode: "complete" | "failed" | "refine_mismatch";
  manualArchiveCount: number;
  configRequests: number;
  configFailuresRemaining: number;
  userRequests: number;
  userFailuresRemaining: number;
  usersMode: "single" | "double";
  favoriteQueries: string[];
  favoriteRace: boolean;
  favoriteSaveCount: number;
  favoriteSaveFailuresRemaining: number;
  userPatchCount: number;
  userPatchBodies: unknown[];
  syncNowCount: number;
  loginStartCount: number;
  loginStatusQueries: string[];
  loginMode: "pending" | "first_complete_then_pending";
  onlineSourceRace: boolean;
  onlineDuplicateMode: boolean;
};

function initialState(): TestState {
  return {
    previewCount: 0,
    startCount: 0,
    accountStartCount: 0,
    accountDeleteCount: 0,
    accountDeleteDelayMs: 0,
    sourceStartDelayMs: 0,
    sourceStatusPolls: 0,
    sourceCompletionMode: "pending",
    sourceDeleted: false,
    itemQueries: [],
    detailQueries: [],
    recoveryActionCount: 0,
    lastRecoveryAction: "",
    lastRecoveryBody: null,
    recoveryIssueResolved: false,
    recoveryIssueKind: "visibility",
    recoveryIssueEmpty: false,
    storageCheckCount: 0,
    storageCheckBody: null,
    storageCheckMode: "ok",
    queueBoardMode: "empty",
    onlineNavigationCount: 0,
    onlineItemQueries: [],
    mediaProbeStartCount: 0,
    mediaProbeBodies: [],
    mediaProbeMode: "complete",
    manualArchiveCount: 0,
    configRequests: 0,
    configFailuresRemaining: 0,
    userRequests: 0,
    userFailuresRemaining: 0,
    usersMode: "single",
    favoriteQueries: [],
    favoriteRace: false,
    favoriteSaveCount: 0,
    favoriteSaveFailuresRemaining: 0,
    userPatchCount: 0,
    userPatchBodies: [],
    syncNowCount: 0,
    loginStartCount: 0,
    loginStatusQueries: [],
    loginMode: "pending",
    onlineSourceRace: false,
    onlineDuplicateMode: false,
  };
}

let state = initialState();

const ok = (data: unknown) => ({ success: true, data });
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const baseItems = [
  {
    bvid: "BV1ALPHA001",
    title: "Alpha 归档视频",
    upperName: "测试UP主",
    statusGroup: "playable",
    backupStatus: "verified",
    unavailable: false,
    membershipCount: 1,
    memberships: [{ folderTitle: "历史收藏夹" }],
    playback: { available: true, partial: false, partCount: 1, actualQuality: "1080p" },
  },
  {
    bvid: "BV1BETA0002",
    title: "Beta 历史归档",
    upperName: "另一位UP主",
    statusGroup: "issue",
    backupStatus: "missing",
    unavailable: true,
    membershipCount: 1,
    memberships: [{ folderTitle: "已停用收藏夹" }],
    playback: { available: false, partial: false, partCount: 0 },
  },
];

function archiveItems(query: string) {
  const normalized = query.trim().toLowerCase();
  if (normalized === "fast") {
    return [{ ...baseItems[0], bvid: "BV1FAST0003", title: "Fast 快速结果" }];
  }
  if (normalized === "slow") {
    return [{ ...baseItems[0], bvid: "BV1SLOW0004", title: "Slow 慢速结果" }];
  }
  const visible = baseItems.filter((item) => !state.sourceDeleted || item.bvid !== "BV1ALPHA001");
  if (!normalized) return visible;
  return visible.filter((item) => `${item.title} ${item.upperName} ${item.bvid}`.toLowerCase().includes(normalized));
}

function navigation() {
  const items = archiveItems("");
  const playable = items.filter((item) => item.playback.available).length;
  const summary = { total: items.length, playable, pending: 0, issue: items.length - playable };
  return {
    summary,
    accounts: [{
      id: "user-1",
      uid: "10001",
      name: "测试账号",
      removed: false,
      summary,
      folders: [{ mediaId: 101, title: "当前收藏夹", ...summary }],
      inactiveFolders: [{ mediaId: 202, title: "历史收藏夹", ...summary }],
    }],
  };
}

function detailItem(bvid: string) {
  const item = baseItems.find((candidate) => candidate.bvid === bvid) || baseItems[0];
  return {
    ...item,
    memberships: [{
      userId: "user-1",
      mediaId: 202,
      userName: "测试账号",
      folderTitle: "历史收藏夹",
      backupStatus: "verified",
      activeInFavorite: false,
      selectedFolder: false,
      ownerRemoved: false,
      lastSeenAt: "2026-08-01T08:00:00.000Z",
      fileCount: 2,
      totalBytes: 15 * 1024 * 1024,
      deletable: true,
      deletionReason: "历史来源允许清理",
    }],
  };
}

app.use(express.json());

app.get("/__test/ready", (_request, response) => response.json({ ready: true }));
app.post("/__test/reset", (request, response) => {
  state = initialState();
  if (request.body?.sourceCompletionMode === "complete") state.sourceCompletionMode = "complete";
  state.accountDeleteDelayMs = Math.max(0, Number(request.body?.accountDeleteDelayMs || 0));
  state.sourceStartDelayMs = Math.max(0, Number(request.body?.sourceStartDelayMs || 0));
  const recoveryIssueKind = String(request.body?.recoveryIssueKind || "");
  if (["visibility", "candidate", "create_candidate", "download", "quality", "storage"].includes(recoveryIssueKind)) {
    state.recoveryIssueKind = recoveryIssueKind as TestState["recoveryIssueKind"];
  }
  state.recoveryIssueEmpty = request.body?.recoveryIssueEmpty === true;
  if (request.body?.storageCheckMode === "path_error") state.storageCheckMode = "path_error";
  if (request.body?.queueBoardMode === "manual_wait") state.queueBoardMode = "manual_wait";
  if (request.body?.queueBoardMode === "media_retry") state.queueBoardMode = "media_retry";
  if (request.body?.queueBoardMode === "partial_upload") state.queueBoardMode = "partial_upload";
  if (request.body?.mediaProbeMode === "failed") state.mediaProbeMode = "failed";
  if (request.body?.mediaProbeMode === "refine_mismatch") state.mediaProbeMode = "refine_mismatch";
  state.configFailuresRemaining = request.body?.configErrorOnce === true ? 1 : 0;
  state.userFailuresRemaining = request.body?.usersErrorOnce === true ? 1 : 0;
  if (request.body?.usersMode === "double") state.usersMode = "double";
  state.favoriteRace = request.body?.favoriteRace === true;
  state.favoriteSaveFailuresRemaining = request.body?.favoriteSaveErrorOnce === true ? 1 : 0;
  if (request.body?.loginMode === "first_complete_then_pending") state.loginMode = "first_complete_then_pending";
  state.onlineSourceRace = request.body?.onlineSourceRace === true;
  state.onlineDuplicateMode = request.body?.onlineDuplicateMode === true;
  response.json(state);
});
app.get("/__test/state", (_request, response) => response.json(state));

app.get("/", (_request, response) => response.type("html").send(renderAppPage()));
app.get("/api/config", (_request, response) => {
  state.configRequests += 1;
  if (state.configFailuresRemaining > 0) {
    state.configFailuresRemaining -= 1;
    response.json({ success: false, message: "隔离设置读取失败" });
    return;
  }
  response.json(ok({
  pollIntervalMinutes: 5,
  perVideoDelaySeconds: 0,
  uploadLayout: "user-folder-video",
  alistUrl: "http://alist:5244",
  alistBrowserUrl: "",
  alistUsername: "",
  alistPassword: "",
  alistDest: "/archive",
  playbackDeliveryMode: "auto",
  bbdownApiMode: "web",
  bbdownEncoding: "",
  bbdownQuality: "",
  bbdownHiRes: false,
  bbdownDolby: false,
  maxRetries: 3,
  retryDelaySeconds: 5,
  concurrentDownloads: 1,
  concurrentUploads: 2,
  uploadFileIntervalSeconds: 0,
  localCacheLimitGB: 10,
  queuePrefetchLimit: 25,
  remoteVerifyConcurrency: 3,
  remoteVerifyRateLimitPerSecond: 2,
  remoteRequeueLimitPerCycle: 20,
  filenameTemplate: "<videoTitle>-<bvid>",
  renameScanMaxFiles: 10_000,
  }));
});
app.post("/api/storage/check", (request, response) => {
  state.storageCheckCount += 1;
  state.storageCheckBody = request.body;
  if (state.storageCheckMode === "path_error") {
    response.json(ok({
      ok: false,
      category: "path",
      title: "归档目录不可访问",
      message: "连接成功，但当前目标目录不存在。请检查目标存储路径。",
      field: "alistDest",
      readOnly: true,
      writeVerified: false,
    }));
    return;
  }
  response.json(ok({
    ok: true,
    category: "ok",
    title: "只读连接正常",
    message: "WebDAV 地址、认证和归档目录均可读取；未执行写入测试。",
    readOnly: true,
    writeVerified: false,
  }));
});
app.get("/api/users", (_request, response) => {
  state.userRequests += 1;
  if (state.userFailuresRemaining > 0) {
    state.userFailuresRemaining -= 1;
    response.json({ success: false, message: "隔离账号读取失败" });
    return;
  }
  const users = [{
    id: "user-1", uid: "10001", name: "测试账号", favoritesCount: 1,
    expiresText: "测试会话", enabled: true,
    favorites: [{ mediaId: 101, title: "当前收藏夹" }],
    authHealth: { level: "ok", summary: "测试授权正常", detail: "隔离测试数据" },
  }];
  if (state.usersMode === "double") users.push({
    id: "user-2", uid: "10002", name: "第二账号", favoritesCount: 1,
    expiresText: "测试会话", enabled: false,
    favorites: [{ mediaId: 202, title: "第二收藏夹" }],
    authHealth: { level: "ok", summary: "测试授权正常", detail: "隔离测试数据" },
  });
  response.json(ok(users));
});
app.get("/api/users/:id/favorites", async (request, response) => {
  const userId = String(request.params.id || "");
  state.favoriteQueries.push(userId);
  if (state.favoriteRace && userId === "user-1") await wait(650);
  const second = userId === "user-2";
  response.json(ok([{
    mediaId: second ? 202 : 101,
    title: second ? "第二账号收藏夹" : "第一账号收藏夹",
    mediaCount: second ? 22 : 11,
    selected: true,
    cover: "",
  }]));
});
app.put("/api/users/:id/favorites", (request, response) => {
  state.favoriteSaveCount += 1;
  if (state.favoriteSaveFailuresRemaining > 0) {
    state.favoriteSaveFailuresRemaining -= 1;
    response.json({ success: false, message: "隔离收藏夹保存失败" });
    return;
  }
  response.json(ok(request.body?.mediaIds || []));
});
app.patch("/api/users/:id", async (request, response) => {
  state.userPatchCount += 1;
  state.userPatchBodies.push(request.body ?? null);
  await wait(180);
  response.json(ok({ id:request.params.id, enabled:Boolean(request.body?.enabled) }));
});
app.post("/api/users/:id/refresh-info", (_request, response) => response.json(ok({ refreshed: true })));
app.post("/api/users/:id/refresh-auth", (_request, response) => response.json(ok({ refreshed: true })));
app.post("/api/users/login/start", (_request, response) => {
  state.loginStartCount += 1;
  response.json(ok({
    loginId:`login-${state.loginStartCount}`,
    qrDataUrl:"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  }));
});
app.get("/api/users/login/status", (request, response) => {
  const loginId = String(request.query.loginId || "");
  state.loginStatusQueries.push(loginId);
  const completed = state.loginMode === "first_complete_then_pending" && loginId === "login-1";
  response.json(ok({ status:completed ? "completed" : "pending" }));
});
app.post("/api/sync/now", async (_request, response) => {
  state.syncNowCount += 1;
  await wait(180);
  response.json(ok({ queued:true }));
});
app.post("/api/sync/reconcile-remote", (_request, response) => response.json(ok({ queued:true })));
app.post("/api/sync/reconcile", (_request, response) => response.json(ok({ queued:true })));
app.get("/api/quality-upgrade/state", (_request, response) => response.json(ok({ running: [], completed: [] })));
app.get("/api/queue/state", (_request, response) => {
  const manualWaitQueue = state.queueBoardMode === "manual_wait";
  const mediaRetryQueue = state.queueBoardMode === "media_retry";
  const partialUploadQueue = state.queueBoardMode === "partial_upload";
  const queueItems = manualWaitQueue ? [{
    id: "job-remote-visibility",
    bvid: "BV1wzGP6jEPh",
    title: "99ninth_ AZUR LANE 2026 Summer Festival…",
    upperName: "-キリリ-",
    cover: "",
    folderTitle: "惨6",
    remotePath: "",
    userId: "user-1",
    mediaId: 101,
    detail: "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
    status: "manual_wait",
    phase: "background_wait",
    nextAction: "recheck",
    nextActionAt: Date.now() + 5 * 60_000,
    retries: 0,
    maxRetries: 3,
    actionRequired: false,
    recoveryDisposition: "background",
  }] : mediaRetryQueue ? [{
    id: "job-media-retry",
    bvid: "BV1kg8Y6zEnZ",
    title: "严格媒体规格重试",
    upperName: "测试UP",
    cover: "",
    folderTitle: "当前收藏夹",
    remotePath: "",
    userId: "user-1",
    mediaId: 101,
    detail: "新候选未通过远端确认；系统已停止替换并保留原归档。",
    status: "manual_wait",
    phase: "manual_action",
    nextAction: "recheck",
    retries: 0,
    maxRetries: 3,
    actionRequired: true,
    awaitingManualRecovery: true,
    recoveryJobId: "job-media-retry",
    recoveryDisposition: "action_required",
    recoveryIssueId: "upload.job-media-retry",
    recoveryKind: "encoding_retry_failed",
    recoveryActions: [{ id: "redownload_with_encoding", label: "重新选择画质与编码" }],
  }] : partialUploadQueue ? [{
    id: "job-partial-upload",
    bvid: "BV1PARTIAL01",
    title: "多分P部分上传",
    upperName: "测试UP",
    cover: "",
    folderTitle: "当前收藏夹",
    remotePath: "",
    userId: "user-1",
    mediaId: 101,
    detail: "已确认 2/5 个分P，剩余 3 个等待处理；已确认分P不会重复上传。",
    status: "manual_wait",
    phase: "manual_action",
    lifecycleState: "partial_upload",
    verifiedPages: 2,
    totalPages: 5,
    nextAction: "recheck",
    retries: 0,
    maxRetries: 3,
    actionRequired: true,
    awaitingManualRecovery: true,
    recoveryJobId: "job-partial-upload",
    recoveryDisposition: "action_required",
    recoveryIssueId: "upload.job-partial-upload",
    recoveryKind: "remote_visibility_timeout",
    recoveryActions: [{ id: "recheck", label: "重新确认" }],
  }] : [];
  const candidateIssue = state.recoveryIssueKind === "candidate";
  const issueByKind = {
    visibility: {
      kind: "remote_visibility_timeout",
      severity: "info",
      title: "远端文件仍在等待可见",
      summary: "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
      recommendedAction: { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
      availableActions: [{ id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" }],
    },
    candidate: {
      kind: "conflict_candidate_ready",
      severity: "info",
      title: "远端冲突候选等待选择",
      summary: "正式旧路径保持不变，新文件候选已完整验证；请选择保留现有归档或采用候选。",
      recommendedAction: { id: "keep_existing", label: "保留现有归档", description: "继续使用正式旧路径，候选文件仍保留。" },
      availableActions: [
        { id: "keep_existing", label: "保留现有归档", description: "继续使用正式旧路径，候选文件仍保留。" },
        { id: "use_candidate", label: "采用新候选", description: "将候选设为当前归档，正式旧路径仍保留。" },
        { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
        { id: "abandon_attempt", label: "放弃本次候选", description: "结束当前候选并保留原归档。" },
      ],
    },
    create_candidate: {
      kind: "remote_size_conflict",
      severity: "danger",
      title: "远端文件与本地候选冲突",
      summary: "完整本地文件组已通过预检，可以上传到隔离候选目录等待选择。",
      recommendedAction: { id: "create_candidate", label: "生成隔离候选", description: "正式旧路径保持不变。" },
      availableActions: [
        { id: "create_candidate", label: "生成隔离候选", description: "正式旧路径保持不变。" },
        { id: "recheck", label: "重新检查远端", description: "只读取远端状态。" },
      ],
    },
    download: {
      kind: "download_account_required",
      severity: "danger",
      title: "当前账号无法继续下载",
      summary: "任务和本地进度已保留，可以先验证备用账号后继续。",
      recommendedAction: {
        id: "retry_download_with_account",
        label: "换账号下载",
        description: "只更换本次下载账号，收藏来源和上传目标保持不变。",
        choices: [{ value: "user-2", label: "备用账号（UID 20002）" }],
      },
      availableActions: [
        {
          id: "retry_download_with_account",
          label: "换账号下载",
          description: "只更换本次下载账号，收藏来源和上传目标保持不变。",
          choices: [{ value: "user-2", label: "备用账号（UID 20002）" }],
        },
        { id: "retry_download", label: "重新下载一次", description: "继续使用当前账号。" },
        { id: "defer_download", label: "暂缓24小时", description: "保留进度后暂缓。" },
      ],
    },
    quality: {
      kind: "quality_failed",
      severity: "warning",
      title: "画质重调遇到编码问题",
      summary: "旧归档仍然可用，可以保持目标画质并生成新的编码版本。",
      recommendedAction: {
        id: "retry_quality_with_encoding",
        label: "重新选择画质与编码",
        description: "读取可用组合和大小后生成独立的新版本。",
        mediaProfile: { quality: true, encoding: true },
      },
      availableActions: [
        {
          id: "retry_quality_with_encoding",
          label: "重新选择画质与编码",
          description: "读取可用组合和大小后生成独立的新版本。",
          mediaProfile: { quality: true, encoding: true },
        },
        { id: "retry_quality", label: "重新尝试画质重调", description: "使用原参数重试。" },
      ],
    },
    storage: {
      kind: "remote_permission",
      severity: "danger",
      title: "远端存储认证或权限异常",
      summary: "请先检查当前草稿配置的只读连接，再决定是否保存设置。",
      recommendedAction: { id: "open_settings", label: "检查存储配置", description: "打开设置并执行只读检查。" },
      availableActions: [
        { id: "open_settings", label: "检查存储配置", description: "打开设置并执行只读检查。" },
        { id: "recheck", label: "重新检查远端", description: "使用已保存配置复核。" },
      ],
    },
  } as const;
  const configuredIssue = issueByKind[state.recoveryIssueKind];
  const issues = state.recoveryIssueEmpty || state.recoveryIssueResolved ? [] : [{
    id: "upload.test-recovery",
    ...configuredIssue,
    protectedFacts: ["没有自动覆盖或删除远端文件", "没有把未确认文件标记为归档成功", "本地文件仍保留"],
    bvid: "BV1RECOVERY1",
    userId: "user-1",
    videoTitle: "测试归档视频：新候选待确认",
    upperName: "测试UP主",
    folderTitle: "当前收藏夹",
    fileName: "P1.mp4",
    occurredAt: Date.parse("2026-08-17T12:00:00.000Z"),
    checkedAt: Date.parse("2026-08-17T12:05:00.000Z"),
    nextAutomaticCheckAt: Date.parse("2026-08-17T12:10:00.000Z"),
    safeDiagnostic: "{\n  \"issue\": \"remote_visibility_timeout\",\n  \"bvid\": \"BV1RECOVERY1\"\n}",
  }];
  const disposition = candidateIssue
    ? "intentional_confirmation"
    : (state.recoveryIssueKind === "visibility" ? "background" : "action_required");
  const visibleIssues = disposition === "background" ? [] : issues.map((issue) => ({ ...issue, disposition }));
  response.json(ok({
    downloadPending: [], downloadRunning: [], uploadPending: queueItems, uploadRunning: [],
    scheduler: {
      status: "idle",
      title: manualWaitQueue ? "同步空闲，后台队列待处理" : "当前调度空闲",
      detail: "没有运行中的任务",
      queuedActions: [],
    },
    issues: visibleIssues,
    backgroundRecoveries: disposition === "background" ? issues.map((issue) => ({ ...issue, disposition })) : [],
    actionRequiredIssues: disposition === "action_required" ? visibleIssues : [],
    intentionalConfirmations: candidateIssue ? visibleIssues : [],
    issueSummary: {
      total: disposition === "action_required" ? 1 : 0,
      danger: disposition === "action_required" && configuredIssue.severity === "danger" ? 1 : 0,
      warning: disposition === "action_required" && configuredIssue.severity === "warning" ? 1 : 0,
      info: 0,
      actionRequired: disposition === "action_required" ? 1 : 0,
      intentional: candidateIssue ? 1 : 0,
      background: disposition === "background" ? 1 : 0,
    },
    recovery: manualWaitQueue || partialUploadQueue ? { pendingUploads: 1 } : {},
    chargingAccess: {}, downloadRecovery: {}, uploadHealth: { state: "closed" }, downloadApiHealth: { state: "healthy" },
  }));
});
app.post("/api/recovery-issues/:id/actions/:action", (request, response) => {
  state.recoveryActionCount += 1;
  state.lastRecoveryAction = request.params.action;
  state.lastRecoveryBody = request.body ?? null;
  state.recoveryIssueResolved = true;
  response.json(ok({ issues: [] }));
});
app.get("/api/logs/stream", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.flushHeaders();
  response.write(": ready\n\n");
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10_000);
  heartbeat.unref?.();
  request.on("close", () => clearInterval(heartbeat));
});

app.get("/api/archive-library/navigation", (_request, response) => response.json(ok(navigation())));
app.get("/api/archive-library/items", async (request, response) => {
  const query = String(request.query.q || "");
  state.itemQueries.push(query);
  if (query === "slow") await wait(700);
  if (query === "broken") {
    await wait(300);
    response.json({ success:false, message:"隔离归档读取失败" });
    return;
  }
  const items = query === "duplicates"
    ? [{ ...baseItems[0] }, { ...baseItems[0] }]
    : archiveItems(query);
  response.json(ok({
    items,
    pageSize: 50,
    hasMore: false,
    nextCursor: null,
    summary: {
      total: items.length,
      playable: items.filter((item) => item.playback.available).length,
      pending: 0,
      issue: items.filter((item) => !item.playback.available).length,
    },
  }));
});
app.get("/api/archive-library/items/:bvid", (request, response) => {
  state.detailQueries.push(String(request.query.q || ""));
  response.json(ok(detailItem(request.params.bvid)));
});
app.post("/api/archive-library/items/:bvid/deletion-preview", (_request, response) => {
  state.previewCount += 1;
  response.json(ok({ previewId: "source-preview", fileCount: 2, totalBytes: 15 * 1024 * 1024, sharedCount: 0 }));
});
app.get("/api/archive-library/playback-queue", (_request, response) => response.json(ok({
  mode: "library", page: 1, pageSize: 50, total: 0, focusIndex: -1, items: [],
})));

app.get("/api/online-content/navigation", (_request, response) => {
  state.onlineNavigationCount += 1;
  const sources = [{ kind: "favorite", mediaId: 101, title: "在线收藏夹", count: 11, countLabel: "个视频" }];
  if (state.onlineSourceRace) sources.push({ kind: "favorite", mediaId: 202, title: "第二在线收藏夹" });
  response.json(ok({
    accounts: [{
      userId: "user-1",
      name: "测试账号",
      sources,
    }],
  }));
});
app.get("/api/online-content/items", async (request, response) => {
  const query = String(request.query.q || "");
  const mediaId = Number(request.query.mediaId || 0);
  state.onlineItemQueries.push(query);
  if (query === "slow" || (state.onlineSourceRace && mediaId === 101)) await wait(650);
  if (query === "broken") {
    response.json({ success:false, message:"隔离在线内容读取失败" });
    return;
  }
  const suffix = mediaId === 202 ? "SECOND" : "001";
  const title = mediaId === 202 ? "第二在线来源" : query ? `在线搜索 ${query}` : "在线待归档视频";
  const item = {
    id: `online-item-${suffix}`,
    userId: "user-1",
    kind: "favorite",
    bvid: mediaId === 202 ? "BV1ONLINE002" : "BV1ONLINE001",
    title,
    upperName: "在线UP主",
    archiveState: "unarchived",
    openUrl: mediaId === 202 ? "https://www.bilibili.com/video/BV1ONLINE002" : "https://www.bilibili.com/video/BV1ONLINE001",
  };
  response.json(ok({
    items: state.onlineDuplicateMode ? [item, { ...item }] : [item],
    page: { page: 1, pageSize: 50, total: 1, hasMore: false, nextCursor: null },
  }));
});
app.post("/api/media-probe", (request, response) => {
  state.mediaProbeStartCount += 1;
  state.mediaProbeBodies.push(request.body ?? null);
  response.status(202).json(ok({ probeId: "probe-online-1", status: "running", bvid: "BV1ONLINE001" }));
});
app.get("/api/media-probe/:id", (_request, response) => {
  if (state.mediaProbeMode === "failed") {
    response.json(ok({
      probeId: "probe-online-1",
      bvid: "BV1RECOVERY1",
      status: "failed",
      error: "B站当前返回稿件不可见，暂时无法确认可用画质、编码和大小",
    }));
    return;
  }
  if (state.mediaProbeMode === "refine_mismatch" && state.mediaProbeStartCount > 1) {
    response.json(ok({
      probeId: "probe-online-1",
      bvid: "BV1RECOVERY1",
      status: "complete",
      pages: [{ pageIndex: 1, cid: "cid-online-1", tracks: [
        { bilibiliQuality: "4K", quality: "4K", codec: "av01", encoding: "AV1", resolution: "2160x3840", frameRate: 60, estimatedBytes: 24 * 1024 * 1024, sizeSource: "api", available: true },
      ] }],
      combinations: [
        { bilibiliQuality: "4K", quality: "4K", codec: "av01", encoding: "AV1", resolution: "2160x3840", frameRate: 60, estimatedBytes: 24 * 1024 * 1024, sizeSource: "api", available: true, pageCount: 1, availablePageCount: 1, totalBytes: 27 * 1024 * 1024, totalBytesKind: "final", totalSizeSource: "api" },
      ],
    }));
    return;
  }
  response.json(ok({
  probeId: "probe-online-1",
  bvid: "BV1ONLINE001",
  status: "complete",
  pages: [{ pageIndex: 1, cid: "cid-online-1", tracks: [
    { bilibiliQuality: "4K", quality: "4K", codec: "av01", encoding: "AV1", resolution: "2160x3840", frameRate: 60, duration: 120, estimatedBytes: 24 * 1024 * 1024, sizeSource: "api", available: true },
    { bilibiliQuality: "1080P", quality: "1080P", codec: "hevc", encoding: "HEVC", resolution: "1080x1920", frameRate: 60, duration: 120, estimatedBytes: 12 * 1024 * 1024, sizeSource: "api", available: true },
  ] }],
  combinations: [
    { bilibiliQuality: "4K", quality: "4K", codec: "av01", encoding: "AV1", resolution: "2160x3840", frameRate: 60, duration: 120, estimatedBytes: 24 * 1024 * 1024, sizeSource: "api", available: true, pageCount: 1, availablePageCount: 1, totalVideoBytes: 24 * 1024 * 1024, totalAudioBytes: 2 * 1024 * 1024, totalBytes: 27 * 1024 * 1024, totalBytesKind: "final", peakBytes: 53 * 1024 * 1024, totalSizeSource: "api" },
    { bilibiliQuality: "1080P", quality: "1080P", codec: "hevc", encoding: "HEVC", resolution: "1080x1920", frameRate: 60, duration: 120, estimatedBytes: 12 * 1024 * 1024, sizeSource: "api", available: true, pageCount: 1, availablePageCount: 1, totalVideoBytes: 12 * 1024 * 1024, totalAudioBytes: 2 * 1024 * 1024, totalBytes: 15 * 1024 * 1024, totalBytesKind: "final", peakBytes: 29 * 1024 * 1024, totalSizeSource: "range" },
  ],
  estimatedBytes: 24 * 1024 * 1024,
  estimatedBytesKind: "final",
  estimatedPeakBytes: 50 * 1024 * 1024,
  cacheAvailableBytes: 512 * 1024 * 1024,
  estimatedBytesSource: "api",
  }));
});
app.post("/api/online-content/manual-archive", (_request, response) => {
  state.manualArchiveCount += 1;
  response.status(202).json(ok({ status: "queued", bvid: "BV1ONLINE001" }));
});

app.post("/api/users/:id/removal-preview", (_request, response) => response.json(ok({
  previewId: "account-preview", relationCount: 2, sourceCount: 1, fileCount: 2,
  totalBytes: 15 * 1024 * 1024, sharedCount: 0, activeTasks: 0,
})));
app.delete("/api/users/:id", async (_request, response) => {
  state.accountDeleteCount += 1;
  if (state.accountDeleteDelayMs) await wait(state.accountDeleteDelayMs);
  response.status(202).json(ok({ operation: { id: "account-operation" } }));
});
app.post("/api/archive-deletions/:id/repreview", (request, response) => response.json(ok({
  scope: request.params.id === "account-operation" ? "account" : "source",
  previewId: request.params.id === "account-operation" ? "account-preview-2" : "source-preview-2",
  fileCount: 2,
  totalBytes: 15 * 1024 * 1024,
  sharedCount: 0,
})));
app.post("/api/archive-deletions/:id/start", async (request, response) => {
  if (request.params.id.startsWith("account")) state.accountStartCount += 1;
  else state.startCount += 1;
  if (!request.params.id.startsWith("account") && state.sourceStartDelayMs) await wait(state.sourceStartDelayMs);
  const id = request.params.id.startsWith("account") ? "account-operation-2" : "source-operation";
  response.status(202).json(ok({ id, status: "pending", fileCount: 2, completedCount: 0 }));
});
app.get("/api/archive-deletions/:id", (request, response) => {
  if (request.params.id.startsWith("account")) {
    response.json(ok({ id: request.params.id, status: "failed", fileCount: 2, completedCount: 0, lastError: "隔离测试失败" }));
    return;
  }
  state.sourceStatusPolls += 1;
  const completed = state.sourceCompletionMode === "complete" && state.sourceStatusPolls >= 2;
  if (completed) state.sourceDeleted = true;
  response.json(ok({
    id: request.params.id,
    status: completed ? "completed" : "running",
    fileCount: 2,
    completedCount: completed ? 2 : 0,
    retainedCount: 0,
  }));
});
app.post("/api/archive-deletions/:id/retry", (_request, response) => response.json(ok({ accepted: true })));

export async function startFakeUiServer() {
  return new Promise<() => Promise<void>>((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = app.listen(port, "127.0.0.1");
    server.once("error", reject);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("listening", () => {
      resolve(() => new Promise<void>((closeResolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => closeResolve());
      }));
    });
  });
}
