import { Router } from 'express';
import type { createAccountLogin } from '../account-login-service.js';
import { safeErrorSummary } from '../diagnostics.js';
import type { RouteBoundary } from './route-boundary.js';
export function createAccountLoginRouter(deps: {service: ReturnType<typeof createAccountLogin>; boundary: RouteBoundary}) {
  const router = Router();
  router.post('/api/users/login/start', deps.boundary(async (_req, res) => {
    try { res.json({success: true, data: await deps.service.start()}); }
    catch (error) { res.status(500).json({success: false, message: safeErrorSummary(error, 'Failed to start login')}); }
  }));
  router.get('/api/users/login/status', (req, res) => {
    const current = deps.service.status(String(req.query.loginId || ''));
    if (!current) {res.status(404).json({success: false, message: 'Login session not found'}); return;}
    res.json({success: true, data: current});
  });
  return router;
}
