import { Router } from 'express';
import type { ArchiveVideoActions } from '../archive-video-actions.js';
import type { RouteBoundary } from './route-boundary.js';

export function createArchiveVideoActionsRouter(deps: {service: Pick<ArchiveVideoActions,'context'|'preview'|'commit'|'unblock'>; boundary: RouteBoundary}) {
  const router = Router();
  for(const [path,action] of [['context','context'],['preview','preview'],['commit','commit'],['unblock','unblock']] as const) {
    router.post(`/api/archive-library/items/:bvid/actions/${path}`,deps.boundary((request,response) => {
      response.setHeader('Cache-Control','private, no-store');
      response.json({success:true,data:deps.service[action](request.params.bvid,request.body)});
    }));
  }
  return router;
}
