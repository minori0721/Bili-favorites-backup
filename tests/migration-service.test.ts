import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ImportMaintenance } from '../src/import-maintenance.js';
import { createMigrationService } from '../src/migration-service.js';
import type { MigrationManifest } from '../src/migration.js';

const manifest: MigrationManifest = {
  schema: 3, app: 'Bili-favorites-backup', version: 'test', exportedAt: '2026-01-01T00:00:00Z', mode: 'lightweight' as const,
  includes: { mode: 'lightweight' as const, includeConfig: true, includeUsers: true, includeState: true, includeLogs: false, includeDebug: false, includeCovers: true },
  counts: { users: 0, videos: 0, relations: 0, unavailableVideos: 0 }, warning: '',
};
async function* archive() { yield Buffer.from('isolated test archive'); }

function fixture() {
  const maintenance = new ImportMaintenance();
  const calls: string[] = [];
  const state = { busy: false, changedDuringPreview: false, needsRecovery: false, recoveryFails: false, coversIdle: true, upload: '' };
  const service = createMigrationService({
    scheduler: {
      hasRunningTransferTasks: () => state.busy, hasActiveOrQueuedSchedulerWork: () => false, hasPersistentTransferWork: () => false,
      async withCleanupLock(work) { calls.push('lock'); try { return await work(); } finally { calls.push('unlock'); } },
      captureLegacyRecoveryMarkers: () => ({ quality: null, temp: null }),
      beginShutdown() { calls.push('shutdown'); },
    },
    pathMigration: {
      isBusy: () => false, waitForIdle: async () => true,
      tryAcquireLifecycleBarrier() { calls.push('barrier'); return true; }, releaseLifecycleBarrier() { calls.push('release-barrier'); },
    },
    archiveDeletion: { hasUnfinishedOperation: () => false, setImportMaintenance(value) { calls.push(`deletion:${value}`); } },
    importMaintenance: maintenance, mediaProbe: { isBusy: () => false },
    unavailableCoverBackfill: { stop: async () => state.coversIdle, restart() { calls.push('restart-covers'); } },
    waitForRenamePreviewIdle: async () => true, waitForCoverCacheIdle: async () => state.coversIdle,
    activePathMigration: () => undefined, clearCoverBackfillMarker() { calls.push('clear-marker'); }, async reload(restored) {
      calls.push('reload');
      assert.deepEqual(restored, ['state']);
      calls.push('recovery');
      if (state.recoveryFails) throw Object.assign(new Error('post-import recovery failed'), { recoveryRequired: true });
    },
    resume() { calls.push('resume'); },
    exportArchive: async () => ({ outputPath: 'isolated.zip', manifest }),
    estimate: async () => ({ mode: 'lightweight' as const, files: 0, expandedBytes: 0, resumableItems: 0, retainedBytes: 0, pendingUploadItems: 0 }),
    preview: async file => {
      state.upload = file;
      assert.equal(fs.readFileSync(file, 'utf8'), 'isolated test archive');
      if (state.changedDuringPreview) state.busy = true;
      return { manifest, files: [], expandedBytes: 0, conflicts: { tempItems: [], tempItemCount: 0 } };
    },
    apply: async (_file, options) => {
      calls.push('apply');
      if (state.needsRecovery) throw Object.assign(Error('rollback proof missing'), { recoveryRequired: true });
      await options?.reload?.(['state']);
      calls.push('commit');
      await options?.resume?.();
      return { manifest, backupPath: 'isolated-backup', restored: ['state'] };
    },
  });
  return { service, maintenance, state, calls };
}

test('migration checks again after preview before applying any data', async () => {
  const f = fixture(); f.state.changedDuringPreview = true;
  await assert.rejects(f.service.importArchive(archive(), {}), /状态已变化/);
  assert.ok(!f.calls.includes('apply'));
  assert.equal(f.maintenance.blocked, false);
  assert.equal(fs.existsSync(f.state.upload), false);
});

test('migration restores adapters inside barriers and releases temporary archive only after completion', async () => {
  const f = fixture();
  const result = await f.service.importArchive(archive(), {});
  assert.deepEqual(result.restored, ['state']);
  assert.deepEqual(f.calls, ['deletion:true', 'lock', 'barrier', 'apply', 'reload', 'recovery', 'commit', 'resume', 'release-barrier', 'unlock', 'clear-marker', 'deletion:false', 'restart-covers']);
  assert.equal(f.maintenance.blocked, false);
  assert.equal(fs.existsSync(f.state.upload), false);
});

test('post-import recovery failure keeps maintenance closed before adapters resume', async () => {
  const f = fixture(); f.state.recoveryFails = true;
  await assert.rejects(f.service.importArchive(archive(), {}), /post-import recovery failed/);
  assert.equal(f.maintenance.blocked, true);
  assert.ok(f.calls.indexOf('recovery') < f.calls.indexOf('release-barrier'));
  assert.ok(!f.calls.includes('commit'));
  assert.ok(!f.calls.includes('resume'));
  assert.ok(f.calls.includes('shutdown'));
  assert.ok(!f.calls.includes('deletion:false'));
  assert.ok(!f.calls.includes('restart-covers'));
});

test('missing rollback evidence holds maintenance and never restarts producers', async () => {
  const f = fixture(); f.state.needsRecovery = true;
  await assert.rejects(f.service.importArchive(archive(), {}), /rollback proof missing/);
  assert.equal(f.maintenance.blocked, true);
  assert.ok(f.calls.includes('shutdown'));
  assert.ok(!f.calls.includes('deletion:false'));
  assert.ok(!f.calls.includes('restart-covers'));
  assert.ok(!f.calls.includes('recovery'));
  assert.equal(fs.existsSync(f.state.upload), false);
});

test('cover drain failure rejects import before obtaining the database replacement barrier', async () => {
  const f = fixture(); f.state.coversIdle = false;
  await assert.rejects(f.service.importArchive(archive(), {}), /安全期限/);
  assert.ok(!f.calls.includes('barrier'));
  assert.ok(!f.calls.includes('apply'));
  assert.equal(f.maintenance.blocked, false);
  assert.equal(fs.existsSync(f.state.upload), false);
});
