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
