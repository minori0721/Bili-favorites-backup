import { Router } from 'express';
import { isRecord } from '../shared/api/value.js';
import type { createQualityMaintenance, QualityUpgradeRequest } from '../scheduler/quality-maintenance.js';
import type { RouteBoundary } from './route-boundary.js';
export function parseQualityUpgradeRequest(value: unknown): QualityUpgradeRequest[] | null {
    if (!isRecord(value) || !Array.isArray(value.items) || !value.items.length || value.items.length > 50)
        return null;
    const result: QualityUpgradeRequest[] = [];
    for (const item of value.items) {
        if (!isRecord(item))
            return null;
        if ((item.key !== undefined && typeof item.key !== 'string')
            || (item.userId !== undefined && typeof item.userId !== 'string')
            || (item.bvid !== undefined && typeof item.bvid !== 'string')
            || (item.mediaId !== undefined && (typeof item.mediaId !== 'number' || !Number.isFinite(item.mediaId)))
            || (item.forceUnknown !== undefined && typeof item.forceUnknown !== 'boolean'))
            return null;
        result.push({ key: item.key, userId: item.userId, bvid: item.bvid, mediaId: item.mediaId, forceUnknown: item.forceUnknown });
    }
    return result;
}
export function createQualityMaintenanceRouter(dependencies: {
    service: ReturnType<typeof createQualityMaintenance>;
    state(): unknown;
    detailLimit(value: unknown): number | undefined;
    boundary: RouteBoundary;
}) {
    const router = Router();
    router.post('/api/quality-upgrade/preview', dependencies.boundary((req, res) => {
        res.json({ success: true, data: dependencies.service.preview(dependencies.detailLimit(req.body?.detailLimit)) });
    }));
    router.post('/api/quality-upgrade', dependencies.boundary((req, res) => {
        const items = parseQualityUpgradeRequest(req.body);
        if (!items) {
            res.status(400).json({ success: false, message: 'items must contain 1-50 entries' });
            return;
        }
        res.json({ success: true, data: dependencies.service.submit(items) });
    }));
    router.get('/api/quality-upgrade/state', (_req, res) => {
        res.json({ success: true, data: dependencies.state() });
    });
    return router;
}
