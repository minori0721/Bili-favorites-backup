import { TvQrcodeLogin } from "@renmu/bili-api";
import express from "express";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createAccountLogin } from './account-login-service.js';
import { createAccountRefresh } from './account-refresh-service.js';
import { executeAccountRemoval } from "./account-removal.js";
import { createAccountService } from './account-service.js';
import {
AdminSessionStore
} from "./admin-session.js";
import { appInfo } from "./app-info.js";
import { ArchiveDeletionService } from "./archive-deletion.js";
import { createArchiveLibraryService } from './archive-library-service.js';
import {
getFavoriteFolderCover,
getUserInfo,
getVideoPageSnapshot,
listFavoriteFolders,
listFavoriteItemsPage,
normalizeTvAuthResult,
refreshUserAuth,
resolveSelfVisibleFavoriteItem,
} from "./bili.js";
import { ConfigStore } from "./config.js";
import { createConfigurationService } from './configuration-service.js';
import { UnavailableCoverBackfill,waitForCoverCacheIdle } from "./cover-cache.js";
import { cleanupStaleBBDownCredentialDirectories } from "./credential-temp.js";
import { UNAVAILABLE_COVER_BACKFILL_MARKER } from "./database.js";
import { rotateDebugLogs } from "./debug-log-retention.js";
import { safeErrorSummary } from "./diagnostics.js";
import { BBDOWN_BUILD_INFO } from "./generated/bbdown-build-info.js";
import { BBDOWN_SOURCE_COMMIT } from "./download-session.js";
import { shutdownActiveDownloads } from "./downloader.js";
import { createFavoriteBrowsing } from './favorite-browsing-service.js';
import { createFavoriteDetailService } from './favorite-detail-service.js';
import { FavoriteFolderListCache } from "./favorite-folder-cache.js";
import { FavoriteFolderCoverService } from "./favorite-folder-cover.js";
import { createAccountLoginRouter } from './http/account-login.js';
import { createAccountRemovalRouter } from './http/account-removal.js';
import { createAccountRouter } from './http/accounts.js';
import { createArchiveDeletionRouter } from './http/archive-deletion.js';
import { createArchiveLibraryRouter } from './http/archive-library.js';
import { createAvailabilityRecheckRouter } from './http/availability-recheck.js';
import { createAuthentication,requireAuth,requireSameOrigin } from './http/authentication.js';
import { createConfigurationRouter } from './http/configuration.js';
import { createFavoritesRouter } from './http/favorites.js';
import { createLocalReleaseRouter } from './http/local-release.js';
import { createLogRouter } from './http/logs.js';
import { createManualArchiveRouter } from './http/manual-archive.js';
import { createMediaProbeRouter } from './http/media-probe.js';
import { createMigrationRouter } from './http/migration.js';
import { createOnlineContentRouter } from './http/online-content.js';
import { createPageRouter } from './http/pages.js';
import { createPathMigrationRouter } from './http/path-migration.js';
import { createPlaybackRouter } from './http/playback.js';
import { createQualityMaintenanceRouter } from './http/quality-maintenance.js';
import { createQueueStateRouter } from './http/queue-state.js';
import { createRecoveryRouter } from './http/recovery.js';
import { createRenameRouter } from './http/rename.js';
import { createHttpErrorHandler,createMaintenanceGuard,createRequestBoundary } from './http/request-boundary.js';
import { createStorageCleanupRouter } from './http/storage-cleanup.js';
import { createSyncControlRouter } from './http/sync-control.js';
import { createUnavailableRouter } from './http/unavailable.js';
import { createUpdatesRouter } from './http/updates.js';
import { ImportMaintenance } from "./import-maintenance.js";
import { recoverImportTransaction } from "./import-transaction.js";
import { logManager } from "./logger.js";
import { createManualArchiveService } from './manual-archive-service.js';
import { createMediaProbeRequests } from './media-probe-service.js';
import { MediaProbeService } from "./media-probe.js";
import { createMigrationService } from './migration-service.js';
import {
applyMigrationPackageFile,
createMigrationExport,
estimateMigrationExport,
previewMigrationPackageFile,
} from "./migration.js";
import { createOnlineArchiveProjection } from './online-archive-projection.js';
import { OnlineContentService } from "./online-content.js";
import { OnlineCoverCache } from "./online-cover-cache.js";
import { PathMigrationService } from "./path-migration.js";
import { authSessionDatabasePath,coversDir,ensureAppDirs,onlineCoversDir,tempDir } from "./paths.js";
import { createPlaybackService } from './playback-service.js';
import { closePlaybackDeliveryTracker } from './playback.js';
import { previewDetailLimit } from './preview-options.js';
import { createRemoteReplacementRunner } from "./remote-operations.js";
import { createRenameService } from './rename-service.js';
import { SyncScheduler } from "./scheduler.js";
import type { SchedulerControl } from './ports/scheduler-control.js';
import type { RecoveryPort, SyncControlPort } from './ports/task-control.js';
import { recoverInterruptedQualityDownloads } from './scheduler/quality-download-recovery.js';
import { createQualityMaintenance } from './scheduler/quality-maintenance.js';
import { createQualityStartupRecovery } from './scheduler/quality-startup-recovery.js';
import type { LegacyRecoveryMarkers } from './scheduler/legacy-import-recovery.js';
import { collectSecurityConfigurationWarnings,createLoginRateLimiter } from "./security.js";
import { createStartupLifecycle,optionalStartupStep } from "./startup-lifecycle.js";
import { StateManager } from "./state.js";
import { createStorageCleanup } from './storage-cleanup-service.js';
import { checkRemoteStorageReadOnly } from "./storage-diagnostic.js";
import { createUnavailableService } from './unavailable-service.js';
import { UpdateCheckService } from "./update-check.js";
import {
batchRenameRemotePaths,
deleteRemoteFiles,
listRemoteFilesRecursive
} from "./uploader.js";
import { UserStore } from "./users.js";
import { renderAppPage,renderLoginPage } from "./web.js";
import { readAssetManifest } from "./web/server/assets.js";

readAssetManifest();
ensureAppDirs();
recoverImportTransaction();
logManager.reload();
const importMaintenance = new ImportMaintenance();

const configStore = new ConfigStore();
const userStore = new UserStore();
const stateManager = new StateManager();
const archiveLibrary = createArchiveLibraryService({database: () => stateManager.getDatabase(), users: () => userStore.list()});
const scheduler = new SyncScheduler(configStore, userStore, stateManager, {deferAdmissionUntilStart: true});
// Keep the composition root as the only place that knows the compatibility
// facade.  HTTP modules receive narrow capabilities instead of the scheduler.
const schedulerControl: SchedulerControl = scheduler;
const syncControl: SyncControlPort = {
  sync: () => scheduler.runNow(),
  reconcile: () => scheduler.runReconcileNow(),
  remote: () => scheduler.runRemoteReconcileNow(),
};
const recoveryPort: RecoveryPort = {
  recoverUploadJob: scheduler.recoverUploadJob.bind(scheduler),
  resolveRecoveryIssue: scheduler.resolveRecoveryIssue.bind(scheduler),
};
const unavailableCoverBackfill = new UnavailableCoverBackfill(stateManager);
const onlineCoverCache = new OnlineCoverCache(configStore.get().onlineCoverCacheLimitMB);
const onlineContent = new OnlineContentService(onlineCoverCache);
const favoriteFolderCover = new FavoriteFolderCoverService(onlineCoverCache, getFavoriteFolderCover);
const favoriteFolderListCache = new FavoriteFolderListCache(
  async (user) => listFavoriteFolders(user.cookie),
  (user, folders) => {
    for (const folder of folders) favoriteFolderCover.prime(user, folder.mediaId, folder.cover);
  },
);
const favoriteBrowsing = createFavoriteBrowsing({folders: favoriteFolderListCache, covers: favoriteFolderCover, users: userStore, load: listFavoriteFolders});
const mediaProbe = new MediaProbeService(
  configStore,
  undefined,
  () => scheduler.getLocalCacheCapacity(),
  getVideoPageSnapshot,
);

const pathMigration = new PathMigrationService(stateManager.getDatabase(), configStore, {
  isSchedulerIdle: () => !scheduler.hasRunningTransferTasks()
    && !scheduler.hasPersistentTransferWork()
    && !scheduler.hasActiveOrQueuedSchedulerWork(),
  setMaintenance: (locked, summary) => scheduler.setPathMigrationMaintenance(locked, summary),
  onConfigSwitched: (previous, next) => scheduler.applyConfigUpdate(previous, next),
});
const archiveDeletion = new ArchiveDeletionService(stateManager, configStore, userStore, {
  isSchedulerIdle: () => !scheduler.hasRunningTransferTasks()
    && !scheduler.hasPersistentTransferWork()
    && !scheduler.hasActiveOrQueuedSchedulerWork(),
  prepareSourceDeletion: async (userId, mediaId, bvid) => {
    await scheduler.prepareSourceDeletion(userId, mediaId, bvid);
  },
  setMaintenance: (locked, summary) => scheduler.setArchiveDeletionMaintenance(locked, summary),
  onAccountDeletionCompleted: (userId) => {
    scheduler.restoreUserAfterLogin(userId);
    scheduler.wakeChargingAccessProbes(userId);
  },
  onAccountPreparationRecovery: (userId, accountRemoved) => {
    if (accountRemoved) scheduler.finalizeUserRemoteDeletion(userId);
    else scheduler.restoreUserAfterLogin(userId);
  },
});

const accountLogin = createAccountLogin({
  create() {
    const login = new TvQrcodeLogin();
    return {login: () => login.login(), completed: callback => {login.emitter.on('completed', callback);},
      failed: callback => {login.emitter.on('error', callback);}, stop: () => login.interrupt()};
  },
  qr: url => QRCode.toDataURL(url), normalize: normalizeTvAuthResult, info: getUserInfo,
  users: userStore, maintenance: importMaintenance, id: () => crypto.randomUUID(), now: Date.now,
  restore(id) {
    if (archiveDeletion.restoreAccount(id)) {scheduler.restoreUserAfterLogin(id); scheduler.wakeChargingAccessProbes(id);}
  },
});
const favoriteDetail = createFavoriteDetailService({
  state: stateManager, listPage: listFavoriteItemsPage, resolveVisible: resolveSelfVisibleFavoriteItem,
  currentUser: id => userStore.getById(id), now: Date.now,
});
const artplayerAssetPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/artplayer/dist/artplayer.js");
const renameService = createRenameService({ config: () => configStore.get(), state: stateManager, hasUnfinishedDeletion: () => archiveDeletion.hasUnfinishedOperation(), scan: listRemoteFilesRecursive, rename: batchRenameRemotePaths });

const qualityStartupRecovery = createQualityStartupRecovery({
  state: stateManager, config: configStore, remove: deleteRemoteFiles,
  replacement: createRemoteReplacementRunner, log: entry => logManager.push(entry), now: Date.now,
});

const startupLifecycle = createStartupLifecycle([
  optionalStartupStep("OnlineCoverCache", () => onlineCoverCache.initialize(), (error) => {
    console.warn(`[OnlineCoverCache] 初始化失败: ${safeErrorSummary(error)}`);
  }),
  optionalStartupStep("DebugLog", () => rotateDebugLogs(), (error) => {
    console.warn(`[DebugLog] 启动轮转失败: ${safeErrorSummary(error)}`);
  }),
  optionalStartupStep("SecurityCleanup", () => cleanupBBDownCredentialResidue(), (error) => {
    console.warn(`[Security] Failed to clean stale BBDown credential directories: ${safeErrorSummary(error)}`);
  }),
  { name: 'path-migration', run: () => pathMigration.resumePersisted() },
  { name: 'quality-replacement', run: () => qualityStartupRecovery.recover() },
  { name: 'quality-downloads', run: () => recoverInterruptedQualityDownloads({state: stateManager, config: configStore, users: userStore, directory: tempDir, enqueue: task => scheduler.enqueueQualityUpgrade(task)}) },
  { name: 'archive-accounts', run: () => archiveDeletion.restoreLiveAccountsAfterStartup() },
  { name: 'persistent-jobs', run: () => scheduler.resumePersistedWorkOnStartup() },
  { name: 'scheduling', run: () => { schedulerControl.start(); } },
]);

if (process.env.NODE_ENV !== "test") {
  void startupLifecycle.start().then(() => {
    unavailableCoverBackfill.startBackground();
  }).catch(error => {
    schedulerControl.beginShutdown();
    console.error(`[Startup] Recovery failed; scheduling remains stopped: ${safeErrorSummary(error)}`);
  });
}

async function cleanupBBDownCredentialResidue() {
  const roots = new Set([os.tmpdir(), tempDir]);
  let removed = 0;
  for (const root of roots) removed += await cleanupStaleBBDownCredentialDirectories(root);
  return removed;
}

const accountRefresh = createAccountRefresh({
  users: userStore, maintenance: importMaintenance, refresh: refreshUserAuth, info: getUserInfo,
  wake: userId => scheduler.wakeChargingAccessProbes(userId),
  transfersRunning: () => scheduler.hasRunningTransferTasks(), now: Date.now,
  timers: {set: setTimeout, clear: clearTimeout},
});
if (process.env.NODE_ENV !== "test") accountRefresh.start();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET || "dev-secret";
const adminUser = process.env.ADMIN_USER || "admin";
const adminPass = process.env.ADMIN_PASS || "admin";
const cookieExportEnabled = process.env.ALLOW_COOKIE_EXPORT !== "false";
const secureSessionCookie = process.env.COOKIE_SECURE === "true";
const adminSessionStore = new AdminSessionStore({
  filePath: authSessionDatabasePath,
  sessionSecret,
  adminUser,
  adminPassword: adminPass,
});
const authentication = createAuthentication({secret: sessionSecret, username: adminUser, password: adminPass,
  secure: secureSessionCookie, store: adminSessionStore, rateLimit: createLoginRateLimiter(), now: Date.now});
app.set('trust proxy', 1);
app.use(authentication.session);
app.use(createPageRouter({coversDirectory: coversDir, onlineCoversDirectory: onlineCoversDir,
  playerAssetPath: artplayerAssetPath, loginPage: renderLoginPage, appPage: renderAppPage}));
app.use(authentication.login);

const asyncHandler = createRequestBoundary(importMaintenance);

app.use("/api", requireAuth, requireSameOrigin);
app.use("/api", createMaintenanceGuard(importMaintenance));

app.use(authentication.logout);

const updateCheckService = new UpdateCheckService();
app.use(createUpdatesRouter({ boundary: asyncHandler, check: refresh => updateCheckService.check(refresh) }));

app.use(createConfigurationRouter({boundary: asyncHandler, service: createConfigurationService({
  config: configStore, users: () => userStore.list(),
  hasPathMigration: () => Boolean(stateManager.getDatabase().getActivePathMigration()),
  hasArchiveDeletion: () => stateManager.getDatabase().hasActiveArchiveDeletion(),
  hasRemotePaths: () => stateManager.getDatabase().hasRemoteArchivePathData(),
  changed(previous, next) {
    renameService.invalidateConfig(next);
    onlineCoverCache.setLimitMb(next.onlineCoverCacheLimitMB);
    scheduler.applyConfigUpdate(previous, next);
  },
  inspectStorage: checkRemoteStorageReadOnly,
})}));

app.use(createPathMigrationRouter({pathMigration, archiveDeletion, boundary:asyncHandler}));



app.use(createAccountRouter({boundary: asyncHandler, service: createAccountService({
  users: userStore, info: getUserInfo, refresh: id => accountRefresh.refresh(id, 'manual'),
  cookieExportEnabled, log: entry => logManager.push(entry), now: Date.now,
  wake: id => scheduler.wakeChargingAccessProbes(id),
})}));

app.use(createAccountLoginRouter({service: accountLogin, boundary: asyncHandler}));

app.use(createOnlineContentRouter({content:onlineContent,users:userStore,archiveStates:createOnlineArchiveProjection(stateManager),boundary:asyncHandler}));

app.use(createManualArchiveRouter({boundary: asyncHandler, service: createManualArchiveService({
  users: userStore, content: onlineContent, config: () => configStore.get(),
  enqueue: (id, item) => scheduler.enqueueManualArchive(id, item),
  coverFailure: error => console.warn(`[Cover] promotion failed: ${safeErrorSummary(error)}`),
})}));

app.use(createMediaProbeRouter({boundary: asyncHandler, service: createMediaProbeRequests({users: userStore, probe: mediaProbe})}));

app.use(createAvailabilityRecheckRouter({ request: bvid => scheduler.requestAvailabilityRecheck(bvid) }));

app.use(createLocalReleaseRouter({
  service: { preview: bvid => scheduler.previewLocalArchiveRelease(bvid), release: (bvid, id, confirmation) => scheduler.requestLocalArchiveRelease(bvid, id, confirmation) },
  boundary: asyncHandler,
}));
app.use(createArchiveLibraryRouter(archiveLibrary));
app.use(createArchiveDeletionRouter({ service: archiveDeletion, boundary: asyncHandler }));

app.use(createFavoritesRouter({users: userStore, detail: favoriteDetail, boundary: asyncHandler,
  select: (id, input) => favoriteBrowsing.select(id, input), folders: user => favoriteBrowsing.folders(user), cover: (user, mediaId) => favoriteBrowsing.cover(user, mediaId),
}));

app.use(createPlaybackRouter({boundary: asyncHandler, service: createPlaybackService({
  database: () => stateManager.getDatabase(), config: () => configStore.get(),
  users: userStore, isKnownOwner: id => archiveDeletion.isKnownOwner(id),
  updateMetadata: (userId, mediaId, fileId, metadata) => stateManager.updatePlaybackMediaMetadata(userId, mediaId, fileId, metadata),
})}));

app.use(createUnavailableRouter({boundary: asyncHandler, service: createUnavailableService({users: userStore, state: stateManager})}));





app.use(createAccountRemovalRouter({
  user: id => userStore.getById(id), preview: user => archiveDeletion.previewAccount(user), boundary: asyncHandler,
  remove: (id, body) => executeAccountRemoval({ archiveDeletion, scheduler, userStore,
    onRollbackError: error => console.error(`[Account] Failed to roll back account removal: ${safeErrorSummary(error)}`),
  }, id, body),
}));

app.use(createSyncControlRouter({...syncControl, boundary:asyncHandler}));

app.use(createLogRouter({
  getAll: () => logManager.getAll(),
  subscribe: listener => {
    logManager.on('log', listener);
    return () => { logManager.removeListener('log', listener); };
  },
}));

app.use(createQueueStateRouter({ snapshot: () => scheduler.getQueueSnapshot() }));

app.use(createRecoveryRouter({ boundary: asyncHandler,
  ...recoveryPort,
}));

app.use(createStorageCleanupRouter({ boundary: asyncHandler, service: createStorageCleanup({
  scheduler: {
    refreshLocalCacheState: () => scheduler.refreshLocalCacheState(), updateInterval: () => scheduler.updateInterval(),
    hasRunningTransferTasks: () => scheduler.hasRunningTransferTasks(),
    hasActiveOrQueuedSchedulerWork: () => scheduler.hasActiveOrQueuedSchedulerWork(),
    withCleanupLock: work => scheduler.withCleanupLock(work),
  },
  stateManager, userStore, configStore, onlineCoverCache, unavailableCoverBackfill,
  waitForCoverCacheIdle, clearMemoryCaches: () => { favoriteDetail.clear(); favoriteFolderListCache.clear(); },
  clearLogs: () => logManager.clear(),
  clearCoverBackfillMarker: () => stateManager.getDatabase().deleteMeta(UNAVAILABLE_COVER_BACKFILL_MARKER),
  hasPathMigration: () => Boolean(stateManager.getDatabase().getActivePathMigration()),
  hasUnfinishedDeletion: () => archiveDeletion.hasUnfinishedOperation(),
}) }));

async function reloadStoresAfterImport(restored: string[], previousMarkers: LegacyRecoveryMarkers) {
  try {
    accountLogin.invalidate();
    configStore.reload();
    onlineCoverCache.setLimitMb(configStore.get().onlineCoverCacheLimitMB);
    favoriteFolderListCache.clear();
    favoriteDetail.clear();
    userStore.reload();
    stateManager.reload();
    scheduler.reloadStateDatabase();
    pathMigration.rebindWithinLifecycleBarrier(stateManager.getDatabase());
    archiveDeletion.rebind(stateManager.getDatabase());
    logManager.reload();
    await scheduler.recheckLegacyRecoveryAfterImport(restored, previousMarkers);
  } catch (error) {
    scheduler.beginShutdown();
    throw Object.assign(new Error(`导入后恢复失败：${safeErrorSummary(error)}`), { cause: error, recoveryRequired: true });
  }
}

function resumeStoresAfterImport() {
  scheduler.resumeAfterStateRebind();
  scheduler.updateInterval();
}

app.use(createMigrationRouter({boundary:asyncHandler,service:createMigrationService({
  scheduler: {
    hasRunningTransferTasks: () => scheduler.hasRunningTransferTasks(),
    hasActiveOrQueuedSchedulerWork: () => scheduler.hasActiveOrQueuedSchedulerWork(),
    hasPersistentTransferWork: () => scheduler.hasPersistentTransferWork(),
    withCleanupLock: work => scheduler.withCleanupLock(work),
    captureLegacyRecoveryMarkers: () => scheduler.captureLegacyRecoveryMarkers(),
    beginShutdown: () => scheduler.beginShutdown(),
  },
  pathMigration,archiveDeletion,importMaintenance,mediaProbe,unavailableCoverBackfill,
  waitForRenamePreviewIdle: timeout => renameService.waitForIdle(timeout), waitForCoverCacheIdle,
  activePathMigration: () => stateManager.getDatabase().getActivePathMigration(),
  clearCoverBackfillMarker: () => stateManager.getDatabase().deleteMeta(UNAVAILABLE_COVER_BACKFILL_MARKER),
  reload:reloadStoresAfterImport,resume:resumeStoresAfterImport,
  exportArchive: options => createMigrationExport(options,stateManager),
  estimate: options => estimateMigrationExport(options,stateManager), preview: previewMigrationPackageFile,
  apply: (archive,options) => applyMigrationPackageFile(archive,options,stateManager),
})}));

const qualityMaintenance = createQualityMaintenance({
  config: () => configStore.get(), records: () => stateManager.getRemoteFilePreviewRecords(),
  targetKeys: () => scheduler.getQualityUpgradeTargetKeys(), users: userStore,
  enqueue: task => scheduler.enqueueQualityUpgrade(task),
});
app.use(createQualityMaintenanceRouter({service:qualityMaintenance,state:()=>scheduler.getQualityUpgradeState(),detailLimit:previewDetailLimit,boundary:asyncHandler}));

app.use(createRenameRouter({service: renameService, boundary: asyncHandler}));

app.use(createHttpErrorHandler(message => console.error(message)));

export async function closeAppResources() {
  startupLifecycle.stop();
  const accountRefreshStopped = accountRefresh.stop(5_000);
  const accountLoginStopped = accountLogin.stop(5_000);
  schedulerControl.beginShutdown();
  const startupStopped = await startupLifecycle.waitForIdle(5_000);
  const pathMigrationStopped = pathMigration.stop(5_000);
  const archiveDeletionStopped = archiveDeletion.stop(5_000);
  const renamePreviewStopped = renameService.stop(5_000);
  await shutdownActiveDownloads(5_000);
  await schedulerControl.shutdown(5_000, {closeDatabase:false});
  if (!await accountLoginStopped) throw new Error("Account login did not stop before closing resources");
  if (!await accountRefreshStopped) throw new Error("Account refresh did not stop before closing resources");
  if (!startupStopped) throw new Error("Startup recovery did not stop before closing the state database");
  if (!await pathMigrationStopped) throw new Error("Path migration did not stop before closing the state database");
  if (!await archiveDeletionStopped) throw new Error("Archive deletion did not stop before closing the state database");
  if (!await renamePreviewStopped) throw new Error("Rename preview scan did not stop before closing the state database");
  renameService.clear();
  const coverBackfillStopped = await unavailableCoverBackfill.stop(30_000);
  const coverQueueIdle = coverBackfillStopped && await waitForCoverCacheIdle(30_000);
  if (!coverBackfillStopped || !coverQueueIdle) throw new Error("Cover work did not stop before closing the state database");
  await cleanupBBDownCredentialResidue().catch(error => console.warn(`[Shutdown] credential cleanup failed: ${safeErrorSummary(error)}`));
  closePlaybackDeliveryTracker();
  adminSessionStore.close();
  stateManager.close();
  logManager.close();
}

export { app };

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    for (const warning of collectSecurityConfigurationWarnings({
      adminPassword: adminPass,
      sessionSecret,
      secureSessionCookie,
      cookieExportEnabled,
    })) {
      console.warn(`[Security] ${warning}`);
    }
    console.log(`[Runtime] BFB ${appInfo.versionLabel}; BBDown release ${BBDOWN_BUILD_INFO.release}; source commit ${BBDOWN_SOURCE_COMMIT}; FFmpeg ${process.env.FFMPEG_VERSION || "system"}; aria2 resume enabled`);
  });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${signal}: stopping scheduler and active downloads`);
    startupLifecycle.stop();
    const accountRefreshStopped = accountRefresh.stop(20_000);
    const accountLoginStopped = accountLogin.stop(20_000);
    schedulerControl.beginShutdown();
    const startupStopped = await startupLifecycle.waitForIdle(20_000);
    if (!startupStopped) console.warn("[Shutdown] Startup recovery did not stop before the shutdown deadline");
    const pathMigrationStopped = pathMigration.stop(20_000);
    const archiveDeletionStopped = archiveDeletion.stop(20_000);
    const renamePreviewStopped = renameService.stop(20_000);
    server.close();
    let downloadsStopped = true;
    await shutdownActiveDownloads(20_000).catch((error) => {
      downloadsStopped = false;
      console.warn(`[Shutdown] Failed to stop active downloads cleanly: ${safeErrorSummary(error)}`);
    });
    let schedulerStopped = true;
    await schedulerControl.shutdown(20_000, {closeDatabase:false}).catch((error) => {
      schedulerStopped = false;
      console.warn(`[Shutdown] Failed to checkpoint state database cleanly: ${safeErrorSummary(error)}`);
    });
    if (!await pathMigrationStopped) {
      console.warn("[Shutdown] Path migration preview or worker did not stop before the shutdown deadline");
    }
    const archiveDeletionQuiesced = await archiveDeletionStopped;
    if (!archiveDeletionQuiesced) {
      console.warn("[Shutdown] Archive deletion worker did not stop before the shutdown deadline");
    }
    const renamePreviewQuiesced = await renamePreviewStopped;
    if (!renamePreviewQuiesced) {
      console.warn("[Shutdown] Rename preview scan did not stop before the shutdown deadline");
    }
    await cleanupBBDownCredentialResidue().catch((error) => {
      console.warn(`[Shutdown] Failed to clean BBDown credential directories: ${safeErrorSummary(error)}`);
    });
    const coverBackfillStopped = await unavailableCoverBackfill.stop(30_000).catch((error) => {
      console.warn(`[Shutdown] Failed to stop unavailable cover backfill cleanly: ${safeErrorSummary(error)}`);
      return false;
    });
    const coverQueueIdle = coverBackfillStopped && await waitForCoverCacheIdle(30_000);
    closePlaybackDeliveryTracker();
    adminSessionStore.close();
    const quiesced = await accountLoginStopped && await accountRefreshStopped && startupStopped && downloadsStopped && schedulerStopped && await pathMigrationStopped && archiveDeletionQuiesced && renamePreviewQuiesced && coverBackfillStopped && coverQueueIdle;
    if (quiesced) {
      stateManager.close();
    } else {
      console.warn("[Shutdown] Skipped explicit state database close because background work did not quiesce");
    }
    logManager.close();
    process.exit(quiesced ? 0 : 1);
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  if (process.env.BFB_DEV_SERVER === '1' && process.send) {
    process.on('message', message => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'bfb:dev-shutdown') {
        void shutdown('development restart');
      }
    });
    process.once('disconnect', () => { void shutdown('development launcher disconnected'); });
  }
}
