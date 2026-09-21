import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { RouteBoundary } from './route-boundary.js';
import { safeErrorSummary } from '../diagnostics.js';
interface Maintenance {
  readonly blocked: boolean;
  run<T>(work: () => Promise<T>): Promise<T>;
}
export function createRequestBoundary(maintenance: Maintenance): RouteBoundary {
  return handler => (req, res, next) => {
    // The import route acquires the exclusive barrier itself; counting it as
    // an ordinary active request would make it wait for its own completion.
    if (req.path === '/api/migration/import') {
      Promise.resolve().then(() => handler(req, res, next)).catch(next);
      return;
    }
    maintenance.run(async () => { await handler(req, res, next); }).catch(next);
  };
}
export function createMaintenanceGuard(maintenance: Pick<Maintenance, 'blocked'>): RequestHandler {
  return (_req, res, next) => {
    if (maintenance.blocked) {
      res.status(409).json({success: false, message: '状态导入维护中，请稍后重试'});
      return;
    }
    next();
  };
}
export function createHttpErrorHandler(log: (message: string) => void): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    log(`[HTTP] ${req.method} ${req.path} failed: ${safeErrorSummary(error)}`);
    if (res.headersSent) { next(error); return; }
    const status = error !== null && typeof error === 'object'
      ? ('statusCode' in error ? error.statusCode : 'status' in error ? error.status : undefined)
      : undefined;
    const number = typeof status === 'number' || typeof status === 'string' ? Number(status) : NaN;
    const code = Number.isInteger(number) && number >= 400 && number < 600 ? number : 500;
    res.status(code).json({success: false, message: safeErrorSummary(error, 'Internal server error')});
  };
}
