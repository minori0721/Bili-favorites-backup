import type {QueueSnapshot} from '../../../shared/api/queue-snapshot.js';

export type WorkspaceQueueState = {status:'loading'} | {status:'error'} | {status:'ready';snapshot:QueueSnapshot};
export type WorkspaceSubscriptionState = {status:'loading'} | {status:'error'} | {status:'ready';total:number;enabled:number};
