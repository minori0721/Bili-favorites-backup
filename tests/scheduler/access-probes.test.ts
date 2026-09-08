import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createAccessProbes } from '../../src/scheduler/access-probes.js';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { classifyVideoAccess, type VideoPageSnapshotResult } from '../../src/bili.js';
import type { BiliUser } from '../../src/users.js';
import { createTestDir, removeTestDir } from '../helpers.js';

for (const interruption of ['generation', 'maintenance', 'lease', 'attempt'] as const) {
  test(`probe leaves availability and scheduling unchanged after ${interruption} changes`, async () => {
    const runtime = await createTestDir('probe-late');
    const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
    const jobs = new PersistentJobStore(state.getDatabase());
    const user: BiliUser = { id: 'u', uid: 1, name: 'Fixture', favorites: [{ mediaId: 1, title: 'Favorites' }], enabled: true, lastLoginAt: '', cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };
    let generation = 0, active = true, queued = 0;
    let resolve!: (snapshot: VideoPageSnapshotResult) => void;
    const probes = createAccessProbes({ state, jobs, users: { list: () => [user] }, owner: 'fixture', now: Date.now, random: () => 0.5,
      generation: () => generation, canContinue: () => active, eligible: () => true,
      inspect: () => new Promise(done => { resolve = done; }), resolve: () => null, enqueue: () => { queued++; } });
    try {
      state.recordFavoriteItem('u', 1, 'Favorites', { bvid: 'BVPROBE', title: 'Fixture', upperName: 'UP', unavailable: true });
      state.markAvailabilityPending('BVPROBE', 'favorite_flag', new Date().toISOString());
      jobs.enqueue({ kind: 'access_probe', dedupeKey: 'probe:fixture', bvid: 'BVPROBE', payload: { intents: ['availability'] } });
      const [job] = jobs.claimDue(['access_probe'], 1, 'fixture', 300_000);
      assert.ok(job);
      const before = state.getSourceAvailability('BVPROBE');
      const work = probes.availability(job);
      if (interruption === 'generation') generation++;
      if (interruption === 'maintenance') active = false;
      if (interruption === 'lease') state.getDatabase().db.prepare('UPDATE jobs SET lease_owner=? WHERE id=?').run('new-owner', job.id);
      if (interruption === 'attempt') state.getDatabase().db.prepare('UPDATE jobs SET attempts=attempts+1 WHERE id=?').run(job.id);
      resolve({ available: false, availability: 'unavailable', availabilityReason: 'api_not_found', access: classifyVideoAccess(undefined), pages: [] });
      await assert.rejects(work, /lifecycle or lease change/);
      assert.deepEqual(state.getSourceAvailability('BVPROBE'), before);
      assert.ok(jobs.findById(job.id));
      assert.equal(queued, 0);
    } finally { state.close(); await removeTestDir(runtime); }
  });
}
