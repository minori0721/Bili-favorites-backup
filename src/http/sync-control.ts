import { Router } from 'express';
import type { RouteBoundary } from './route-boundary.js';
import { safeErrorSummary } from '../diagnostics.js';

type Trigger = () => {started: boolean; queued: boolean};
export function createSyncControlRouter(dependencies: {sync: Trigger; reconcile: Trigger; remote: Trigger; boundary: RouteBoundary}) {
  const router = Router();
  const commands: Array<{path: string; run: Trigger; label: string; failure: string}> = [
    {path:'/api/sync/now',run:dependencies.sync,label:'Sync',failure:'Sync failed'},
    {path:'/api/sync/reconcile',run:dependencies.reconcile,label:'Reconcile',failure:'Reconcile failed'},
    {path:'/api/sync/reconcile-remote',run:dependencies.remote,label:'Remote-only reconcile',failure:'Remote reconcile failed'},
  ];
  for (const command of commands) {
    router.post(command.path, dependencies.boundary((_request, response) => {
      try {
        const result = command.run();
        if (result.started || result.queued) {
          response.json({success:true,data:{message:command.label + (result.started ? ' triggered' : ' queued'),queued:!result.started}});
        } else response.status(409).json({success:false,message:'A sync task is already running'});
      } catch(error) { response.status(500).json({success:false,message:safeErrorSummary(error,command.failure)}); }
    }));
  }
  return router;
}
