import { createAccessProbes } from '../../src/scheduler/access-probes.js';
import { createAccessAdmission } from '../../src/scheduler/access-admission.js';
import { createStartupProbes } from '../../src/scheduler/startup-probes.js';
import { createBackupEnqueue } from '../../src/scheduler/backup-enqueue.js';
import { createArchiveTargets } from '../../src/scheduler/archive-targets.js';
import type { StateManager } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import type { ConfigStore } from '../../src/config.js';
import type { PersistentJobStore } from '../../src/job-store.js';
import type { VideoPageSnapshotResult } from '../../src/bili.js';

export function createAccessFixture(state: StateManager, jobs: PersistentJobStore, config: Pick<ConfigStore, 'get'>,
  users: {list(): BiliUser[]; getById(id: string): BiliUser | null}, owner: string,
  inspect: (cookie: BiliUser['cookie'], bvid: string) => Promise<VideoPageSnapshotResult>, now: () => number, random: () => number) {
  const eligible = (user: BiliUser | null | undefined): user is BiliUser =>
    !!user?.enabled && !state.getDatabase().hasUnfinishedArchiveAccountDeletion(user.id);
  const targets = createArchiveTargets({state, config, users, eligible,
    sourceBlocked: (u,m,b) => state.getDatabase().isArchiveSourceDeletionBlocked(u,m,b)});
  const backup = createBackupEnqueue({state, jobs, config, eligible,
    blocked: (u,m,b) => state.getDatabase().isArchiveSourceDeletionBlocked(u,m,b),
    remotePath: targets.resolveRelationRemotePath, proof: () => undefined,
    uploadJob: () => { throw new Error('Unexpected upload in access test'); }, historySegment: value => value,
    probe: (bvid, input) => admission.enqueueChargingAccessProbe(bvid, input),
    cycleStartedAt: () => undefined, generation: () => 0, now, dispatch: () => {},
  });
  const probes = createAccessProbes({state, jobs, users, owner, now, random, generation: () => 0,
    canContinue: () => true, eligible, inspect, resolve: targets.resolveRelation,
    enqueue: backup.enqueue, prepareCharging: backup.prepareAfterAccessCheck,
  });
  const admission = createAccessAdmission({state, jobs, now, users: (bvid, charging) => probes.users(bvid, '', new Set(), charging), wake: () => {}});
  const startup = createStartupProbes({stateManager: state, jobStore: jobs, database: () => state.getDatabase(), now,
    enqueueChargingAccessProbe: admission.enqueueChargingAccessProbe, enqueueAvailabilityProbe: admission.enqueueAvailabilityProbe});
  return {
    probes,
    admission: {
      enqueueProbe: admission.enqueueChargingAccessProbe,
      enqueueAvailability: admission.enqueueAvailabilityProbe,
    },
    startup: { ensureProbes: startup.ensurePersistedAvailabilityProbes },
  };
}
