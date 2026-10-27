import { Router } from 'express';
import type { RouteBoundary } from './route-boundary.js';

export function createOnboardingRouter(deps: {
  status(): { autoStart: boolean };
  finish(): void;
  boundary: RouteBoundary;
}) {
  const router = Router();
  router.get('/api/onboarding', deps.boundary(async (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: deps.status() });
  }));
  router.post('/api/onboarding/seen', deps.boundary(async (_req, res) => {
    deps.finish();
    res.json({ success: true, data: {} });
  }));
  return router;
}
