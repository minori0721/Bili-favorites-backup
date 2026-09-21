import { Router } from 'express';
import path from 'node:path';
import type { createMigrationService } from '../migration-service.js';
import type { RouteBoundary } from './route-boundary.js';

export function createMigrationRouter(deps: { service: ReturnType<typeof createMigrationService>; boundary: RouteBoundary }) {
  const router = Router();
  router.post('/api/migration/export', deps.boundary(async (req, res) => {
    const result = await deps.service.exportArchive(req.body);
    res.download(result.outputPath, path.basename(result.outputPath), error => {
      if (error && !res.headersSent) res.status(500).json({ success: false, message: error.message });
    });
  }));
  router.post('/api/migration/estimate', deps.boundary(async (req, res) => {
    res.json({ success: true, data: await deps.service.estimate(req.body) });
  }));
  router.post('/api/migration/import-preview', deps.boundary(async (req, res) => {
    res.json({ success: true, data: await deps.service.preview(req) });
  }));
  router.post('/api/migration/import', deps.boundary(async (req, res) => {
    res.json({ success: true, data: await deps.service.importArchive(req, req.query) });
  }));
  return router;
}
