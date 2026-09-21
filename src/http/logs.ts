import { Router } from 'express';
import type { LogEntry } from '../logger.js';

export interface LogReadPort {
  getAll(): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

/** Each HTTP stream owns exactly one subscription and releases it on close. */
export function createLogRouter(logs: LogReadPort) {
  const router = Router();
  router.get('/api/logs/stream', (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (entry: LogEntry) => { response.write(`data: ${JSON.stringify(entry)}\n\n`); };
    for (const entry of logs.getAll()) send(entry);
    const unsubscribe = logs.subscribe(send);
    request.once('close', unsubscribe);
  });
  router.get('/api/logs', (_request, response) => {
    response.json({ success: true, data: logs.getAll() });
  });
  return router;
}
