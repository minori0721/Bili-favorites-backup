import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogEntry } from '../../src/logger.js';
import { createCycleLogger } from '../../src/scheduler/cycle-logger.js';
import type { SyncCycleStats } from '../../src/scheduler/sync-runtime.js';

function cycle(overrides: Partial<SyncCycleStats> = {}): SyncCycleStats {
  return {
    trigger: 'auto',
    startedAt: new Date(1_000).toISOString(),
    newItems: 0,
    queuedItems: 0,
    remoteEligible: 2,
    remoteChecked: 2,
    remoteOk: 2,
    remoteMissingDetected: 0,
    remoteMissingUnavailable: 0,
    requeuedFromRemoteMissing: 0,
    remoteErrors: 0,
    ...overrides,
  };
}

test('cycle logger preserves no-new, reconcile and error summaries', () => {
  const entries: LogEntry[] = [];
  const logger = createCycleLogger({ now: () => 3_000, push: entry => { entries.push(entry); } });
  logger.log(cycle());
  logger.log(cycle({ trigger: 'remote_reconcile', newItems: 1, queuedItems: 1, remoteMissingDetected: 1 }));
  logger.log(cycle({ trigger: 'manual', error: 'remote unavailable' }));

  assert.equal(entries.length, 3);
  assert.match(entries[0].summary, /no new videos/);
  assert.match(entries[1].summary, /remote_reconcile done/);
  assert.equal(entries[2].level, 'error');
  assert.match(entries[2].summary, /remote unavailable/);
  assert.ok(entries.every(entry => entry.simpleVisible));
});
