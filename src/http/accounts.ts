import { Router } from 'express';
import type { createAccountService } from '../account-service.js';
import type { RouteBoundary } from './route-boundary.js';
export function createAccountRouter(deps: {service: ReturnType<typeof createAccountService>; boundary: RouteBoundary}) {
const router = Router();
router.get('/api/users', deps.boundary(async (req, res) => {
  const result = await deps.service.list();
  res.status(result.status).json(result.body);
}));
router.post('/api/users/:id/refresh-info', deps.boundary(async (req, res) => {
  const result = await deps.service.refreshInfo(req.params.id);
  res.status(result.status).json(result.body);
}));
router.post('/api/users/:id/refresh-auth', deps.boundary(async (req, res) => {
  const result = await deps.service.refreshAuth(req.params.id);
  res.status(result.status).json(result.body);
}));
router.post('/api/users/:id/cookie/export', deps.boundary(async (req, res) => {
  const result = await deps.service.exportCookie(req.params.id, req.body?.confirm);
  res.status(result.status).json(result.body);
}));
router.patch('/api/users/:id', deps.boundary(async (req, res) => {
  const result = await deps.service.update(req.params.id, {enabled: req.body?.enabled, toggle: req.body?.toggle});
  res.status(result.status).json(result.body);
}));
return router;
}
