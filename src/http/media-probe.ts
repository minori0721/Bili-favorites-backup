import { Router } from 'express';
import type { createMediaProbeRequests } from '../media-probe-service.js';
import type { RouteBoundary } from './route-boundary.js';
export function createMediaProbeRouter(deps: {service: ReturnType<typeof createMediaProbeRequests>; boundary: RouteBoundary}) {
  const router = Router();
  router.post('/api/media-probe', deps.boundary(async (req, res) => {
    const result = deps.service.start({userId: req.body?.userId, bvid: req.body?.bvid, quality: req.body?.quality, encoding: req.body?.encoding, strict: req.body?.strict});
    res.status(result.status).json(result.body);
  }));
  router.get('/api/media-probe/:id', (req, res) => {
    const result = deps.service.get(String(req.params.id || ''));
    if (!result) {res.status(404).json({success: false, message: '媒体探测不存在或已过期'}); return;}
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({success: true, data: result});
  });
  return router;
}
