import { randomUUID } from 'node:crypto';
import { SyncScheduler } from '../../src/scheduler.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { heldQueues } from './held-queues.js';

type Args = ConstructorParameters<typeof SyncScheduler>;
export function createHeldScheduler(config: Args[0], users: Omit<Args[1], 'updatePartial'>, state: Args[2], dependencies: Args[3] = {}) {
  const queues = heldQueues();
  const owner = randomUUID();
  const clock = dependencies.clock;
  const jobs = new PersistentJobStore(state.getDatabase(), {
    normalizeRecovery: false,
    now: dependencies.now ?? (clock ? () => clock.now() : undefined),
  });
  const sessions = new TransferSessionStore(state.getDatabase());
  const scheduler = new SyncScheduler(config, {
    ...users, updatePartial: () => { throw new Error('Unexpected user mutation'); },
  }, state, {...dependencies, createQueue: queues.create, leaseOwner: owner});
  return {scheduler, jobs, sessions, queues, owner};
}
