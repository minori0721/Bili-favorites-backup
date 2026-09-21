import { Router } from 'express';

export function createQueueStateRouter(deps: { snapshot(): unknown }) {
  const router = Router();
  router.get('/api/queue/state', (_request, response) => {
    response.json({ success: true, data: deps.snapshot() });
  });
  return router;
}
