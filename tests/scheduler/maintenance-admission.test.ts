import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceAdmission } from '../../src/scheduler/maintenance-admission.js';

test('maintenance leases are identity based and stale releases cannot unlock a newer operation', () => {
  const admission = createMaintenanceAdmission();
  const first = admission.enter('path_migration', 'migration-1');
  assert.equal(admission.isLocked('path_migration'), true);
  const second = admission.enter('path_migration', 'migration-2');
  assert.notEqual(first.token, second.token);
  assert.equal(admission.leave(first), false);
  assert.equal(admission.isLocked('path_migration'), true);
  assert.equal(admission.leaveById('path_migration', 'migration-1'), false);
  assert.equal(admission.leaveById('path_migration', 'migration-2'), true);
  assert.equal(admission.isLocked('path_migration'), false);
  assert.equal(admission.leave(second), true);
});
