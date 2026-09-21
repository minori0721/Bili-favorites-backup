import { Router } from 'express';
import type { RouteBoundary } from './route-boundary.js';

interface UpdateRoutes {
  boundary: RouteBoundary;
  check(refresh: boolean): Promise<unknown>;
}

export function createUpdatesRouter(deps: UpdateRoutes) {
  const router = Router();
  router.get('/api/updates', deps.boundary(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ success: true, data: await deps.check(request.query.refresh === '1') });
  }));
  return router;
}
