import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRemoteScan } from '../../src/scheduler/remote-scan.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import type { verifyRemoteFiles } from '../../src/uploader.js';
import { captureRemoteCheckEvidence, type RemoteCheckOutcome } from '../../src/remote-check.js';
import type { RemoteFileRecord } from '../../src/state.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const verified = { ok: true, missing: [], unknown: [], failures: {} };

for (const failure of ['generation', 'worker'] as const) {
  test(`remote scan drains every started worker after ${failure} change`, async () => {
    const runtime = await createTestDir('remote-scan-drain');
    const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
    const count = failure === 'generation' ? 3 : 2;
    const candidates = Array.from({ length: count }, (_, index) => {
      const bvid = 'BVREMOTE' + index;
      state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP' });
      state.markVerifiedUpload(bvid, '/archive', [{ name: bvid + '.mp4', path: '/archive/' + bvid + '.mp4', verificationStatus: 'verified' }], 'u', 1);
      return state.listVideosForRemoteVerify().find(candidate => candidate.bvid === bvid)!;
    });
    let generation = 0, writes = 0;
    const resolves: Array<(value: Awaited<ReturnType<typeof verifyRemoteFiles>>) => void> = [];
    const scan = createRemoteScan({ config: { get: () => testConfig({ remoteVerifyConcurrency: 2 }) },
      state: {
        listVideosForRemoteVerify: () => candidates, countVideosForRemoteVerify: () => count,
        listRelationsForBvid: bvid => state.listRelationsForBvid(bvid),
        commitRemoteCheck: (...args) => { const committed = state.commitRemoteCheck(...args); if (committed) writes++; return committed; },
      },
      io: { clearPathReservations() {}, list: async () => [], waitForSlot: async () => {} },
      random: () => 0, sleep: async () => {}, generation: () => generation, canContinue: () => true,
      verify: () => new Promise(resolve => resolves.push(resolve)), resolve: () => null, bestRelation: () => null,
      remotePath: () => '/archive', enqueue: () => false,
      progress: patch => { if (failure === 'worker' && patch.checked === 1) throw new Error('progress failure'); },
    });
    try {
      let settled = false;
      const result = scan.run(false, true, { trigger: 'auto', title: 'Auto', newItems: 0 }).then(
        value => { settled = true; return { value }; }, error => { settled = true; return { error }; },
      );
      await flush();
      assert.equal(resolves.length, failure === 'generation' ? 2 : 1);
      assert.equal(settled, false);
      if (failure === 'generation') generation++;
      for (const resolve of resolves) resolve(verified);
      const outcome = await result;
      if (failure === 'generation') {
        assert.equal(writes, 0);
        assert.equal(resolves.length, 2);
        assert.ok('value' in outcome);
      } else {
        assert.ok('error' in outcome);
        assert.match(String(outcome.error), /progress failure/);
        assert.equal(writes, 1);
      }
    } finally { state.close(); await removeTestDir(runtime); }
  });
}

const oldFiles: RemoteFileRecord[] = [{name: 'BVPROOF.mp4', path: '/archive/BVPROOF.mp4', size: 10, verificationStatus: 'verified'}];
const newFiles: RemoteFileRecord[] = [{...oldFiles[0], size: 20, putCompletedAt: '2026-10-01T00:00:00.000Z'}];
function seed(state: StateManager, userId = 'u', files = oldFiles) {
  state.recordFavoriteItem(userId, 1, 'Favorites', {bvid: 'BVPROOF', title: 'Fixture', upperName: 'UP'});
  state.markVerifiedUpload('BVPROOF', '/archive', structuredClone(files), userId, 1);
  return state.listRelationsForBvid('BVPROOF').find(relation => relation.userId === userId)!;
}

for (const outcome of [
  {kind: 'ok', remotePath: '/archive', files: oldFiles},
  {kind: 'missing', files: ['BVPROOF.mp4']},
  {kind: 'deferred', delayMs: 60_000, reason: 'external timeout'},
] satisfies RemoteCheckOutcome[]) {
  test(`remote ${outcome.kind} response cannot overwrite a newer upload at the same path`, async () => {
    const root = await createTestDir('remote-proof-race');
    const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
    try {
      const expected = captureRemoteCheckEvidence(seed(state));
      state.markVerifiedUpload('BVPROOF', '/archive', structuredClone(newFiles), 'u', 1);
      const current = structuredClone(state.listRelationsForBvid('BVPROOF'));
      assert.equal(state.commitRemoteCheck(expected, outcome), false);
      assert.deepEqual(state.listRelationsForBvid('BVPROOF'), current);
      assert.deepEqual(state.getVideoForLocalCleanup('BVPROOF')?.remoteFiles, newFiles);
    } finally {state.close(); await removeTestDir(root);}
  });
}

test('relation checks preserve canonical proof of another archive and accept harmless metadata updates', async () => {
  const root = await createTestDir('remote-proof-sharing');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  try {
    const expected = captureRemoteCheckEvidence(seed(state, 'first'));
    seed(state, 'second', newFiles);
    state.recordFavoriteItem('first', 1, 'Renamed favorites', {bvid: 'BVPROOF', title: 'Renamed', upperName: 'UP'});
    assert.equal(state.commitRemoteCheck(expected, {kind: 'ok', files: oldFiles, remotePath: '/archive'}), true);
    assert.deepEqual(state.getVideoForLocalCleanup('BVPROOF')?.remoteFiles, newFiles);
    assert.deepEqual(state.listRelationsForBvid('BVPROOF').find(relation => relation.userId === 'first')?.remoteFiles, oldFiles);
    assert.equal(state.getVideoMeta('BVPROOF')?.title, 'Renamed');
    assert.equal(state.commitRemoteCheck(expected, {kind: 'missing', files: ['BVPROOF.mp4']}), false);
    state.markQueued('BVPROOF', '/archive', 'second', 1);
    const current = captureRemoteCheckEvidence(state.listRelationsForBvid('BVPROOF').find(relation => relation.userId === 'first')!);
    assert.equal(state.commitRemoteCheck(current, {kind: 'ok', files: oldFiles, remotePath: '/archive'}), true);
    assert.equal(state.getVideoForLocalCleanup('BVPROOF')?.backupStatus, 'queued');
    assert.deepEqual(state.getVideoForLocalCleanup('BVPROOF')?.remoteFiles, newFiles);
  } finally {state.close(); await removeTestDir(root);}
});

test('remote check transaction failure rolls back durable and in-memory proof', async () => {
  const root = await createTestDir('remote-proof-transaction');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  try {
    const expected = captureRemoteCheckEvidence(seed(state));
    const before = structuredClone(state.listRelationsForBvid('BVPROOF'));
    state.getDatabase().db.exec("CREATE TRIGGER reject_remote_check BEFORE UPDATE ON favorite_relations BEGIN SELECT RAISE(ABORT, 'injected proof commit failure'); END");
    assert.throws(() => state.commitRemoteCheck(expected, {kind: 'deferred', delayMs: 60_000, reason: 'timeout'}), /proof commit failure/);
    assert.deepEqual(state.listRelationsForBvid('BVPROOF'), before);
    state.getDatabase().db.exec('DROP TRIGGER reject_remote_check');
    assert.equal(state.commitRemoteCheck(expected, {kind: 'deferred', delayMs: 60_000, reason: 'timeout'}), true);
  } finally {state.close(); await removeTestDir(root);}
});

for (const change of ['upload', 'detach', 'target', 'credentials', 'commit-failure'] as const) {
  test(`remote worker handles ${change} during external verification without stale writes or false success`, async () => {
    const root = await createTestDir('remote-worker-race');
    const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
    seed(state);
    let config = testConfig({remoteVerifyConcurrency: 1});
    let resolve!: (value: Awaited<ReturnType<typeof verifyRemoteFiles>>) => void;
    let started!: () => void;
    const entered = new Promise<void>(done => {started = done;});
    let writes = 0;
    const scan = createRemoteScan({config: {get: () => config},
      state: {listVideosForRemoteVerify: (...args) => state.listVideosForRemoteVerify(...args),
        countVideosForRemoteVerify: (...args) => state.countVideosForRemoteVerify(...args),
        listRelationsForBvid: bvid => state.listRelationsForBvid(bvid),
        commitRemoteCheck: (...args) => {const committed = state.commitRemoteCheck(...args); if (committed) writes++; return committed;}},
      io: {clearPathReservations() {}, list: async () => [], waitForSlot: async () => {}},
      random: () => 0, sleep: async () => {}, generation: () => 0, canContinue: () => true,
      verify: () => new Promise(done => {resolve = done; started();}), resolve: () => null, bestRelation: () => null,
      remotePath: () => '/archive', enqueue: () => {throw new Error('unexpected requeue');}, progress() {},
    });
    try {
      const pending = scan.run(false, true, {trigger: 'auto', title: 'Auto', newItems: 0});
      await entered;
      if (change === 'upload') state.markVerifiedUpload('BVPROOF', '/archive', structuredClone(newFiles), 'u', 1);
      if (change === 'detach') state.detachUserRelations('u');
      if (change === 'target') config = {...config, alistUrl: 'http://changed.invalid'};
      if (change === 'credentials') config = {...config, alistPassword: 'different-fixture-password'};
      if (change === 'commit-failure') state.getDatabase().db.exec("CREATE TRIGGER reject_remote_check BEFORE UPDATE ON favorite_relations BEGIN SELECT RAISE(ABORT, 'injected worker commit failure'); END");
      resolve(verified);
      if (change === 'commit-failure') {
        await assert.rejects(pending, /worker commit failure/);
        state.getDatabase().db.exec('DROP TRIGGER reject_remote_check');
      } else {
        const stats = await pending;
        assert.equal(stats.remoteOk, 0);
        assert.equal(stats.remoteErrors, 0);
      }
      assert.equal(writes, 0);
    } finally {state.close(); await removeTestDir(root);}
  });
}
