import { Router } from 'express';
import type { LogEntry } from '../logger.js';
import type { AdminSessionInvalidationPort } from '../ports/admin-session.js';

export interface LogReadPort {
  getAll(): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

/** Each HTTP stream owns exactly one subscription and releases it on close. */
export function createLogRouter(logs: LogReadPort, sessions: AdminSessionInvalidationPort) {
  const router = Router();
  router.get('/api/logs/stream', (request, response, next) => {
    let closed = false;
    let unsubscribeLogs: (() => void) | undefined;
    let unsubscribeSession: (() => void) | undefined;
    const release = () => {
      if (closed) return;
      closed = true;
      unsubscribeLogs?.();
      unsubscribeSession?.();
      request.removeListener('close', release);
      response.removeListener('close', release);
    };
    const invalidated = () => {
      release();
      if (response.destroyed || response.writableEnded) return;
      if (!response.headersSent) response.status(401).json({success: false, message: 'Unauthorized'});
      else response.end();
    };
    request.once('close', release);
    response.once('close', release);
    try {
      unsubscribeSession = sessions.observe(request.sessionID, invalidated);
      if (closed) { unsubscribeSession(); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', Connection: 'keep-alive' });
      const send = (entry: LogEntry) => {
        if (!closed && !response.destroyed) response.write(`data: ${JSON.stringify(entry)}\n\n`);
      };
      for (const entry of logs.getAll()) send(entry);
      unsubscribeLogs = logs.subscribe(send);
      if (closed) unsubscribeLogs();
    } catch (error) {
      release();
      next(error);
    }
  });
  router.get('/api/logs', (_request, response) => {
    response.json({ success: true, data: logs.getAll() });
  });
  return router;
}
