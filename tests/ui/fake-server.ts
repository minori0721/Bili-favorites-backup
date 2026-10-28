import express from "express";
import type { Socket } from "node:net";
import path from 'node:path';
import { renderAppPage } from "../../src/web.js";
import { serveAppAsset } from "../../src/web/server/assets.js";
import {createUpUiFixture} from './up-fixture.js';
import {createUpSubscriptionRouter} from '../../src/http/up-subscriptions.js';
import {createArchiveVideoActionsRouter} from '../../src/http/archive-video-actions.js';
import {cleanupItemRequiresIdle} from '../../src/shared/storage-cleanup.js';
import {createHttpErrorHandler} from '../../src/http/request-boundary.js';
import { updatesFixture, isUpdateScenario, type UpdateScenario } from '../fixtures/updates.js';

const app = express();
const port = Number(process.env.BFB_FAKE_UI_PORT || 43197);
const detailPreviewDelay = process.env.BFB_DETAILS_PREVIEW === '1' ? 650 : 0;

type TestState = {
  onboardingPending: boolean;
  onboardingEmpty: boolean;
  onboardingSeenCount: number;
  archiveActionPreview: boolean;
  cleanupBusy: boolean;
  updatesMode: UpdateScenario;
  updateRequests: number;
  installedNotice: string | null;
  installedNoticeSeenCount: number;
  previewCount: number;
  startCount: number;
  accountStartCount: number;
  accountDeleteCount: number;
  accountDeleteDelayMs: number;
  sourceStartDelayMs: number;
  sourceStatusPolls: number;
  sourceCompletionMode: "pending" | "complete";
  sourceDeleted: boolean;
  retainedArchivePreview: boolean;
  itemQueries: string[];
  detailQueries: string[];
  recoveryActionCount: number;
  lastRecoveryAction: string;
  lastRecoveryBody: unknown;
  recoveryIssueResolved: boolean;
  recoveryIssueKind: "visibility" | "source_wait" | "evidence_wait" | "reprobe_exhausted" | "candidate" | "create_candidate" | "download" | "quality" | "storage";
  recoveryIssueEmpty: boolean;
  storageCheckCount: number;
  storageCheckBody: unknown;
  storageCheckMode: "ok" | "path_error";
  queueBoardMode: "empty" | "manual_wait" | "media_retry" | "partial_upload";
  onlineNavigationCount: number;
  onlineItemQueries: string[];
  mediaProbeStartCount: number;
  mediaProbeBodies: unknown[];
  mediaProbeBvid: string;
  mediaProbeMode: "complete" | "failed" | "refine_mismatch";
  manualArchiveCount: number;
  configRequests: number;
  configFailuresRemaining: number;
  savedConfig: unknown;
  userRequests: number;
  userFailuresRemaining: number;
  usersMode: "single" | "double";
  favoriteQueries: string[];
  favoriteCoverQueries: string[];
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
  pathMigration: {id:string;status:string;sourceRoot:string;destinationRoot:string;entryCount:number;fileCount:number;totalBytes:number;conflictCount:number;failedCount:number} | null;
};

function initialState(): TestState {
  return {
    onboardingPending: false, onboardingEmpty: false, onboardingSeenCount: 0,
    archiveActionPreview: process.env.BFB_ARCHIVE_ACTION_PREVIEW === '1',
    cleanupBusy: false,
    updatesMode: process.env.BFB_UPDATE_PREVIEW === '1' ? 'dev-update' : 'current',
    updateRequests: 0,
    installedNotice: null,
    installedNoticeSeenCount: 0,
    previewCount: 0,
    startCount: 0,
    accountStartCount: 0,
    accountDeleteCount: 0,
    accountDeleteDelayMs: 0,
    sourceStartDelayMs: 0,
    sourceStatusPolls: 0,
    sourceCompletionMode: "pending",
    sourceDeleted: false,
    retainedArchivePreview: false,
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
    mediaProbeBvid: 'BV1ONLINE001',
    mediaProbeMode: "complete",
    manualArchiveCount: 0,
    configRequests: 0,
    configFailuresRemaining: 0,
    savedConfig: null,
    userRequests: 0,
    userFailuresRemaining: 0,
    usersMode: "single",
    favoriteQueries: [],
    favoriteCoverQueries: [],
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
    pathMigration:null,
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
    upperMid: 163637592,
    statusGroup: "playable",
    backupStatus: "verified" as const,
    unavailable: false,
    membershipCount: 1,
    memberships: [{ userId: "u1", mediaId: 1, folderTitle: "历史收藏夹" }],
    playback: { available: true, partial: false, partCount: 1, actualQuality: "1080p" },
  },
  {
    bvid: "BV1BETA0002",
    title: "Beta 历史归档",
    upperName: "另一位UP主",
    statusGroup: "issue",
    backupStatus: "missing" as const,
    unavailable: true,
    sourceAvailability: {
      state: "dormant" as const,
      reason: "api_not_found",
      firstSeenAt: "2026-07-01T08:00:00.000Z",
      lastCheckedAt: "2026-08-01T08:00:00.000Z",
      checkRound: 3,
    },
    membershipCount: 1,
    memberships: [{ userId: "u1", mediaId: 2, folderTitle: "已停用收藏夹" }],
    playback: { available: false, partial: false, partCount: 0 },
  },
];

const retainedItem = {
  ...baseItems[0],
  bvid: "BV1GAMMA003",
  title: "Gamma 留存归档",
  unavailable: true,
  sourceAvailability: {
    state: "pending_confirmation" as const,
    reason: "favorite_flag",
    firstSeenAt: "2026-07-01T08:00:00.000Z",
    lastCheckedAt: "2026-08-01T08:00:00.000Z",
    checkRound: 3,
  },
};

function archiveItems(query: string) {
  const normalized = query.trim().toLowerCase();
  if (normalized === "fast") {
    return [{ ...baseItems[0], bvid: "BV1FAST0003", title: "Fast 快速结果" }];
  }
  if (normalized === "slow") {
    return [{ ...baseItems[0], bvid: "BV1SLOW0004", title: "Slow 慢速结果" }];
  }
  const visible = (state.retainedArchivePreview ? [...baseItems, retainedItem] : baseItems)
    .filter((item) => !state.sourceDeleted || item.bvid !== "BV1ALPHA001");
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
      uid: 10001,
      name: "测试账号",
      removed: false,
      summary,
      folders: [{ mediaId: 101, title: "当前收藏夹", artworkUrl:'/api/archive-library/artwork?userId=user-1&mediaId=101', ...summary }],
      inactiveFolders: [{ mediaId: 202, title: "历史收藏夹", artworkUrl:'/api/archive-library/artwork?userId=user-1&mediaId=202', ...summary }],
    }],
  };
}

function detailItem(bvid: string) {
  const item = (state.retainedArchivePreview ? [...baseItems, retainedItem] : baseItems)
    .find((candidate) => candidate.bvid === bvid) || baseItems[0];
  return {
    ...item,
    memberships: [{
      userId: "user-1",
      mediaId: 202,
      userName: "测试账号",
      folderTitle: "历史收藏夹",
      backupStatus: "verified" as const,
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
const upFixture=createUpUiFixture();
app.get('/api/archive-library/artwork',(_request,response)=>{
  response.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100"><rect width="160" height="100" fill="#75a89b"/><path d="M0 100L60 25L110 75L160 40V100" fill="#397b70"/></svg>');
});
app.post('/api/archive-library/folders/deletion-preview',(request,response,next)=>{
  try{response.json(ok(upFixture.deletion.previewInactiveFolder(request.body.userId,request.body.mediaId)));}catch(error){next(error);}
});
if(state.archiveActionPreview)upFixture.seedArchiveActions();
app.use(createArchiveVideoActionsRouter({service:upFixture.videoActions,boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
app.get('/api/archive-deletions/:id',(req,res,next)=>{const operation=upFixture.deletion.get(req.params.id);if(!operation)return next();res.json(ok(operation));});
app.post('/api/archive-deletions/:id/:action',async(req,res,next)=>{
  if(!upFixture.deletion.get(req.params.id))return next();
  try {const action=req.params.action;
    if(action==='start')res.status(202).json(ok(upFixture.deletion.start(req.params.id,req.body.confirmation)));
    else if(action==='retry')res.status(202).json(ok(upFixture.deletion.retry(req.params.id)));
    else if(action==='repreview')res.json(ok(upFixture.deletion.repreview(req.params.id)));
    else if(action==='stop'){
      if(req.body.confirmation!=='STOP ARCHIVE CLEANUP')throw Object.assign(new Error('停止确认文字不匹配'),{statusCode:400});
      res.json(ok(await upFixture.deletion.stopRemaining(req.params.id)));
    }
    else next();
  }catch(error){next(error);}
});
  app.post('/__test/up-deletion-failure',(req,res)=>{upFixture.setDeletionFailure(req.body.enabled===true);res.json({success:true});});
app.get('/api/up-subscriptions',(_req,res,next)=>{if(state.onboardingEmpty)res.json(ok({items:[],accounts:[],operations:[]}));else next();});
app.use(createUpSubscriptionRouter({service:upFixture.service,boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
app.get('/__up/:kind/:id.svg',(req,res)=>{
  const colors=['#247f76','#568ca1','#aa8561','#6e8274','#836c91','#658f87','#91766c','#5f7d8b'];const index=Number.parseInt(req.params.id,10)%colors.length;
  const avatar=req.params.kind==='avatar';
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${avatar?640:360}" viewBox="0 0 640 ${avatar?640:360}"><rect width="640" height="640" fill="${colors[index]??colors[0]}"/><circle cx="510" cy="60" r="180" fill="white" opacity=".09"/><path d="M0 330L180 130L320 270L490 100L640 310V640H0Z" fill="#132f32" opacity=".25"/><path d="M0 340L190 220L350 320L640 150V640H0Z" fill="white" opacity=".12"/><text x="${avatar?320:44}" y="${avatar?375:272}" text-anchor="${avatar?'middle':'start'}" fill="white" font-family="sans-serif" font-size="${avatar?150:35}" font-weight="600">${avatar?'UP':['影像与时间','一起看见世界','山野之间','记录日常','光的故事','无限进步','留住记忆','另一种可能'][index]??'留存'}</text><text x="44" y="315" fill="white" opacity=".6" font-family="sans-serif" font-size="15">BFB · ISOLATED PREVIEW</text></svg>`);
});

app.get("/__test/ready", (_request, response) => response.json({ ready: true }));
app.post("/__test/reset", async (request, response) => {
  const updatesMode: unknown = request.body?.updatesMode;
  await upFixture.reset(request.body?.onboardingNewInstall === true);
  state = initialState();
  state.onboardingPending = request.body?.onboardingNewInstall === true;
  state.onboardingEmpty = state.onboardingPending;
  if(request.body?.installedVersionChanged===true&&!state.onboardingPending)state.installedNotice='preview-installed-build';
  if(request.body?.archiveActionPreview===true)state.archiveActionPreview=true;
  if(state.archiveActionPreview&&!state.onboardingEmpty)upFixture.seedArchiveActions();
  state.cleanupBusy=request.body?.cleanupBusy===true;
  if (request.body?.sourceCompletionMode === "complete") state.sourceCompletionMode = "complete";
  state.retainedArchivePreview = request.body?.retainedArchivePreview === true;
  state.accountDeleteDelayMs = Math.max(0, Number(request.body?.accountDeleteDelayMs || 0));
  state.sourceStartDelayMs = Math.max(0, Number(request.body?.sourceStartDelayMs || 0));
  const recoveryIssueKind = String(request.body?.recoveryIssueKind || "");
  if (["visibility", "source_wait", "evidence_wait", "reprobe_exhausted", "candidate", "create_candidate", "download", "quality", "storage"].includes(recoveryIssueKind)) {
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
  if (isUpdateScenario(updatesMode)) state.updatesMode = updatesMode;
  response.json(state);
});
app.get("/__test/state", (_request, response) => response.json(state));
app.get('/api/onboarding', (_request,response)=>response.json(ok({autoStart:state.onboardingPending})));
app.post('/api/onboarding/seen', (_request,response)=>{state.onboardingSeenCount++;state.onboardingPending=false;response.json(ok({}));});
app.post('/__test/cleanup-busy',(req,res)=>{state.cleanupBusy=req.body.busy===true;res.json(ok({busy:state.cleanupBusy}));});

app.get('/assets/app/:name', serveAppAsset);
app.get('/assets/vendor/artplayer-5.4.0.js',(_request,response)=>response.sendFile(path.resolve('node_modules/artplayer/dist/artplayer.js')));
app.get('/api/users/:id/favorites/:mediaId/playback/files/:file',(_request,response)=>response.sendFile(path.resolve('tests/fixtures/playback-demo.mp4')));
app.get('/api/users/:id/favorites/:mediaId/playback/delivery/:file',(_request,response)=>response.json(ok({status:'proxy'})));
app.get("/", (_request, response) => {
  const controls=process.env.BFB_ARCHIVE_ACTION_PREVIEW==='1' ? `<aside style="position:fixed;bottom:8px;left:8px;z-index:20;background:#f9fdfd;border:1px solid #a7ded8;border-radius:12px;padding:10px;max-width:min(460px,94vw);font:12px sans-serif;color:#21403b"><strong>隔离假数据 · 不连接 B站或网盘</strong><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"><button onclick="fetch('/__test/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({archiveActionPreview:true})}).then(()=>location.reload())">重置示例</button><button onclick="fetch('/__test/cleanup-busy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({busy:true})}).then(()=>alert('已模拟任务忙碌，请重新打开清理数据'))">模拟忙碌</button><button onclick="fetch('/__test/cleanup-busy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({busy:false})}).then(()=>alert('已恢复空闲，请重新打开清理数据'))">恢复空闲</button><button onclick="fetch('/__test/up-deletion-failure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})}).then(()=>alert('后续远端删除将模拟失败，重置示例可恢复'))">模拟删除失败</button></div></aside>` : '';
  response.set('Cache-Control','no-store').type('html').send(renderAppPage().replace('</body>',controls+'</body>'));
});
app.get('/api/updates', (request, response) => {
  state.updateRequests++;
  if (isUpdateScenario(request.query.scenario)) state.updatesMode = request.query.scenario;
  response.json({ success: true, data: {...updatesFixture(state.updatesMode),installedNotice:state.installedNotice} });
});
app.post('/api/updates/installed/seen', (request,response)=>{
  if(request.body?.build!==state.installedNotice){response.status(409).json({success:false,message:'运行版本已变化'});return;}
  state.installedNoticeSeenCount++;state.installedNotice=null;response.json(ok({}));
});
app.get("/api/config", async (_request, response) => {
  state.configRequests += 1;
  if (state.configFailuresRemaining > 0) {
    state.configFailuresRemaining -= 1;
    response.json({ success: false, message: "隔离设置读取失败" });
    return;
  }
  if (state.savedConfig !== null) {
    response.json(ok(state.savedConfig));
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
app.put("/api/config", async (request, response) => {
  if (detailPreviewDelay) await wait(detailPreviewDelay);
  state.savedConfig = request.body;
  response.json(ok({}));
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
  if(state.onboardingEmpty){response.json(ok([]));return;}
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
app.get("/api/users/:id/favorites/:mediaId/cover", (request, response) => {
  state.favoriteCoverQueries.push(`${request.params.id}:${request.params.mediaId}`);
  response.type("gif").send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
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
app.post("/api/users/:id/refresh-info", async (_request, response) => { if (detailPreviewDelay) await wait(detailPreviewDelay); response.json(ok({ refreshed: true })); });
app.post("/api/users/:id/refresh-auth", async (_request, response) => { if (detailPreviewDelay) await wait(detailPreviewDelay); response.json(ok({ refreshed: true })); });
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
  if(completed)state.onboardingEmpty=false;
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
app.post('/api/quality-upgrade/preview',(_request,response)=>response.json(ok({
  candidates:state.archiveActionPreview ? [11,12].map((mediaId,index)=>({key:`u1:${mediaId}:BVARCHIVECOPIES`,userId:'u1',bvid:'BVARCHIVECOPIES',title:'独立副本示例：同一视频各存一份',ownerName:'隔离测试 UP',folderTitle:index?'收藏夹 B · 学习':'收藏夹 A · 日常',remotePath:index?'/backup/b':'/backup/a',reason:'720P → 自动最高可用画质',oldFiles:[{name:'independent.mp4',path:index?'/backup/b/independent.mp4':'/backup/a/independent.mp4'}]})) : [],
  uncertain:[],skipped:[],skippedTotal:0,target:{quality:'',encoding:'',hiRes:false,dolby:false},
})));
app.post('/api/quality-upgrade/start',(_request,response)=>response.json(ok({queued:[{bvid:'BVARCHIVECOPIES'}],skipped:[],downloadGroups:1})));
const previewCleanupItems=[
  {key:'memory-cache',label:'页面缓存',important:false,bytes:0},
  {key:'logs',label:'网页日志',important:false,bytes:12000},
  {key:'debug-logs',label:'Debug 日志',important:false,bytes:24000},
  {key:'online-covers',label:'在线缩略图缓存',important:false,bytes:3*1024*1024},
  {key:'exports',label:'导出压缩包',important:false,bytes:2*1024*1024},
  {key:'temp',label:'全部临时下载文件',important:true,bytes:32*1024*1024},
  {key:'orphan-fragments',label:'无法续传的下载残片',important:true,bytes:1024},
  {key:'covers',label:'归档封面（永久保存）',important:true,bytes:4*1024*1024},
  {key:'backups',label:'导入前备份（回滚副本）',important:true,bytes:2*1024*1024},
  {key:'state',label:'备份状态与持久化任务',important:true,bytes:200000},
  {key:'users',label:'账号登录信息',important:true,bytes:1000},
  {key:'config',label:'全局配置',important:true,bytes:1000},
];
app.get('/api/storage/cleanup',(_request,response)=>response.json(ok({items:previewCleanupItems,runningTransfers:state.cleanupBusy,activeScheduler:state.cleanupBusy})));
app.post('/api/storage/cleanup',async(request,response,next)=>{
  const items=Array.isArray(request.body.items)?previewCleanupItems.filter(item=>request.body.items.includes(item.key)):[];
  if(!items.length){response.status(400).json({success:false,message:'请选择要清理的内容'});return;}
  if(state.cleanupBusy && items.some(item=>cleanupItemRequiresIdle(item.key))){response.status(409).json({success:false,message:'当前有任务运行，请等待后再清理重要数据'});return;}
  const expected=items.length===previewCleanupItems.length?'DELETE ALL PROJECT DATA':items.length===1 && items[0].key==='covers'?'DELETE ARCHIVE COVERS':items.some(item=>item.important)?'DELETE':'';
  if(expected && request.body.confirmation!==expected){response.status(400).json({success:false,message:'确认文字不匹配'});return;}
  try {
    if(items.some(item=>item.key==='state'))await upFixture.clearState();
    if(items.some(item=>item.key==='users'))state.onboardingEmpty=true;
    response.json(ok({results:items.map(item=>({key:item.key,label:item.label,ok:true,note:item.key==='state'?'隔离 SQLite 业务状态已清空':'磁盘文件仅模拟；未访问用户数据'}))}));
  }catch(error){next(error);}
});
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
    status: "manual_wait" as const,
    phase: "background_wait" as const,
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
    status: "manual_wait" as const,
    phase: "manual_action" as const,
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
    status: "manual_wait" as const,
    phase: "manual_action" as const,
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
    reprobe_exhausted: {
      kind: 'download_retry_exhausted' as const, severity: 'warning', title: '自动下载恢复次数已用完',
      summary: '已安排三次独立下载恢复，原文件继续保留。',
      recommendedAction: { id: 'redownload', label: '重新下载', description: '安排一次独立下载，原文件与远端归档保留。' },
      availableActions: [
        { id: 'redownload', label: '重新下载', description: '安排一次独立下载，原文件与远端归档保留。' },
        { id: 'recheck', label: '重新检查远端', description: '复核恢复证据。' },
      ],
    },
    source_wait: {
      kind: 'recovery_source_wait' as const, severity: 'info', title: '等待来源恢复后重新探测',
      summary: '已有文件保留，等待访问探测恢复后再继续独立下载。',
      recommendedAction: { id: 'recheck', label: '重新检查远端', description: '复核恢复证据。' },
      availableActions: [{ id: 'recheck', label: '重新检查远端', description: '复核恢复证据。' }],
    },
    evidence_wait: {
      kind: 'recovery_evidence_wait' as const, severity: 'info', title: '等待后台重建恢复记录',
      summary: '恢复证据损坏，后台将尝试重建，文件已保留。',
      recommendedAction: { id: 'recheck', label: '重新检查远端', description: '复核恢复证据。' },
      availableActions: [{ id: 'recheck', label: '重新检查远端', description: '复核恢复证据。' }],
    },
    visibility: {
      kind: "remote_visibility_timeout" as const,
      severity: "info",
      title: "远端文件仍在等待可见",
      summary: "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
      recommendedAction: { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
      availableActions: [{ id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" }],
    },
    candidate: {
      kind: "conflict_candidate_ready" as const,
      severity: "info",
      title: "远端冲突候选等待选择",
      summary: "正式旧路径保持不变，新文件候选已完整验证；请选择保留现有归档或采用候选。",
      recommendedAction: { id: "keep_existing", label: "保留现有归档", description: "继续使用正式旧路径，候选文件仍保留。" },
      availableActions: [
        { id: "keep_existing", label: "保留现有归档", description: "继续使用正式旧路径，候选文件仍保留。" },
        { id: "use_candidate", label: "采用新候选", description: "将候选设为当前归档，正式旧路径仍保留。" },
        { id: "recheck", label: "立即重新检查", description: "只读取远端状态，不上传或删除文件。" },
        { id: "abandon_attempt", label: "停止本次尝试", description: "停止自动执行，不删除本地或远端文件。" },
      ],
    },
    create_candidate: {
      kind: "remote_size_conflict" as const,
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
      kind: "download_account_required" as const,
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
      kind: "quality_failed" as const,
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
      kind: "remote_permission" as const,
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
    : (["visibility", "source_wait", "evidence_wait"].includes(state.recoveryIssueKind) ? "background" : "action_required");
  const visibleIssues = disposition === "background" ? [] : issues.map((issue) => ({ ...issue, disposition }));
  response.json(ok({
    downloadPending: [], downloadRunning: [], uploadPending: queueItems, uploadRunning: [],
    summary:{running:0,waiting:queueItems.length},
    scheduler: {
      status: "idle" as const,
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
    chargingAccess: {}, downloadRecovery: {}, uploadHealth: { state: "closed" as const }, downloadApiHealth: { state: "healthy" as const },
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

app.get("/api/archive-library/navigation", (request, response) => response.json(ok(state.archiveActionPreview ? upFixture.archiveNavigation({includeReferenceStats:request.query.includeReferenceStats!=='false'}) : {...navigation(),upSubscriptions:upFixture.navigation()})));
app.get('/api/archive-library/reference-stats',(request,response,next)=>{
  if(state.archiveActionPreview || Number(request.query.mediaId)<=-2){
    try{response.json(ok(upFixture.referenceStats({scope:String(request.query.scope||'global') as 'global'|'account'|'folder',userId:String(request.query.userId||''),mediaId:request.query.mediaId===undefined?undefined:Number(request.query.mediaId)})));}catch(error){next(error);}return;
  }
  response.json(ok({sourceReferenceCount:4,uniqueRemotePathCount:3}));
});
app.get("/api/archive-library/items", async (request, response) => {
  if(state.archiveActionPreview || Number(request.query.mediaId)<=-2){response.json(ok(upFixture.items({...request.query,query:String(request.query.q||'')})));return;}
  if (detailPreviewDelay) await wait(detailPreviewDelay);
  const query = String(request.query.q || "");
  state.itemQueries.push(query);
  if (query === "slow") await wait(700);
  if (query === "broken") {
    await wait(300);
    response.json({ success:false, message:"隔离归档读取失败" });
    return;
  }
  const candidates = query === "duplicates"
    ? [{ ...baseItems[0] }, { ...baseItems[0] }]
    : archiveItems(query);
  const filter = String(request.query.filter || "all");
  const items = filter === "retained"
    ? candidates.filter((item) => item.playback.available && item.unavailable)
    : candidates;
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
  if(state.archiveActionPreview || Number(request.query.mediaId)<=-2){response.json(ok(upFixture.detail({...request.query,query:String(request.query.q||'')},request.params.bvid)));return;}
  state.detailQueries.push(String(request.query.q || ""));
  response.json(ok(detailItem(request.params.bvid)));
});
app.post("/api/archive-library/items/:bvid/deletion-preview", (_request, response,next) => {
  if(state.archiveActionPreview){try{response.json(ok(upFixture.deletion.previewSource(_request.body.userId,_request.body.mediaId,_request.params.bvid)));}catch(error){next(error);}return;}
  state.previewCount += 1;
  response.json(ok({ previewId: "source-preview", fileCount: 2, totalBytes: 15 * 1024 * 1024, sharedCount: 0,deleteCount:2,reclaimableBytes:15*1024*1024 }));
});
app.get("/api/archive-library/playback-queue", (_request, response) => {
  if(state.archiveActionPreview||Number(_request.query.mediaId)<=-2){
    const result=upFixture.playbackQueue({..._request.query,query:String(_request.query.q||'')},{focusBvid:String(_request.query.focusBvid||'')||undefined,pageSize:50});
    if(!result){response.status(404).json({success:false,message:'该归档当前不可播放'});return;}
    response.json(ok(result));return;
  }
  response.json(ok({
  mode: "library" as const, page: 1, pageSize: 50, total: 0, focusIndex: -1, hasMore: false, items: [],
}));});

app.get("/api/online-content/navigation", (_request, response) => {
  state.onlineNavigationCount += 1;
  const sources = [{ kind: "favorite" as const, mediaId: 101, title: "在线收藏夹", count: 11, countLabel: "个视频" }];
  if (state.onlineSourceRace) sources.push({ kind: "favorite" as const, mediaId: 202, title: "第二在线收藏夹", count: 0, countLabel: "个视频" });
  response.json(ok({
    accounts: [{
      userId: "user-1",
      name: "测试账号",
      sources,
    }],
  }));
});
app.get("/api/online-content/items", async (request, response) => {
  if (detailPreviewDelay) await wait(detailPreviewDelay);
  const query = String(request.query.q || "");
  const mediaId = Number(request.query.mediaId || 0);
  state.onlineItemQueries.push(query);
  if (query === "slow" || (state.onlineSourceRace && mediaId === 101)) await wait(650);
  if (query === "broken") {
    response.json({ success:false, message:"隔离在线内容读取失败" });
    return;
  }
  if (query === "empty") {
    response.json(ok({ items: [], page: { page: 1, pageSize: 50, total: 0, hasMore: false, nextCursor: null } }));
    return;
  }
  const suffix = mediaId === 202 ? "SECOND" : "001";
  const title = mediaId === 202 ? "第二在线来源" : query ? `在线搜索 ${query}` : "在线待归档视频";
  const item = {
    id: `online-item-${suffix}`,
    userId: "user-1",
    kind: "favorite" as const,
    bvid: mediaId === 202 ? "BV1ONLINE002" : "BV1ONLINE001",
    title,
    upperName: "在线UP主",
    upperMid: 163637592,
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
  state.mediaProbeBvid=typeof request.body?.bvid==='string'?request.body.bvid:'BV1ONLINE001';
  response.status(202).json(ok({ probeId: "probe-online-1", status: "running" as const, bvid: state.mediaProbeBvid }));
});
app.get("/api/media-probe/:id", (_request, response) => {
  if (state.mediaProbeMode === "failed") {
    response.json(ok({
      probeId: "probe-online-1",
      bvid: state.mediaProbeBvid,
      status: "failed" as const,
      error: "B站当前返回稿件不可见，暂时无法确认可用画质、编码和大小",
    }));
    return;
  }
  if (state.mediaProbeMode === "refine_mismatch" && state.mediaProbeStartCount > 1) {
    response.json(ok({
      probeId: "probe-online-1",
      bvid: state.mediaProbeBvid,
      status: "complete" as const,
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
  bvid: state.mediaProbeBvid,
  status: "complete" as const,
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
  response.status(202).json(ok({ status: "queued" as const, bvid: "BV1ONLINE001" }));
});

app.post("/api/users/:id/removal-preview", (_request, response) => response.json(ok({
  previewId: "account-preview", relationCount: 2, sourceCount: 1, fileCount: 2,
  totalBytes: 15 * 1024 * 1024, sharedCount: 0, activeTasks: 0,deleteCount:2,reclaimableBytes:15*1024*1024,
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
  response.status(202).json(ok({ id, status: "pending" as const, fileCount: 2, completedCount: 0 }));
});
app.get("/api/archive-deletions/:id", (request, response) => {
  if (request.params.id.startsWith("account")) {
    response.json(ok({ id: request.params.id, status: "failed" as const, fileCount: 2, completedCount: 0, lastError: "隔离测试失败" }));
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

app.get('/api/users/:id/favorites/:mediaId/detail-items',(request,response)=>{
  const items=[
    {bvid:'BV1ALPHA001',title:'Alpha 归档视频',upperName:'测试UP主',backupStatus:'verified',processed:true,activeInFavorite:true,playback:{available:true,partCount:1}},
    {bvid:'BV1BETA0002',title:'Beta 历史归档',upperName:'另一位UP主',backupStatus:'pending',processed:false,activeInFavorite:false,unavailable:true},
  ];
  const filter=String(request.query.filter||'all');
  const filtered=filter==='uploaded'?items.filter(item=>item.processed):filter==='pending'?items.filter(item=>!item.processed):items;
  response.json(ok({items:Number(request.query.page||1)>1?[]:filtered,page:Number(request.query.page||1),hasMore:false,
    summary:{total:2,uploaded:1,pending:1,pendingUnavailable:1,uploadedUnavailable:0,activeTotal:1,historicalTotal:1},source:'local',coverage:'complete'}));
});
app.get('/api/users/:id/unavailable',(_request,response)=>response.json(ok({items:[{bvid:'BV1BETA0002',title:'Beta 历史归档',upperName:'另一位UP主',unavailable:true,backupStatus:'pending'}],hasMore:false,nextCursor:null})));
app.post('/api/migration/estimate',(request,response)=>response.json(ok({mode:request.body.mode==='complete'?'complete':'lightweight',resumableItems:1,retainedBytes:1048576,pendingUploadItems:1,files:5,expandedBytes:2097152})));
app.post('/api/rename/preview',(_request,response)=>response.json(ok({previewId:'ui-rename',revision:1,expiresAt:Date.now()+600000,
  candidates:[{candidateId:'ui-rename-file',bvid:'BV1ALPHA001',title:'Alpha 归档视频',oldPath:'/归档/旧文件.mp4',newPath:'/归档/Alpha.mp4',oldName:'旧文件.mp4',newName:'Alpha.mp4'}],skipped:[],remoteScan:{status:'ready',complete:true}})));
app.get('/api/rename/preview/status',(_request,response)=>response.json(ok({unchanged:true,remoteScan:{status:'ready',complete:true}})));
app.post('/api/rename/execute',(_request,response)=>response.json(ok({success:1,failed:0,results:[{ok:true,status:'renamed',oldPath:'/归档/旧文件.mp4',newPath:'/归档/Alpha.mp4'}]})));

if (process.env.BFB_REVIEW_PREVIEW !== '1') {
  app.get('/api/path-migration/state',(_request,response)=>response.json(ok(state.pathMigration)));
  app.get('/api/path-migration/items',(_request,response)=>response.json(ok([])));
  app.post('/api/path-migration/preview',(request,response)=>{
    state.pathMigration={id:'ui-migration',status:'ready',sourceRoot:'/测试旧归档',destinationRoot:String(request.body.destinationRoot||'/测试新归档'),entryCount:1,fileCount:1,totalBytes:1048576,conflictCount:0,failedCount:0};
    response.json(ok(state.pathMigration));
  });
  for(const [action,status] of [['start','copying'],['pause','paused'],['resume','copying'],['cancel','cancelled'],['cleanup-old','completed']]){
    app.post('/api/path-migration/'+action,(_request,response)=>{
      if(!state.pathMigration){response.status(409).json({success:false,message:'请先生成迁移预览'});return;}
      state.pathMigration.status=status;response.json(ok(state.pathMigration));
    });
  }
}

if (process.env.BFB_REVIEW_PREVIEW === "1") {
  const migration: { id: string; status: "ready" | "cancelled"; sourceRoot: string; destinationRoot: string; entryCount: number; fileCount: number; directoryCount: number; totalBytes: number; conflictCount: number; failedCount: number } = {
    id: "review-migration", status: "ready", sourceRoot: "/测试旧归档", destinationRoot: "/测试新归档",
    entryCount: 24, fileCount: 24, directoryCount: 0, totalBytes: 2516582400, conflictCount: 24, failedCount: 0,
  };
  app.get("/api/path-migration/state", (_request, response) => response.json(ok(migration)));
  app.get("/api/path-migration/items", (request, response) => {
    const offset = Math.max(0, Number(request.query.offset || 0));
    const limit = Math.min(21, Math.max(1, Number(request.query.limit || 21)));
    response.json(ok(Array.from({ length: 24 }, (_, index) => ({
      migrationId: migration.id, relativePath: `测试收藏夹/视频${index + 1}/P1.mp4`,
      itemType: "file", expectedSize: 104857600, status: "conflict" as const, lastError: "目标大小与源文件不一致（隔离演示）",
    })).slice(offset, offset + limit)));
  });
  app.post("/api/path-migration/preview", (_request, response) => {
    migration.status = "ready";
    response.json(ok(migration));
  });
  app.post("/api/path-migration/cancel", (_request, response) => {
    migration.status = "cancelled";
    response.json(ok(migration));
  });
}

export async function startFakeUiServer() {
  app.use(createHttpErrorHandler(message=>console.warn(message)));
  return new Promise<() => Promise<void>>((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = app.listen(port, "127.0.0.1");
    server.once("error", reject);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("listening", () => {
      resolve(() => new Promise<void>((closeResolve,closeReject) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {void upFixture.close().then(closeResolve,closeReject);});
      }));
    });
  });
}
