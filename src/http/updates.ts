import { Router } from 'express';
import type { RouteBoundary } from './route-boundary.js';

interface UpdateRoutes {
  boundary: RouteBoundary;
  check(refresh: boolean): Promise<unknown>;
  seenInstalled(build: string): boolean;
}

export function createUpdatesRouter(deps: UpdateRoutes) {
  const router = Router();
  router.get('/api/updates', deps.boundary(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ success: true, data: await deps.check(request.query.refresh === '1') });
  }));
  router.post('/api/updates/installed/seen', deps.boundary(async (request, response) => {
    const build: unknown = request.body?.build;
    if (typeof build !== 'string' || !build || build.length >= 200) {
      response.status(400).json({ success: false, message: '版本标记格式错误' }); return;
    }
    if (!deps.seenInstalled(build)) {
      response.status(409).json({ success: false, message: '运行版本已变化，请刷新页面' }); return;
    }
    response.json({ success: true, data: {} });
  }));
  return router;
}
