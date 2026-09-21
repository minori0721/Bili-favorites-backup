import {relationFor} from './fixtures/state-observation.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createQualityStartupRecovery, type QualityStartupRecoveryDependencies } from '../src/scheduler/quality-startup-recovery.js';
import { createStartupLifecycle } from '../src/startup-lifecycle.js';
import { StateManager, type RemoteFileRecord } from '../src/state.js';
import { createTestDir, removeTestDir, testConfig } from './helpers.js';

async function fixture() {
  const root = await createTestDir('quality-startup');
  const state = new StateManager({ dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'missing.json') });
  const oldFile: RemoteFileRecord = { name: 'old.mp4', path: '/archive/old.mp4', size: 10, verificationStatus: 'verified' as const };
  const newFile: RemoteFileRecord = { name: 'new.mp4', path: '/archive/new.mp4', size: 20, verificationStatus: 'verified' as const };
  state.recordFavoriteItem('u', 1, 'folder', { bvid: 'BVRECOVERY', title: 'test', upperName: 'test' });
  state.markQualityUpgradeReplacing('BVRECOVERY', 'u', 1, {
    stageRemotePath: '/archive/.stage', backupRemotePath: '/archive/.backup', oldRemotePath: '/archive', oldFiles: [oldFile],
  });
  state.recordQualityUpgradeBackupFile('BVRECOVERY', 'u', 1, { ...oldFile, path: '/archive/.backup/old.mp4' });
  state.recordQualityUpgradeFinalFile('BVRECOVERY', 'u', 1, newFile);
  const calls: string[] = [];
  const dependencies: QualityStartupRecoveryDependencies = {
    state, config: { get: () => testConfig() }, now: () => 1_700_000_000_000,
    remove: async (_config, files) => { calls.push('remove:' + files.map(file => file.path).join(',')); return { success: files.length, failed: 0, results: [] }; },
    replacement: async () => async (_config, source, destination) => { calls.push(`replace:${source}->${destination}`); },
    log: entry => { calls.push('log:' + entry.level); },
  };
  return { state, dependencies, calls, newFile, close: async () => { state.close(); await removeTestDir(root); } };
}

test('quality startup compensates new files before restoring backups and committing retry state', async () => {
  const f = await fixture();
  try {
    await createQualityStartupRecovery(f.dependencies).recover();
    assert.deepEqual(f.calls, [
      'replace:/archive/new.mp4->/archive/.stage/new.mp4',
      'replace:/archive/.backup/old.mp4->/archive/old.mp4',
      'remove:/archive/.stage/old.mp4,/archive/.stage/new.mp4', 'log:warn',
    ]);
    assert.equal(f.state.getQualityUpgradeOperation('u', 1, 'BVRECOVERY'), null);
    const count = f.calls.length;
    await createQualityStartupRecovery(f.dependencies).recover();
    assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});

test('quality recovery partial cleanup failure retains evidence and prevents scheduling', async () => {
  const f = await fixture();
  try {
    f.state.finalizeQualityUpgradeRemoteFiles('BVRECOVERY', 'u', 1, '/archive', [f.newFile]);
    f.dependencies.remove = async () => ({ success: 0, failed: 1, results: [{ path: '/archive/.backup/old.mp4', ok: false }] });
    let scheduled = false;
    const startup = createStartupLifecycle([
      { name: 'quality', run: () => createQualityStartupRecovery(f.dependencies).recover() },
      { name: 'scheduler', run: () => { scheduled = true; } },
    ]);
    await assert.rejects(startup.start(), /Failed to clean/);
    assert.equal(scheduled, false);
    assert.ok(f.state.getQualityUpgradeOperation('u', 1, 'BVRECOVERY')?.finalizedAt);
    assert.deepEqual(startup.outcomes(), [{ name: 'quality', status: 'failed' as const }]);
    assert.deepEqual(f.calls, ['log:error']);
  } finally { await f.close(); }
});

test('remote replacement failure propagates without cleanup or state commit', async () => {
  const f = await fixture();
  try {
    const failure = new Error('remote timeout');
    f.dependencies.replacement = async () => async () => { throw failure; };
    await assert.rejects(createQualityStartupRecovery(f.dependencies).recover(), error => error === failure);
    assert.ok(f.state.getQualityUpgradeOperation('u', 1, 'BVRECOVERY'));
    assert.deepEqual(f.calls, ['log:error']);
  } finally { await f.close(); }
});

test('finalized recovery removes backups then publishes the verified archive exactly once', async () => {
  const f = await fixture();
  try {
    f.state.finalizeQualityUpgradeRemoteFiles('BVRECOVERY', 'u', 1, '/archive', [f.newFile]);
    await createQualityStartupRecovery(f.dependencies).recover();
    assert.deepEqual(f.calls, ['remove:/archive/.backup/old.mp4']);
    assert.equal(f.state.getQualityUpgradeOperation('u', 1, 'BVRECOVERY'), null);
    assert.equal(relationFor(f.state, 'u', 1, 'BVRECOVERY')?.backupStatus, 'verified');
  } finally { await f.close(); }
});
