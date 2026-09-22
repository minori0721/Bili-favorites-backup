import type { RemoteStoragePort } from '../../src/ports/external.js';
import type { SchedulerControl } from '../../src/ports/scheduler-control.js';
import type { SyncWorkflowCommands, SyncWorkflowQueries } from '../../src/ports/scheduler-workflows.js';
import { parseRecoveryUploadItem, type RecoveryUploadItem } from '../../src/scheduler/upload-work.js';

const schedulerControl = {
  start: () => true,
  stop: () => undefined,
  beginShutdown: () => undefined,
  shutdown: async () => undefined,
  isIdle: () => true,
  waitForIdle: async () => true,
  wake: () => true,
} satisfies SchedulerControl;

const verify: RemoteStoragePort['verify'] = async (..._args) => ({ok: true, missing: [], unknown: [], failures: {}});
const inspect: RemoteStoragePort['inspect'] = async (..._args) => ({status: 'unknown' as const});
const remoteStorage = {
  list: async (_path: string) => [] as string[],
  verify,
  inspect,
} satisfies RemoteStoragePort;

const unknownPayload = {
  bvid: 'BVTYPECHECK',
  localDir: '/archive/BVTYPECHECK',
  remotePath: '/archive/BVTYPECHECK',
};
const decoded: RecoveryUploadItem = parseRecoveryUploadItem(unknownPayload);

const syncCommands = {
  run: async () => true,
  triggerOrQueue: () => ({started: true, queued: false}),
} satisfies SyncWorkflowCommands;
const syncQueries = {
  hasPending: () => false,
  isSyncing: (_userId: string) => false,
  getProgress: () => null,
  getCycle: () => null,
  getPending: () => null,
  getLastError: () => '',
} satisfies SyncWorkflowQueries;

void schedulerControl;
void remoteStorage;
void decoded;
void syncCommands;
void syncQueries;
