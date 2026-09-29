import { Router } from 'express';
import { performance } from 'node:perf_hooks';
import { createDurationObservation } from '../performance-observation.js';

export function createQueueStateRouter(deps: { snapshot(): unknown }) {
  const router = Router();
  const duration = createDurationObservation('queue_state', { slowMs: 200 });
  router.get('/api/queue/state', (_request, response) => {
    const startedAt = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      response.json({ success: true, data: deps.snapshot() });
      outcome = 'ok';
    } finally {
      duration.record(performance.now() - startedAt, outcome);
    }
  });
  return router;
}
