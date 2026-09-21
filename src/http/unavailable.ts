import { Router } from 'express';
import type { createUnavailableService } from '../unavailable-service.js';
import { getBiliListErrorMessage } from '../favorite-errors.js';
import { normalizePageSize } from './favorite-query.js';
import type { RouteBoundary } from './route-boundary.js';
export function createUnavailableRouter(deps: {service: ReturnType<typeof createUnavailableService>; boundary: RouteBoundary}) {
  const router = Router();
  router.get('/api/users/:id/unavailable', deps.boundary(async (req, res) => {
    try {
      const result = deps.service.list(req.params.id, {filter: req.query.filter, cursor: req.query.cursor, pageSize: normalizePageSize(req.query.pageSize)});
      res.status(result.status).json(result.body);
    } catch (error) { res.status(500).json({success: false, message: getBiliListErrorMessage(error)}); }
  }));
  return router;
}
