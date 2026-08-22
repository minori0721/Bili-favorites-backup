import express from "express";
import type { Socket } from "node:net";
import { renderAppPage } from "../../src/web.js";

const app = express();
const port = 43197;

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
  recoveryIssueResolved: boolean;
  recoveryIssueKind: "visibility" | "candidate";
  recoveryIssueEmpty: boolean;
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
    recoveryIssueResolved: false,
    recoveryIssueKind: "visibility",
    recoveryIssueEmpty: false,
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
  if (request.body?.recoveryIssueKind === "candidate") state.recoveryIssueKind = "candidate";
  state.recoveryIssueEmpty = request.body?.recoveryIssueEmpty === true;
  response.json(state);
});
app.get("/__test/state", (_request, response) => response.json(state));

app.get("/", (_request, response) => response.type("html").send(renderAppPage()));
app.get("/api/config", (_request, response) => response.json(ok({
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
})));
app.get("/api/users", (_request, response) => response.json(ok([{
  id: "user-1",
  uid: "10001",
  name: "测试账号",
  favoritesCount: 1,
  expiresText: "测试会话",
  enabled: true,
  favorites: [{ mediaId: 101, title: "当前收藏夹" }],
  authHealth: { level: "ok", summary: "测试授权正常", detail: "隔离测试数据" },
}])));
app.get("/api/quality-upgrade/state", (_request, response) => response.json(ok({ running: [], completed: [] })));
app.get("/api/queue/state", (_request, response) => {
  const candidateIssue = state.recoveryIssueKind === "candidate";
  const issues = state.recoveryIssueEmpty || state.recoveryIssueResolved ? [] : [{
    id: "upload.test-recovery",
    kind: candidateIssue ? "conflict_candidate_ready" : "remote_visibility_timeout",
    severity: "info",
    title: candidateIssue ? "远端冲突候选等待选择" : "远端文件仍在等待可见",
    summary: candidateIssue
      ? "正式旧路径保持不变，新文件候选已完整验证；请选择保留现有归档或采用候选。"
      : "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
    protectedFacts: ["没有自动覆盖或删除远端文件", "没有把未确认文件标记为归档成功", "本地文件仍保留"],
    recommendedAction: candidateIssue
      ? { id: "keep_existing", label: "保留现有归档", description: "继续使用正式旧路径，候选文件仍保留。" }
      : { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
    availableActions: candidateIssue ? [
      { id: "keep_existing", label: "保留现有归档", description: "继续使用正式旧路径，候选文件仍保留。" },
      { id: "use_candidate", label: "采用新候选", description: "将候选设为当前归档，正式旧路径仍保留。" },
      { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
    ] : [
      { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
      { id: "reupload", label: "继续上传", description: "仅为当前文件授权一次重新上传。", danger: true },
    ],
    bvid: "BV1RECOVERY1",
    folderTitle: "当前收藏夹",
    fileName: "P1.mp4",
    occurredAt: Date.parse("2026-08-17T12:00:00.000Z"),
    checkedAt: Date.parse("2026-08-17T12:05:00.000Z"),
    nextAutomaticCheckAt: Date.parse("2026-08-17T12:10:00.000Z"),
    safeDiagnostic: "{\n  \"issue\": \"remote_visibility_timeout\",\n  \"bvid\": \"BV1RECOVERY1\"\n}",
  }];
  const disposition = candidateIssue ? "intentional_confirmation" : "background";
  const visibleIssues = disposition === "background" ? [] : issues.map((issue) => ({ ...issue, disposition }));
  response.json(ok({
    downloadPending: [], downloadRunning: [], uploadPending: [], uploadRunning: [],
    scheduler: { status: "idle", title: "当前调度空闲", detail: "没有运行中的任务", queuedActions: [] },
    issues: visibleIssues,
    backgroundRecoveries: disposition === "background" ? issues.map((issue) => ({ ...issue, disposition })) : [],
    actionRequiredIssues: [],
    intentionalConfirmations: candidateIssue ? visibleIssues : [],
    issueSummary: { total: 0, danger: 0, warning: 0, info: 0, actionRequired: 0, intentional: candidateIssue ? 1 : 0, background: candidateIssue ? 0 : 1 },
    recovery: {}, chargingAccess: {}, downloadRecovery: {}, uploadHealth: { state: "closed" }, downloadApiHealth: { state: "healthy" },
  }));
});
app.post("/api/recovery-issues/:id/actions/:action", (_request, response) => {
  state.recoveryActionCount += 1;
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
  const items = archiveItems(query);
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
