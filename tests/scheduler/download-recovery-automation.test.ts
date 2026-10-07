import { memoryUsers } from '../fixtures/memory-users.js';
import { SyncScheduler } from '../../src/scheduler.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { resumeAutomaticDownload, downloadRecoveryDelay } from '../../src/scheduler/download-recovery-automation.js';
import { createRecoveryAutomation } from '../../src/scheduler/recovery-automation.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

async function fixture() {
  const root = await createTestDir('automatic-download');
  const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite') });
  let now = 10_000, allowed = true, eligible = true, dispatches = 0;
  const jobs = new PersistentJobStore(state.getDatabase(), { now: () => now });
  const user = { id: 'u', uid: 1, name: 'Fixture', cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' },
    favorites: [], enabled: true, lastLoginAt: 'first' };
  const dependencies = { jobs, user: (id: string) => id === user.id ? user : null, eligible: () => eligible, atomic: <T>(fn: () => T) => state.runAtomic(fn),
    now: () => now, canRun: () => allowed, resumed: () => {}, dispatch: () => { dispatches++; } };
  const enqueue = (category: string, extra: Record<string, unknown> = {}) => jobs.enqueue({ kind: 'download', bvid: 'BVAUTO',
    dedupeKey: category, userId: 'u', initialStatus: 'manual_wait', payload: { awaitingManualRecovery: true,
      recoveryParentJobId: 'parent', recoveryOriginalLocalDir: 'original', automaticRecoveryAttempts: 2,
      downloadRecovery: { category, nextCheckAt: now + 100 }, ...extra } });
  return { state, jobs, user, enqueue, dependencies, advance: (ms: number) => { now += ms; },
    allow: (value: boolean) => { allowed = value; }, eligible: (value: boolean) => { eligible = value; },
    dispatches: () => dispatches, close: async () => { state.close(); await removeTestDir(root); } };
}

test('transient recovery resumes once through persistent admission without resetting independent redownload evidence', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('transient');
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), false);
    f.advance(100);
    assert.equal(f.jobs.listDueManualRecovery(['download']).length, 1);
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), true);
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), false);
    const current = f.jobs.findById(job.id); assert.ok(current);
    assert.equal(current.status, 'pending'); assert.equal(current.payload.automaticDownloadResumes, 1);
    assert.equal(current.payload.automaticRecoveryAttempts, 2); assert.equal(current.payload.recoveryOriginalLocalDir, 'original');
    assert.equal(f.dispatches(), 1); assert.equal(f.jobs.listDueManualRecovery(['download']).length, 0);
  } finally { await f.close(); }
});

test('account recovery waits for a changed local credential revision and never probes Bilibili', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('account'); f.advance(100);
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), false);
    assert.equal(f.jobs.findById(job.id)?.payload.recoveryParentJobId, 'parent');
    f.advance(downloadRecoveryDelay(0));
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), false);
    f.user.lastLoginAt = 'updated'; f.advance(downloadRecoveryDelay(0));
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), true);
    assert.equal(f.dispatches(), 1);
  } finally { await f.close(); }
});

test('maintenance, stopped attempts, unknown/tool failures and unavailable accounts do not resume', async () => {
  const f = await fixture();
  try {
    const transient = f.enqueue('transient'); f.advance(100); f.allow(false);
    assert.equal(resumeAutomaticDownload(f.dependencies, transient.id), false); f.allow(true); f.eligible(false);
    assert.equal(resumeAutomaticDownload(f.dependencies, transient.id), false);
    assert.equal(f.jobs.listDueManualRecovery(['download']).length, 0);
    f.eligible(true);
    for (const category of ['tool', 'unknown']) assert.equal(resumeAutomaticDownload(f.dependencies, f.enqueue(category).id), false);
    const stopped = f.enqueue('account', { userDisposition: 'abandoned' }); f.advance(100);
    assert.equal(resumeAutomaticDownload(f.dependencies, stopped.id), false);
    assert.equal(f.dispatches(), 0);
  } finally { await f.close(); }
});

test('automation routes download jobs to the local resume port and uploads to read-only assessment', async () => {
  const f = await fixture();
  try {
    f.enqueue('transient'); f.advance(100);
    let assessed = 0;
    const automation = createRecoveryAutomation({ jobs: f.jobs, now: f.dependencies.now, canRun: () => true, generation: () => 0,
      refreshProjection() {}, assess: async () => { assessed++; }, resumeDownload: id => resumeAutomaticDownload(f.dependencies, id), reportError: assert.fail });
    await automation.run(); assert.equal(assessed, 0); assert.equal(f.dispatches(), 1); assert.equal(automation.busy, false);
    automation.stop();
  } finally { await f.close(); }
});

test('resume backoff grows to six hours and rejects invalid persisted rounds', () => {
  assert.deepEqual([0, 1, 2, 20].map(downloadRecoveryDelay), [30 * 60_000, 2 * 3600_000, 6 * 3600_000, 6 * 3600_000]);
  for (const value of [-1, NaN, 1.5]) assert.throws(() => downloadRecoveryDelay(value), /Invalid/);
});

test('credentials updated before the first review still resume the failed attempt', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('account', { downloadRecovery: { category: 'account', nextCheckAt: 0, credentialRevision: 'first|' } });
    f.user.lastLoginAt = 'updated';
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), true);
    assert.equal(f.dispatches(), 1);
  } finally { await f.close(); }
});

test('the real queue board and issue projection agree that transient download recovery is background work', async () => {
  const f = await fixture();
  const scheduler = new SyncScheduler({ get: testConfig }, memoryUsers([f.user]), f.state);
  try {
    const transient = f.enqueue('transient');
    const snapshot = scheduler.getQueueSnapshot();
    const card = snapshot.downloadPending.find(item => item.persistentJobId === transient.id);
    assert.ok(card); assert.equal(card.phase, 'background_wait'); assert.equal(card.actionRequired, false);
    assert.equal(card.nextAction, 'retry'); assert.equal(card.nextActionAt, 10_100);
    assert.match(card.detail || '', /自动继续/);
    const issues = scheduler.getRecoveryIssueSnapshot();
    assert.equal(issues.issues.some(item => item.id === `download.${transient.id}`), false);
    assert.equal(issues.backgroundRecoveries.some(item => item.id === `download.${transient.id}`), true);
    for (const category of ['account', 'tool', 'unknown']) {
      const job = f.enqueue(category);
      const manual = scheduler.getQueueSnapshot().downloadPending.find(item => item.persistentJobId === job.id);
      assert.ok(manual); assert.equal(manual.actionRequired, true); assert.equal(manual.phase, 'manual_action');
    }
  } finally { scheduler.stop(); await f.close(); }
});

test('automatic resume follows the account that actually failed instead of a retired original account', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('transient', { downloadUserId: 'retired', downloadRecovery: { category: 'transient', nextCheckAt: 0, downloadUserId: 'u' } });
    assert.equal(resumeAutomaticDownload(f.dependencies, job.id), true);
    assert.equal(f.jobs.findById(job.id)?.payload.downloadUserId, 'u');
    assert.equal(f.dispatches(), 1);
  } finally { await f.close(); }
});
