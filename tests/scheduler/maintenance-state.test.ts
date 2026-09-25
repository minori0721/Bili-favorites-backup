import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceAdmission } from '../../src/scheduler/maintenance-admission.js';
import { createMaintenanceState } from '../../src/scheduler/maintenance-state.js';

test('maintenance state does not create a second lease when the same operation is reported twice', () => {
  const admission = createMaintenanceAdmission();
  const state = createMaintenanceState(admission);
  state.setPath(true, { id: 'migration-1', status: 'running', sourceRoot: '/a', destinationRoot: '/b' });
  const first = [...admission.snapshot().values()][0];
  state.setPath(true, { id: 'migration-1', status: 'running', sourceRoot: '/a', destinationRoot: '/b' });
  const second = [...admission.snapshot().values()][0];
  assert.equal(admission.snapshot().size, 1);
  assert.equal(second.token, first.token);
  assert.equal(state.getPath()?.id, 'migration-1');
});

test('a stale completion cannot clear the current maintenance summary', () => {
  const admission = createMaintenanceAdmission();
  const state = createMaintenanceState(admission);
  state.setPath(true, { id: 'migration-1', status: 'running', sourceRoot: '/a', destinationRoot: '/b' });
  state.setPath(true, { id: 'migration-2', status: 'running', sourceRoot: '/c', destinationRoot: '/d' });
  state.setPath(false, { id: 'migration-1' });
  assert.equal(state.pathLocked(), true);
  assert.equal(state.getPath()?.id, 'migration-2');
  state.setPath(false, { id: 'migration-2' });
  assert.equal(state.pathLocked(), false);
  assert.equal(state.getPath(), null);
});

test('source deletion clears its summary without an account-wide lease', () => {
  const admission = createMaintenanceAdmission();
  const state = createMaintenanceState(admission);
  const source = {
    id: 'source-1', status: 'running', scope: 'source',
    userId: 'u1', mediaId: 1, bvid: 'BVSOURCE',
  };
  state.setArchive(true, source);
  assert.equal(state.archiveLocked(), false);
  assert.deepEqual(state.getArchive(), source);

  assert.equal(state.setArchive(false, { id: source.id, status: 'running', scope: 'account' }), true);
  assert.equal(state.getArchive(), null);
  assert.equal(admission.snapshot().size, 0);
  assert.equal(state.setArchive(false, { id: source.id, status: 'running', scope: 'account' }), false);
});

test('an old source completion cannot clear a newer archive deletion', () => {
  const admission = createMaintenanceAdmission();
  const state = createMaintenanceState(admission);
  state.setArchive(true, { id: 'source-1', status: 'running', scope: 'source' });
  state.setArchive(true, { id: 'source-2', status: 'running', scope: 'source' });
  assert.equal(state.setArchive(false, { id: 'source-1', status: 'running', scope: 'account' }), false);
  assert.equal(state.getArchive()?.id, 'source-2');
  assert.equal(state.setArchive(false, { id: 'source-2', status: 'running', scope: 'account' }), true);
  assert.equal(state.getArchive(), null);
});

test('archive handoff changes the account-wide lease with the operation scope', () => {
  const admission = createMaintenanceAdmission();
  const state = createMaintenanceState(admission);
  state.setArchive(true, { id: 'account-1', status: 'running', scope: 'account' });
  assert.equal(state.archiveLocked(), true);

  state.setArchive(true, { id: 'source-1', status: 'running', scope: 'source' });
  assert.equal(state.archiveLocked(), false);
  assert.equal(state.getArchive()?.id, 'source-1');
  assert.equal(state.setArchive(false, { id: 'account-1', status: 'running', scope: 'account' }), false);
  assert.equal(state.getArchive()?.id, 'source-1');

  state.setArchive(true, { id: 'account-2', status: 'running', scope: 'account' });
  const currentLease = [...admission.snapshot().values()][0];
  assert.equal(currentLease.id, 'account-2');
  assert.equal(state.archiveLocked(), true);
  assert.equal(state.setArchive(false, { id: 'source-1', status: 'running', scope: 'source' }), false);
  assert.equal(state.archiveLocked(), true);
  assert.equal(state.setArchive(false, { id: 'account-2', status: 'running', scope: 'account' }), true);
  assert.equal(state.archiveLocked(), false);
  assert.equal(state.getArchive(), null);
});
