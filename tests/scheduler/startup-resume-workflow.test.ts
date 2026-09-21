import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupResumeWorkflow } from '../../src/scheduler/startup-resume-workflow.js';

test('startup resume waits for asynchronous reconstruction before dispatching', async () => {
  const calls: string[] = [];
  let finishObsolete!: () => void;
  const obsolete = new Promise<void>(resolve => { finishObsolete = resolve; });
  const workflow = createStartupResumeWorkflow({
    shuttingDown: () => false,
    initializeRuntime: () => { calls.push('initialize'); },
    jobs: {
      recoverExpiredLeases: () => { calls.push('leases'); return 0; },
      normalizeTerminalUploadRecovery: () => { calls.push('normalize'); return 0; },
    },
    reconcileTransferSessions: force => { calls.push(`sessions:${force}`); },
    reconcileObsoleteVerifiedArchives: async () => { calls.push('obsolete:start'); await obsolete; calls.push('obsolete:done'); },
    migrateLegacyQualityDownloads: () => { calls.push('quality'); },
    bootstrapLegacyFailureClassification: () => { calls.push('classification'); },
    resumePersistedWork: () => { calls.push('resume'); },
    startLegacyCacheRecovery: () => { calls.push('cache'); },
    dispatchPersistentJobs: () => { calls.push('dispatch'); },
    now: () => 0,
    recoverStaleActiveBackups: () => undefined,
    ensurePersistedChargingAccessProbes: () => undefined,
    ensurePersistedAvailabilityProbes: () => undefined,
  });

  const recovery = workflow.resumePersistedWorkOnStartup();
  await Promise.resolve();
  assert.deepEqual(calls, ['initialize', 'leases', 'sessions:true', 'normalize', 'obsolete:start']);
  finishObsolete();
  await recovery;
  assert.deepEqual(calls, [
    'initialize',
    'leases',
    'sessions:true',
    'normalize',
    'obsolete:start',
    'obsolete:done',
    'quality',
    'classification',
    'resume',
    'cache',
    'dispatch',
  ]);
});

test('startup resume remains closed once shutdown begins', async () => {
  let called = false;
  const workflow = createStartupResumeWorkflow({
    shuttingDown: () => true,
    initializeRuntime: () => { called = true; },
    jobs: { recoverExpiredLeases: () => 0, normalizeTerminalUploadRecovery: () => 0 },
    reconcileTransferSessions: () => undefined,
    reconcileObsoleteVerifiedArchives: async () => undefined,
    migrateLegacyQualityDownloads: () => undefined,
    bootstrapLegacyFailureClassification: () => undefined,
    resumePersistedWork: () => undefined,
    startLegacyCacheRecovery: () => undefined,
    dispatchPersistentJobs: () => undefined,
    now: () => 0,
    recoverStaleActiveBackups: () => undefined,
    ensurePersistedChargingAccessProbes: () => undefined,
    ensurePersistedAvailabilityProbes: () => undefined,
  });
  await workflow.resumePersistedWorkOnStartup();
  assert.equal(called, false);
});

test('startup resume propagates asynchronous reconstruction failure and never dispatches', async () => {
  let dispatched = false;
  const workflow = createStartupResumeWorkflow({
    shuttingDown: () => false,
    initializeRuntime: () => undefined,
    jobs: { recoverExpiredLeases: () => 0, normalizeTerminalUploadRecovery: () => 0 },
    reconcileTransferSessions: () => undefined,
    reconcileObsoleteVerifiedArchives: async () => { throw new Error('remote proof unavailable'); },
    migrateLegacyQualityDownloads: () => undefined,
    bootstrapLegacyFailureClassification: () => undefined,
    resumePersistedWork: () => undefined,
    startLegacyCacheRecovery: () => undefined,
    dispatchPersistentJobs: () => { dispatched = true; },
    now: () => 0,
    recoverStaleActiveBackups: () => undefined,
    ensurePersistedChargingAccessProbes: () => undefined,
    ensurePersistedAvailabilityProbes: () => undefined,
  });
  await assert.rejects(workflow.resumePersistedWorkOnStartup(), /remote proof unavailable/);
  assert.equal(dispatched, false);
});

test('startup resume does not continue when shutdown begins during asynchronous reconstruction', async () => {
  let shuttingDown = false;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [];
  const workflow = createStartupResumeWorkflow({
    shuttingDown: () => shuttingDown,
    initializeRuntime: () => undefined,
    jobs: { recoverExpiredLeases: () => 0, normalizeTerminalUploadRecovery: () => 0 },
    reconcileTransferSessions: () => undefined,
    reconcileObsoleteVerifiedArchives: async () => { await gate; },
    migrateLegacyQualityDownloads: () => { calls.push('quality'); },
    bootstrapLegacyFailureClassification: () => { calls.push('classification'); },
    resumePersistedWork: () => { calls.push('resume'); },
    startLegacyCacheRecovery: () => { calls.push('cache'); },
    dispatchPersistentJobs: () => { calls.push('dispatch'); },
    now: () => 0,
    recoverStaleActiveBackups: () => undefined,
    ensurePersistedChargingAccessProbes: () => undefined,
    ensurePersistedAvailabilityProbes: () => undefined,
  });
  const recovery = workflow.resumePersistedWorkOnStartup();
  shuttingDown = true;
  finish();
  await recovery;
  assert.deepEqual(calls, []);
});
