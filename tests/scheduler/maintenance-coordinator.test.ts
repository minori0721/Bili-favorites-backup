import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceCoordinator } from '../../src/scheduler/maintenance-coordinator.js';

test('cleanup maintenance releases its lease when work throws synchronously', async () => {
  let coordinator!: ReturnType<typeof createMaintenanceCoordinator>;
  coordinator = createMaintenanceCoordinator({
    canEnterCleanup: () => !coordinator.isAnyLocked(),
    wakeBlockedWork: () => undefined,
  });

  await assert.rejects(
    coordinator.withCleanupLease(() => { throw new Error('synchronous failure'); }),
    /synchronous failure/,
  );
  assert.equal(coordinator.isLocked('cleanup'), false);
  await coordinator.withCleanupLease(async () => undefined);
  assert.equal(coordinator.isLocked('cleanup'), false);
});

test('path and archive maintenance block cleanup until their matching release', async () => {
  let wakes = 0;
  let coordinator!: ReturnType<typeof createMaintenanceCoordinator>;
  coordinator = createMaintenanceCoordinator({
    canEnterCleanup: () => !coordinator.isAnyLocked(),
    wakeBlockedWork: () => { wakes += 1; },
  });

  coordinator.setPath(true, { id: 'migration-1' });
  assert.throws(() => coordinator.withCleanupLease(async () => undefined), /正在运行/);
  coordinator.setPath(false, { id: 'migration-1' });
  await coordinator.withCleanupLease(async () => undefined);

  coordinator.setArchive(true, { id: 'delete-1', scope: 'account' });
  assert.throws(() => coordinator.withCleanupLease(async () => undefined), /正在运行/);
  coordinator.setArchive(false, { id: 'delete-1', scope: 'account' });
  assert.equal(wakes, 2);
});

test('source deletion stops blocking its target and disappears from maintenance status on completion', () => {
  let wakes = 0;
  const coordinator = createMaintenanceCoordinator({
    canEnterCleanup: () => true,
    wakeBlockedWork: () => { wakes += 1; },
  });
  const source = {
    id: 'source-1', status: 'running', scope: 'source',
    userId: 'u1', mediaId: 1, bvid: 'BVSOURCE',
  };
  coordinator.setArchive(true, source);
  assert.equal(coordinator.archiveTargetMatches('u1', 1, 'BVSOURCE'), true);
  assert.equal(coordinator.snapshot()?.kind, 'archive_delete');

  coordinator.setArchive(false, { id: source.id });
  assert.equal(coordinator.archiveTargetMatches('u1', 1, 'BVSOURCE'), false);
  assert.equal(coordinator.snapshot(), undefined);
  assert.equal(wakes, 1);

  coordinator.setArchive(false, { id: source.id });
  assert.equal(wakes, 1);
});

test('archive handoff wakes work after the new narrower scope is installed', () => {
  const snapshots: Array<string | undefined> = [];
  let coordinator!: ReturnType<typeof createMaintenanceCoordinator>;
  coordinator = createMaintenanceCoordinator({
    canEnterCleanup: () => true,
    wakeBlockedWork: () => { snapshots.push(coordinator.snapshot()?.id); },
  });

  coordinator.setArchive(true, { id: 'account-1', scope: 'account' });
  coordinator.setArchive(true, { id: 'source-1', scope: 'source' });
  assert.deepEqual(snapshots, ['source-1']);
  coordinator.setArchive(false, { id: 'account-1' });
  assert.deepEqual(snapshots, ['source-1']);

  coordinator.setArchive(true, { id: 'source-2', scope: 'source' });
  assert.deepEqual(snapshots, ['source-1', 'source-2']);
  coordinator.setArchive(false, { id: 'source-2' });
  assert.deepEqual(snapshots, ['source-1', 'source-2', undefined]);
});
