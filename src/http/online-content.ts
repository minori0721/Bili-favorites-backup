import { Router } from 'express';
import type { RouteBoundary } from './route-boundary.js';
import { sendOnlineCover, type OnlineContentService, type OnlineArchiveStateResolver } from '../online-content.js';
import type { UserStore } from '../users.js';

export function createOnlineContentRouter(dependencies:{
  content:Pick<OnlineContentService,'getNavigation'|'list'|'resolveCover'>;
  users:Pick<UserStore,'list'|'getById'>;archiveStates:OnlineArchiveStateResolver;boundary:RouteBoundary;
}) {
const router=Router();
router.get("/api/online-content/navigation", dependencies.boundary(async (_req, res) => {
  const data = await dependencies.content.getNavigation(dependencies.users.list().filter((user) => user.enabled));
  res.setHeader("Cache-Control", "private, max-age=30");
  res.json({ success: true, data });
}));

router.get("/api/online-content/items", dependencies.boundary(async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  const user = dependencies.users.getById(userId);
  if (!user || !user.enabled) {
    res.status(404).json({ success: false, message: "在线内容账号不存在" });
    return;
  }
  const rawKind = String(req.query.kind || "favorite");
  const kind = (["favorite", "collected", "bangumi", "drama", "watch_later", "history"] as const).find(value => value === rawKind);
  if (!kind) {
    res.status(400).json({ success: false, message: "在线内容分类无效" });
    return;
  }
  const mediaId = req.query.mediaId === undefined || req.query.mediaId === "" ? undefined : Number(req.query.mediaId);
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const pageSize = req.query.pageSize === undefined ? 50 : Number(req.query.pageSize);
  const query = String(req.query.q || "").trim();
  const cursor = String(req.query.cursor || "").trim();
  if ((mediaId !== undefined && (!Number.isInteger(mediaId) || mediaId < 1))
    || !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50
    || query.length > 80 || cursor.length > 256 || query.includes("\0") || cursor.includes("\0")) {
    res.status(400).json({ success: false, message: "在线内容分页参数无效" });
    return;
  }
  const data = await dependencies.content.list(user, {
    kind,
    mediaId,
    page,
    pageSize,
    cursor: cursor || undefined,
    query: query || undefined,
  }, dependencies.archiveStates);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ success: true, data });
}));

router.get("/api/online-content/covers/:token", dependencies.boundary(async (req, res) => {
  const filePath = await dependencies.content.resolveCover(String(req.params.token || ""));
  sendOnlineCover(res, filePath);
}));

return router;
}
