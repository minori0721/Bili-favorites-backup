import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurationObservation } from '../src/performance-observation.js';

test('duration observations summarize normal calls and rate-limit slow warnings', () => {
  let now = 0;
  const messages: Array<{ level: 'info' | 'warn'; message: string }> = [];
  const observation = createDurationObservation('cache_inspection', {
    slowMs: 1_000,
    windowMs: 300_000,
    now: () => now,
    emit: (level, message) => { messages.push({ level, message }); },
  });

  observation.record(20, 'ok', { files: 2, bytes: 10 });
  assert.deepEqual(messages, []);
  now = 10;
  observation.record(1_100, 'ok', { files: 3, bytes: 20 });
  now = 20;
  observation.record(1_200, 'error');
  assert.deepEqual(messages, [{
    level: 'warn',
    message: '[Perf] cache_inspection slow duration_ms=1100 threshold_ms=1000 result=ok files=3 bytes=20',
  }]);

  now = 300_000;
  observation.record(40, 'ok');
  assert.deepEqual(messages[1], {
    level: 'info',
    message: '[Perf] cache_inspection count=3 errors=1 slow=2 avg_ms=773 max_ms=1200 window_ms=300000',
  });
  assert.equal(messages.length, 2);

  observation.record(1_001, 'ok');
  assert.deepEqual(messages[2], {
    level: 'warn',
    message: '[Perf] cache_inspection slow duration_ms=1001 threshold_ms=1000 result=ok',
  });
});
