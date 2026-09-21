import { Router } from 'express';
import type { createManualArchiveService } from '../manual-archive-service.js';
import type { RouteBoundary } from './route-boundary.js';
export function createManualArchiveRouter(deps: {service: ReturnType<typeof createManualArchiveService>; boundary: RouteBoundary}) {
  const router = Router();
  router.post('/api/online-content/manual-archive', deps.boundary(async (req, res) => {
    const result = await deps.service.execute({userId: req.body?.userId, token: req.body?.token, quality: req.body?.quality, encoding: req.body?.encoding});
    res.status(result.status).json(result.body);
  }));
  return router;
}
