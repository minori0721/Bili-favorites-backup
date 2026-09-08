import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRemoteScan } from '../../src/scheduler/remote-scan.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import type { verifyRemoteFiles } from '../../src/uploader.js';

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
      const video = state.getDatabase().getVideo(bvid);
      const relation = state.listRelationsForBvid(bvid)[0];
      assert.ok(video && relation);
      return { ...video, relation: { ...relation, remotePath: '/archive', remoteFiles: [{ name: bvid + '.mp4', path: '/archive/' + bvid + '.mp4' }] } };
    });
    let generation = 0, writes = 0;
    const resolves: Array<(value: Awaited<ReturnType<typeof verifyRemoteFiles>>) => void> = [];
    const scan = createRemoteScan({ config: { get: () => testConfig({ remoteVerifyConcurrency: 2 }) },
      state: {
        listVideosForRemoteVerify: () => candidates, countVideosForRemoteVerify: () => count,
        listRelationsForBvid: bvid => state.listRelationsForBvid(bvid),
        markRemoteCheckOk: (...args) => { writes++; return state.markRemoteCheckOk(...args); },
        markRemoteCheckDeferred: (...args) => { writes++; return state.markRemoteCheckDeferred(...args); },
        markRemoteCheckMissing: (...args) => { writes++; return state.markRemoteCheckMissing(...args); },
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
