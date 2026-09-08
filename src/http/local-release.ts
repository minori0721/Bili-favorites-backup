import { Router } from 'express';
import type { createLocalCleanup } from '../scheduler/local-cleanup.js';
import type { RouteBoundary } from './route-boundary.js';

export function createLocalReleaseRouter(dependencies: {
  service: Pick<ReturnType<typeof createLocalCleanup>, 'preview' | 'release'>;
  boundary: RouteBoundary;
}) {
  const router = Router();
  router.get('/api/videos/:bvid/local-release-preview', dependencies.boundary((req, res) => {
    const bvid = String(req.params.bvid || '').trim();
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
      res.status(400).json({ success: false, message: 'BV号格式无效' });
      return;
    }
    const result = dependencies.service.preview(bvid);
    if (!result.ok) {
      res.status(result.status).json({ success: false, message: result.message });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: result });
  }));
  router.post('/api/videos/:bvid/local-release', dependencies.boundary((req, res) => {
    const bvid = String(req.params.bvid || '').trim();
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
      res.status(400).json({ success: false, message: 'BV号格式无效' });
      return;
    }
    const result = dependencies.service.release(bvid, String(req.body?.releaseId || ''), String(req.body?.confirmation || ''));
    if (!result.ok) {
      res.status(result.status).json({ success: false, message: result.message });
      return;
    }
    res.status(202).setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: result });
  }));
  return router;
}
