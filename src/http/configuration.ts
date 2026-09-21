import { Router } from 'express';
import type { createConfigurationService } from '../configuration-service.js';
import type { RouteBoundary } from './route-boundary.js';
export function createConfigurationRouter(deps: {service: ReturnType<typeof createConfigurationService>; boundary: RouteBoundary}) {
  const router = Router();
  router.get('/api/config', (_req, res) => { res.json({success: true, data: deps.service.get()}); });
  router.put('/api/config', (req, res) => {
    const result = deps.service.update(req.body);
    res.status(result.status).json(result.body);
  });
  router.post('/api/storage/check', deps.boundary(async (req, res) => {
    const result = await deps.service.checkStorage(req.body);
    if (result.status === 200) res.setHeader('Cache-Control', 'private, no-store');
    res.status(result.status).json(result.body);
  }));
  return router;
}
