import { Router } from 'express';
import type { createRenameService } from '../rename-service.js';
import type { RouteBoundary } from './route-boundary.js';
export function createRenameRouter(deps: { service: ReturnType<typeof createRenameService>; boundary: RouteBoundary }) {
  const router = Router();
  router.post('/api/rename/preview', deps.boundary(async (req, res) => {
    const result = await deps.service.preview(req.body);
    res.status(result.status).json(result.body);
  }));
  router.get('/api/rename/preview/status', deps.boundary(async (req, res) => {
    const result = await deps.service.status(req.query);
    res.status(result.status).json(result.body);
  }));
  router.post('/api/rename', deps.boundary(async (req, res) => {
    const result = await deps.service.execute(req.body);
    res.status(result.status).json(result.body);
  }));
  return router;
}
