import { Router } from 'express';

type AvailabilityRecheckResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: number; message: string };

export function createAvailabilityRecheckRouter(deps: {
  request(bvid: string): AvailabilityRecheckResult;
}) {
  const router = Router();
  router.post('/api/videos/:bvid/availability-recheck', (request, response) => {
    const bvid = String(request.params.bvid || '').trim();
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
      response.status(400).json({ success: false, message: 'BV号格式无效' });
      return;
    }
    const result = deps.request(bvid);
    if (!result.ok) {
      response.status(result.status).json({ success: false, message: result.message });
      return;
    }
    response.status(202).json({ success: true, data: result });
  });
  return router;
}
