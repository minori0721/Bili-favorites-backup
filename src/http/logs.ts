import { Router } from 'express';
import type { LogEntry } from '../logger.js';
import type { AdminSessionInvalidationPort } from '../ports/admin-session.js';

export interface LogReadPort {
  getAll(): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

/** Each HTTP stream owns exactly one subscription and releases it on close. */
export function createLogRouter(logs: LogReadPort, sessions: AdminSessionInvalidationPort,
  options: { maxPendingBytes?: number; stallTimeoutMs?: number } = {}) {
  const maxPendingBytes = options.maxPendingBytes ?? 256 * 1024;
  const stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
  const router = Router();
  router.get('/api/logs/stream', (request, response, next) => {
    let closed = false;
    let unsubscribeLogs: (() => void) | undefined;
    let unsubscribeSession: (() => void) | undefined;
    let history: LogEntry[] = [];
    let historyIndex = 0;
    let blocked = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const release = () => {
      if (closed) return;
      closed = true;
      unsubscribeLogs?.();
      unsubscribeSession?.();
      clearTimeout(stallTimer);
      response.removeListener('drain', resume);
      history = [];
      pending.length = 0;
      pendingBytes = 0;
      request.removeListener('close', release);
      response.removeListener('close', release);
    };
    const disconnect = () => { release(); response.destroy(); };
    function resume() {
      blocked = false;
      clearTimeout(stallTimer);
      pump();
    }
    function pump() {
      while (!closed && !blocked && !response.destroyed) {
        let frame: Buffer | undefined;
        if (historyIndex < history.length) {
          frame = Buffer.from(`data: ${JSON.stringify(history[historyIndex++])}\n\n`, 'utf8');
        } else {
          history = [];
          historyIndex = 0;
          frame = pending.shift();
          if (!frame) return;
          pendingBytes -= frame.byteLength;
        }
        if (!response.write(frame)) {
          blocked = true;
          response.once('drain', resume);
          stallTimer = setTimeout(disconnect, stallTimeoutMs);
          stallTimer.unref();
        }
      }
    }
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
      response.flushHeaders();
      history = logs.getAll().slice(-500);
      const send = (entry: LogEntry) => {
        if (closed || response.destroyed) return;
        const frame = Buffer.from(`data: ${JSON.stringify(entry)}\n\n`, 'utf8');
        if (pendingBytes + frame.byteLength > maxPendingBytes) { disconnect(); return; }
        pending.push(frame);
        pendingBytes += frame.byteLength;
        pump();
      };
      unsubscribeLogs = logs.subscribe(send);
      if (closed) unsubscribeLogs();
      else pump();
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
