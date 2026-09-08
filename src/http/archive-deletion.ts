import { Router } from 'express';
import type { ArchiveDeletionService } from '../archive-deletion.js';
import type { RouteBoundary } from './route-boundary.js';

export function createArchiveDeletionRouter(deps: {
  service: Pick<ArchiveDeletionService, 'previewSource' | 'get' | 'start' | 'retry' | 'repreview'>;
  boundary: RouteBoundary;
}) {
  const router = Router();
  router.post("/api/archive-library/items/:bvid/deletion-preview", deps.boundary(async (req, res) => {
    const bvid = String(req.params.bvid || "").trim();
    const userId = String(req.body?.userId || "").trim();
    const mediaId = Number(req.body?.mediaId);
    if (!/^BV[0-9A-Za-z]+$/.test(bvid) || !userId || !Number.isInteger(mediaId) || (mediaId < 1 && mediaId !== -1)) {
      res.status(400).json({ success: false, message: "归档来源参数无效" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data: deps.service.previewSource(userId, mediaId, bvid) });
  }));

  router.get("/api/archive-deletions/:id", (req, res) => {
    const data = deps.service.get(String(req.params.id || ""));
    if (!data) {
      res.status(404).json({ success: false, message: "归档清理任务不存在" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data });
  });

  router.post("/api/archive-deletions/:id/start", deps.boundary(async (req, res) => {
    const data = deps.service.start(String(req.params.id || ""), String(req.body?.confirmation || ""));
    res.status(202).setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data });
  }));

  router.post("/api/archive-deletions/:id/retry", deps.boundary(async (req, res) => {
    const data = deps.service.retry(String(req.params.id || ""));
    res.status(202).setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data });
  }));

  router.post("/api/archive-deletions/:id/repreview", deps.boundary(async (req, res) => {
    const data = deps.service.repreview(String(req.params.id || ""));
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data });
  }));


  return router;
}
