import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { classifyVideoAccess, inspectVideoPageSnapshot, type VideoPageSnapshotResult } from '../../src/bili.js';
import { createAccessFixture } from '../fixtures/access-workflow.js';
import { createAccessProbes } from '../../src/scheduler/access-probes.js';
import { createAccessProbeWorkflow } from '../../src/scheduler/access-probe-workflow.js';
import { createBackupEnqueue } from '../../src/scheduler/backup-enqueue.js';
import { accessProbeRequestRevision } from '../../src/scheduler/access-rules.js';
import type { BiliUser } from '../../src/users.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

const owner = 'access-contract', bvid = 'BVCONTRACT';
function snapshot(access: 'normal' | 'allowed' | 'restricted' | 'unknown'): VideoPageSnapshotResult {
  return { available: true, availability: 'available', access: classifyVideoAccess(access === 'normal'
    ? { is_upower_exclusive: false } : access === 'unknown' ? undefined
      : { is_upower_exclusive: true, is_upower_play: access === 'allowed' }),
    pages: [{ index: 1, cid: 1, title: 'P1', duration: 1 }] };
}
async function fixture(inspect: (cookie: BiliUser['cookie'], bvid: string) => Promise<VideoPageSnapshotResult> = async () => snapshot('allowed'),
  source: 'favorite' | 'manual' | 'self-visible' = 'favorite') {
  const root = await createTestDir('access-contract');
  const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'bfb.sqlite') });
  const jobs = new PersistentJobStore(state.getDatabase()), now = Date.now();
  const user: BiliUser = { id: 'u1', uid: 1, name: 'Fake', enabled: true, lastLoginAt: '',
    favorites: [{ mediaId: 1, title: 'One' }, { mediaId: 2, title: 'Two' }],
    cookie: { SESSDATA: 'fake', bili_jct: 'fake', DedeUserID: '1' } };
  if (source === 'manual') state.recordManualArchiveItem(user.id, { bvid, title: 'Fake', upperName: 'Fake UP' });
  else state.recordFavoriteItem(user.id, 1, 'One', { bvid, title: 'Fake', upperName: 'Fake UP', selfVisible: source === 'self-visible' });
  const ports = createAccessFixture(state, jobs, { get: () => testConfig() },
    { list: () => [user], getById: id => id === user.id ? user : null }, owner, inspect, () => now, () => 0.5);
  return { root, state, jobs, user, now, ...ports, close: async () => { state.close(); await removeTestDir(root); } };
}
function restrict(f: Awaited<ReturnType<typeof fixture>>) {
  f.state.markChargingRestricted(bvid, { checkedAt: new Date(f.now).toISOString(),
    nextCheckAt: new Date(f.now + 86_400_000).toISOString(), checkedAccountUids: [] });
}
function claim(f: Awaited<ReturnType<typeof fixture>>) {
  const [job] = f.jobs.claimDue(['access_probe'], 1, owner, 300_000, Date.now());
  assert.ok(job); assert.equal(f.jobs.markRunning(job.id, owner), true); return job;
}

for (const intents of [['charging'], ['charging', 'availability'], ['availability']] as const) {
  test(`confirmed access restores every eligible relation and quality task: ${intents.join('+')}`, async () => {
    const f = await fixture();
    try {
      f.state.recordFavoriteItem('u1', 2, 'Two', { bvid, title: 'Fake', upperName: 'Fake UP' }); restrict(f);
      f.jobs.enqueue({ kind: 'quality_download', dedupeKey: 'quality:contract', bvid, notBefore: f.now + 86_400_000,
        payload: { downloadUserId: 'old-user' } });
      f.admission.enqueueProbe(bvid, { intents: [...intents] }); await f.probes.charging(claim(f));
      assert.equal(f.state.getChargingRestriction(bvid), undefined);
      for (const mediaId of [1, 2]) assert.equal(f.state.getRelationStatus('u1', mediaId, bvid)?.backupStatus, 'queued');
      assert.equal(f.jobs.list(['download'], 10).length, 1);
      assert.equal(f.jobs.findByDedupeKey('access_probe:' + bvid), null);
      const quality = f.jobs.findByDedupeKey('quality:contract');
      assert.equal(quality?.payload.downloadUserId, 'u1'); assert.ok(quality && quality.notBefore <= Date.now());
    } finally { await f.close(); }
  });
}
for (const access of ['restricted', 'unknown'] as const) {
  test(`visible details with ${access} access cannot authorize backup`, async () => {
    const f = await fixture(async () => snapshot(access));
    try {
      f.admission.enqueueAvailability(bvid); await f.probes.charging(claim(f));
      assert.equal(f.jobs.findByDedupeKey('download:' + bvid), null);
      assert.equal(f.jobs.findByDedupeKey('access_probe:' + bvid)?.status, 'retry_wait');
      assert.equal(Boolean(f.state.getChargingRestriction(bvid)), access === 'restricted');
    } finally { await f.close(); }
  });
}
for (const source of ['manual', 'self-visible'] as const) {
  test(`merged recovery retains charging recovery for ${source} relations`, async () => {
    const f = await fixture(undefined, source);
    try {
      restrict(f);
      f.admission.enqueueProbe(bvid, { intents: ['availability', 'charging'] }); await f.probes.charging(claim(f));
      assert.equal(f.state.getChargingRestriction(bvid), undefined);
      assert.equal(f.state.getRelationStatus('u1', source === 'manual' ? -1 : 1, bvid)?.backupStatus, 'queued');
      assert.ok(f.jobs.findByDedupeKey('download:' + bvid));
      assert.equal(f.jobs.findByDedupeKey('access_probe:' + bvid), null);
    } finally { await f.close(); }
  });
}
for (const failure of ['download', 'quality', 'completion'] as const) {
  test(`merged recovery rolls back all state when ${failure} persistence fails`, async () => {
    const f = await fixture();
    try {
      restrict(f);
      f.jobs.enqueue({ kind: 'quality_download', dedupeKey: 'quality:rollback', bvid, notBefore: f.now + 86_400_000,
        payload: { downloadUserId: 'old-user' } });
      f.admission.enqueueProbe(bvid, { intents: ['availability', 'charging'] });
      const job = claim(f), restriction = f.state.getChargingRestriction(bvid), quality = f.jobs.findByDedupeKey('quality:rollback');
      const trigger = failure === 'download' ? "BEFORE INSERT ON jobs WHEN NEW.kind='download'"
        : failure === 'quality' ? "BEFORE UPDATE ON jobs WHEN NEW.kind='quality_download'"
          : "BEFORE DELETE ON jobs WHEN OLD.kind='access_probe'";
      f.state.getDatabase().db.exec(`CREATE TRIGGER fail_recovery ${trigger} BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`);
      await assert.rejects(f.probes.charging(job), /injected recovery failure/);
      assert.deepEqual(f.state.getChargingRestriction(bvid), restriction);
      assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, 'charging_restricted');
      assert.equal(f.jobs.findByDedupeKey('download:' + bvid), null);
      assert.equal(f.jobs.findById(job.id)?.status, 'running');
      assert.deepEqual(f.jobs.findByDedupeKey('quality:rollback'), quality);
    } finally { await f.close(); }
  });
}

test('local upload leaves probe completion to its enclosing recovery transaction', async () => {
  const f = await fixture();
  try {
    const localDir = path.join(f.root, 'media'), at = new Date(f.now).toISOString();
    await fs.mkdir(localDir); await fs.writeFile(path.join(localDir, 'video.mp4'), 'media');
    await fs.writeFile(path.join(localDir, '.bfb-download.json'), JSON.stringify({ schemaVersion: 1,
      sessionId: 'session', kind: 'backup', bvid, accountUid: 1, bbdownCommit: 'test', configFingerprint: 'test',
      configSnapshot: { quality: '', encoding: '', hiRes: false, dolby: false, filenameTemplate: '<bvid>' },
      createdAt: at, updatedAt: at, snapshotAt: at, status: 'complete',
      pages: [{ index: 1, cid: 1, title: 'P1', duration: 1 }], history: [],
      outputs: [{ pageIndex: 1, cid: 1, relativePath: 'video.mp4', size: 5, duration: 1, videoCodec: 'test', quickHash: 'test', verifiedAt: at }] }));
    const seed = f.state.getStateSnapshot(); assert.ok(seed.videos); seed.videos[bvid].localDir = localDir;
    f.state.replaceStateSnapshot(seed); restrict(f);
    const backup = createBackupEnqueue({ state: f.state, jobs: f.jobs, config: { get: () => testConfig() }, eligible: () => true,
      blocked: () => false, remotePath: () => '/archive', proof: () => undefined,
      uploadJob: item => ({ kind: 'upload', dedupeKey: 'upload:' + item.bvid, bvid: item.bvid }),
      historySegment: value => value, probe: () => assert.fail('unexpected probe'), cycleStartedAt: () => undefined,
      generation: () => 0, now: () => f.now, dispatch: () => {} });
    const probes = createAccessProbes({ state: f.state, jobs: f.jobs, users: { list: () => [f.user] }, owner,
      now: () => f.now, random: () => 0.5, generation: () => 0, canContinue: () => true, eligible: () => true,
      inspect: async () => snapshot('allowed'), resolve: relation => ({ user: f.user, mediaId: relation.mediaId, folderTitle: 'One' }),
      prepareAfterAccessCheck: backup.prepareAfterAccessCheck });
    f.admission.enqueueProbe(bvid, { intents: ['availability', 'charging'] }); await probes.charging(claim(f));
    assert.equal(f.jobs.findByDedupeKey('access_probe:' + bvid), null);
    assert.equal(f.jobs.list(['upload'], 10).length, 1); assert.equal(f.state.getChargingRestriction(bvid), undefined);
    assert.equal(await fs.readFile(path.join(localDir, 'video.mp4'), 'utf8'), 'media');
  } finally { await f.close(); }
});

for (const result of ['allowed', 'restricted', 'unavailable', 'error'] as const) {
  test(`new request survives an in-flight ${result} result and runs once afterward`, async () => {
    let release!: (value: VideoPageSnapshotResult) => void, fail!: (error: Error) => void, started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<VideoPageSnapshotResult>((resolve, reject) => { release = resolve; fail = reject; });
    let calls = 0;
    const f = await fixture(async () => { if (++calls === 1) { started(); return response; } return snapshot('allowed'); });
    try {
      restrict(f); f.admission.enqueueProbe(bvid, { intents: ['charging'] });
      const job = claim(f), before = f.state.getChargingRestriction(bvid), run = f.probes.charging(job); await start;
      assert.equal(f.admission.requestRecheck(bvid).ok, true); assert.equal(f.admission.requestRecheck(bvid).ok, true);
      if (result === 'error') fail(new Error('fake transport failure'));
      else release(result === 'unavailable'
        ? { available: false, availability: 'unavailable', availabilityReason: 'api_not_found', pages: [], access: classifyVideoAccess(undefined) }
        : snapshot(result));
      await run;
      const pending = f.jobs.findById(job.id);
      assert.equal(pending?.status, 'retry_wait'); assert.equal(pending?.payload.manual, true);
      assert.deepEqual(pending?.payload.intents, ['charging', 'availability']);
      assert.equal(f.jobs.list(['access_probe'], 10).length, 1); assert.deepEqual(f.state.getChargingRestriction(bvid), before);
      assert.equal(f.jobs.findByDedupeKey('download:' + bvid), null); assert.ok(pending && pending.notBefore <= Date.now());
      await f.probes.charging(claim(f));
      assert.equal(calls, 2); assert.equal(f.jobs.findByDedupeKey('access_probe:' + bvid), null);
      assert.ok(f.jobs.findByDedupeKey('download:' + bvid));
    } finally { await f.close(); }
  });
}

test('availability execution and late failure handling preserve charging added in flight', async () => {
  let release!: (value: VideoPageSnapshotResult) => void, started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(() => { started(); return new Promise(resolve => { release = resolve; }); });
  try {
    f.admission.enqueueAvailability(bvid); const job = claim(f), run = f.probes.availability(job); await start;
    f.admission.enqueueProbe(bvid, { intents: ['charging'], preferredUserId: 'u1' }); release(snapshot('normal')); await run;
    assert.deepEqual(f.jobs.findById(job.id)?.payload.intents, ['availability', 'charging']);
    assert.equal(f.jobs.findByDedupeKey('download:' + bvid), null);
    const next = claim(f); f.admission.requestRecheck(bvid); f.probes.failed(next, new Error('late execution failure'));
    assert.equal(f.jobs.findById(next.id)?.payload.manual, true); assert.ok(f.jobs.findById(next.id)!.notBefore <= Date.now());
  } finally { await f.close(); }
});

test('request revisions support legacy payloads and reject invalid metadata', () => {
  assert.equal(accessProbeRequestRevision({}), 0); assert.equal(accessProbeRequestRevision({ requestRevision: 3 }), 3);
  for (const value of [-1, 0.5, '1', null, Number.NaN]) assert.throws(() => accessProbeRequestRevision({ requestRevision: value }), /requestRevision/);
});

test('quality-only recovery keeps completed archives and wakes the existing quality download', async () => {
  const f = await fixture();
  try {
    const seed = f.state.getStateSnapshot(); assert.ok(seed.videos); assert.ok(seed.relations);
    seed.videos[bvid].backupStatus = 'verified'; seed.relations['u1:1:' + bvid].backupStatus = 'verified';
    f.state.replaceStateSnapshot(seed); restrict(f);
    f.jobs.enqueue({ kind: 'quality_download', bvid, dedupeKey: 'quality:only', notBefore: f.now + 86_400_000 });
    f.admission.enqueueProbe(bvid, { intents: ['availability', 'charging'] }); await f.probes.charging(claim(f));
    assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, 'verified');
    assert.equal(f.state.getChargingRestriction(bvid), undefined);
    assert.equal(f.jobs.list(['download'], 10).length, 0);
    assert.equal(f.jobs.findByDedupeKey('quality:only')?.payload.downloadUserId, 'u1');
    assert.ok(f.jobs.findByDedupeKey('quality:only')!.notBefore <= Date.now());
  } finally { await f.close(); }
});

test('pure charging probes pace consecutive accounts through the production workflow gate', async () => {
  const f = await fixture(); let workflow: ReturnType<typeof createAccessProbeWorkflow> | undefined;
  try {
    let clock = f.now; const requests: number[] = [];
    const other: BiliUser = { ...f.user, id: 'u2', uid: 2, cookie: { ...f.user.cookie, DedeUserID: '2' } };
    restrict(f); f.admission.enqueueProbe(bvid, { intents: ['charging'] });
    const probes = createAccessProbes({ state: f.state, jobs: f.jobs, users: { list: () => [f.user, other] }, owner,
      now: () => clock, random: () => 0.5, generation: () => 0, canContinue: () => true, eligible: () => true,
      inspect: async cookie => { requests.push(clock); return snapshot(cookie.DedeUserID === '1' ? 'restricted' : 'allowed'); },
      resolve: () => null, prepareAfterAccessCheck: () => null });
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
    workflow = createAccessProbeWorkflow({ jobs: f.jobs, owner, now: () => clock, generation: () => 0,
      accepting: () => true, shuttingDown: () => false, requestIntervalMs: 10_000, sleep: async ms => { clock += ms; },
      run: (job, gate) => probes.charging(job, gate), failed: (_job, error) => { throw error; }, wake: finish });
    workflow.dispatch(); await done; assert.deepEqual(requests.map(at => at - f.now), [0, 10_000]);
  } finally { workflow?.stop(); await f.close(); }
});

for (const fallback of ['view', 'player'] as const) {
  test(`actual ${fallback} fallback and consecutive videos share request pacing`, async () => {
    const f = await fixture(); let workflow: ReturnType<typeof createAccessProbeWorkflow> | undefined;
    try {
      let clock = f.now, completed = 0; const starts: number[] = [];
      const view = { cid: 1, pages: [{ page: 1, cid: 1, part: 'P1', duration: 1 }] };
      const probes = createAccessProbes({ state: f.state, jobs: f.jobs, users: { list: () => [f.user] }, owner,
        now: () => clock, random: () => 0.5, generation: () => 0, canContinue: () => true, eligible: () => true,
        inspect: (_cookie, id, options) => inspectVideoPageSnapshot({
          view: async url => { starts.push(clock); if (fallback === 'view' && url.includes('/detail?')) return { data: { code: -404, data: null } };
            return { data: { code: 0, data: { ...view, ...(fallback === 'view' ? { is_upower_exclusive: false } : {}) } } }; },
          player: async () => { starts.push(clock); return { is_upower_exclusive: false }; },
        }, id, options), resolve: () => null, prepareAfterAccessCheck: () => null });
      f.admission.enqueueAvailability(bvid);
      f.state.recordFavoriteItem('u1', 1, 'One', { bvid: 'BVSECOND', title: 'Second', upperName: 'UP' });
      f.admission.enqueueAvailability('BVSECOND');
      let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
      workflow = createAccessProbeWorkflow({ jobs: f.jobs, owner, now: () => clock, generation: () => 0,
        accepting: () => true, shuttingDown: () => false, requestIntervalMs: 10_000, sleep: async ms => { clock += ms; },
        run: async (job, beforeRequest) => { await probes.charging(job, beforeRequest); completed++; },
        failed: (_job, error) => { throw error; }, wake: () => { if (completed === 2) finish(); else workflow!.dispatch(); } });
      workflow.dispatch(); await done; assert.deepEqual(starts.map(at => at - f.now), [0, 10_000, 20_000, 30_000]);
    } finally { workflow?.stop(); await f.close(); }
  });
  test(`lifecycle interruption before ${fallback} fallback propagates without HTTP`, async () => {
    const interrupted = new Error('interrupted'); let admissions = 0, requests = 0;
    await assert.rejects(inspectVideoPageSnapshot({
      view: async () => { requests++; return fallback === 'view' ? { data: { code: -404, data: null } }
        : { data: { code: 0, data: { cid: 1, pages: [{ page: 1, cid: 1 }] } } }; },
      player: async () => { requests++; return { is_upower_exclusive: false }; },
    }, bvid, { beforeRequest: async () => { if (++admissions === 2) throw interrupted; } }), error => error === interrupted);
    assert.equal(requests, 1);
  });
}
