import { Router } from 'express';
import type { createStorageCleanup } from '../storage-cleanup-service.js';
import type { RouteBoundary } from './route-boundary.js';

export function createStorageCleanupRouter(deps: {
  service: ReturnType<typeof createStorageCleanup>;
  boundary: RouteBoundary;
}) {
  const router = Router();
  router.get('/api/storage/cleanup', deps.boundary(async (_req, res) => {
    res.json({ success: true, data: await deps.service.inspect() });
  }));
  router.post('/api/storage/cleanup', deps.boundary(async (req, res) => {
    const result = await deps.service.execute({ items: req.body?.items, confirmation: req.body?.confirmation });
    res.status(result.status).json(result.body);
  }));
  return router;
}
