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
