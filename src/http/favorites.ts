import type { createFavoriteBrowsing } from '../favorite-browsing-service.js';
import { Router } from 'express';
import type { UserStore, BiliUser } from '../users.js';
import type { FavoriteFolderInfo } from '../bili.js';
import type { createFavoriteDetailService } from '../favorite-detail-service.js';
import { getBiliListErrorMessage } from '../favorite-errors.js';
import { sendOnlineCover } from '../online-content.js';
import { parsePositiveInteger, normalizePageSize, parseFolderDetailFilter } from './favorite-query.js';
import type { RouteBoundary } from './route-boundary.js';
export function createFavoritesRouter(deps: {
  select: ReturnType<typeof createFavoriteBrowsing>['select'];
  users: Pick<UserStore, 'getById'>;
  detail: ReturnType<typeof createFavoriteDetailService>;
  folders(user: BiliUser): Promise<Array<FavoriteFolderInfo & {selected: boolean}>>;
  cover(user: BiliUser, mediaId: number): Promise<string | null>;
  boundary: RouteBoundary;
}) {
const router = Router();
router.get("/api/users/:id/favorites", deps.boundary(async (req, res) => {
  const user = deps.users.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  try {
    const data = await deps.folders(user);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data });
  } catch (error) {
    res.status(502).json({ success: false, message: getBiliListErrorMessage(error) });
  }
}));

router.get("/api/users/:id/favorites/:mediaId/cover", deps.boundary(async (req, res) => {
  const user = deps.users.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaId = Number(req.params.mediaId);
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    res.status(400).json({ success: false, message: "Invalid mediaId" });
    return;
  }
  const filePath = await deps.cover(user, mediaId);
  sendOnlineCover(res, filePath);
}));

router.get("/api/users/:id/favorites/:mediaId/items", deps.boundary(async (req, res) => {
  const user = deps.users.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  try {
    const mediaId = Number(req.params.mediaId);
    if (!Number.isFinite(mediaId) || mediaId < 1) {
      res.status(400).json({ success: false, message: "Invalid mediaId" });
      return;
    }

    const page = parsePositiveInteger(req.query.page, 1);
    res.json({ success: true, data: await deps.detail.items(user, mediaId, page) });
  } catch (err) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
}));

router.get([
  "/api/users/:id/favorites/:mediaId/detail-items",
  "/api/users/:id/favorites/:mediaId/state-items",
], deps.boundary(async (req, res) => {
  const user = deps.users.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaId = Number(req.params.mediaId);
  if (!Number.isFinite(mediaId) || mediaId < 1) {
    res.status(400).json({ success: false, message: "Invalid mediaId" });
    return;
  }

  try {
    const pageSize = normalizePageSize(req.query.pageSize);
    const page = parsePositiveInteger(req.query.page, 1);
    const filter = parseFolderDetailFilter(req.query.filter);
    const folderTitle = String(req.query.folderTitle || "favorites");
    const data = await deps.detail.detail(user, mediaId, folderTitle, page, pageSize, filter);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
}));

router.put('/api/users/:id/favorites', deps.boundary(async (req, res) => {
  const result = await deps.select(req.params.id, req.body?.mediaIds);
  res.status(result.status).json(result.body);
}));
return router;
}
