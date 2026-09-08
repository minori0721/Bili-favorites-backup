import { Router } from 'express';
import type { PathMigrationService } from '../path-migration.js';
import type { PathMigrationItemStatus } from '../database.js';
import type { RouteBoundary } from './route-boundary.js';

interface Dependencies {
  pathMigration: Pick<PathMigrationService, 'preview' | 'getState' | 'listItems' | 'start' | 'pause' | 'resume' | 'cancel' | 'waitForIdle' | 'cleanupOld'>;
  archiveDeletion: { hasUnfinishedOperation(): boolean };
  boundary: RouteBoundary;
}

export function createPathMigrationRouter({ pathMigration, archiveDeletion, boundary: asyncHandler }: Dependencies) {
  const router = Router();
router.post("/api/path-migration/preview", asyncHandler(async (req, res) => {
  if (archiveDeletion.hasUnfinishedOperation()) {
    res.status(409).json({ success: false, message: "仍有未完成的归档清理，不能预览归档路径迁移" });
    return;
  }
  const destinationRoot = String(req.body?.destinationRoot || "").trim();
  if (!destinationRoot) {
    res.status(400).json({ success: false, message: "destinationRoot is required" });
    return;
  }
  const record = await pathMigration.preview(destinationRoot);
  res.status(202).json({ success: true, data: record });
}));

router.get("/api/path-migration/state", (_req, res) => {
  res.json({ success: true, data: pathMigration.getState() || null });
});

router.get("/api/path-migration/items", (req, res) => {
  const rawStatus = String(req.query.status || "conflict,failed");
  const statuses = rawStatus.split(",").filter((value): value is PathMigrationItemStatus => ["pending", "reusable", "copying", "awaiting_verification", "verified", "conflict", "failed"].includes(value));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 100)));
  res.json({ success: true, data: pathMigration.listItems(statuses, offset, limit) });
});

router.post("/api/path-migration/start", asyncHandler(async (req, res) => {
  if (archiveDeletion.hasUnfinishedOperation()) {
    res.status(409).json({ success: false, message: "仍有未完成的归档清理，不能开始归档路径迁移" });
    return;
  }
  res.json({ success: true, data: await pathMigration.start(req.body?.id) });
}));

router.post("/api/path-migration/pause", (_req, res) => {
  res.json({ success: true, data: pathMigration.pause() });
});

router.post("/api/path-migration/resume", (_req, res) => {
  res.json({ success: true, data: pathMigration.resume() });
});

router.post("/api/path-migration/cancel", asyncHandler(async (_req, res) => {
  const state = pathMigration.cancel();
  if (!await pathMigration.waitForIdle(30_000)) {
    res.status(409).json({ success: false, message: "归档路径预览仍未停止，请等待当前请求结束后再导入或重载状态库" });
    return;
  }
  res.json({ success: true, data: state });
}));

router.post("/api/path-migration/cleanup-old", asyncHandler(async (req, res) => {
  const confirmation = String(req.body?.confirmation || "");
  const keepOld = req.body?.keepOld === true;
  if (!keepOld && confirmation !== "DELETE OLD ARCHIVE") {
    res.status(400).json({ success: false, message: "请输入 DELETE OLD ARCHIVE 以确认删除旧归档目录" });
    return;
  }
  res.json({ success: true, data: await pathMigration.cleanupOld(req.body?.id, keepOld) });
}));


  return router;
}
