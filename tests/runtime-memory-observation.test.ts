import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeMemoryObservation } from '../src/runtime-memory-observation.js';
import { ManualTime } from './fixtures/manual-time.js';
import { Task, TaskQueue } from '../src/queue.js';

const mib = 1024 * 1024;
const resources = () => ({
  stateCache: { videos: 2, relations: 3 },
  folders: { entries: 4, requests: 1, generations: 2 },
  covers: { entries: 5, requests: 2, promotions: 1, waitingFetches: 3 },
  logs: 10,
  queues: { download: 1, upload: 2, verification: 3 },
});

test('memory snapshots record a baseline and five-minute trends with idempotent lifecycle', () => {
  const time = new ManualTime();
  const messages: string[] = [];
  let heap = 40 * mib;
  let samples = 0;
  const observer = createRuntimeMemoryObservation({
    resources,
    memory: () => {
      samples++;
      return { rss: 100 * mib, heapUsed: heap, heapTotal: 60 * mib, external: 10 * mib, arrayBuffers: 5 * mib };
    },
    schedule: time.schedule,
    emit: (_level, message) => { messages.push(message); },
  });
  observer.start();
  observer.start();
  assert.equal(time.pending, 1);
  assert.equal(samples, 1);
  assert.match(messages[0], /rss_mib=100\.0 heap_used_mib=40\.0 heap_total_mib=60\.0 external_mib=10\.0 array_buffers_mib=5\.0 heap_delta_mib=0\.0/);
  assert.match(messages[0], /state_videos=2 state_relations=3 folder_entries=4 folder_requests=1/);
  assert.match(messages[0], /log_entries=10 download_tasks=1 upload_tasks=2 verification_tasks=3/);
  time.advance(299_999);
  assert.equal(samples, 1);
  heap = 45 * mib;
  time.advance(1);
  assert.equal(samples, 2);
  assert.match(messages[1], /heap_delta_mib=5\.0/);
  heap = 38 * mib;
  time.advance(300_000);
  assert.match(messages[2], /heap_delta_mib=-7\.0/);
  observer.stop();
  observer.stop();
  assert.equal(time.pending, 0);
  time.advance(600_000);
  assert.equal(samples, 3);
  observer.start();
  assert.match(messages[3], /heap_delta_mib=0\.0/);
  observer.stop();
});

test('memory sampling rejects callbacks delivered after stop or restart', () => {
  const callbacks: Array<() => void> = [];
  let samples = 0;
  const observer = createRuntimeMemoryObservation({
    resources,
    memory: () => { samples++; return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 }; },
    schedule: (callback, delay, recurring) => {
      assert.equal(delay, 300_000);
      assert.equal(recurring, true);
      callbacks.push(callback);
      return () => {};
    },
    emit() {},
  });
  observer.start();
  observer.stop();
  callbacks[0]();
  assert.equal(samples, 1);
  observer.start();
  callbacks[0]();
  assert.equal(samples, 2);
  callbacks[1]();
  assert.equal(samples, 3);
  observer.stop();
});

test('failed memory or resource sampling is observable, redacted and retried next interval', () => {
  for (const failedSource of ['memory', 'resources'] as const) {
    const time = new ManualTime();
    const messages: Array<{ level: string; message: string }> = [];
    let failed = true;
    const observer = createRuntimeMemoryObservation({
      resources: () => {
        if (failed && failedSource === 'resources') throw new Error('counter unavailable Cookie: private-cookie');
        return resources();
      },
      memory: () => {
        if (failed && failedSource === 'memory') throw new Error('memory unavailable access_token=private-token');
        return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };
      },
      schedule: time.schedule,
      emit: (level, message) => { messages.push({ level, message }); },
    });
    assert.doesNotThrow(() => observer.start());
    assert.equal(time.pending, 1);
    assert.equal(messages[0].level, 'warn');
    assert.match(messages[0].message, /memory sampling failed/);
    assert.doesNotMatch(messages[0].message, /private-cookie|private-token/);
    failed = false;
    time.advance(300_000);
    assert.equal(messages[1].level, 'info');
    observer.stop();
  }
});

test('queue resource counting observes pending tasks without starting or materializing them', () => {
  let runs = 0;
  class PendingTask extends Task {
    async run() { runs++; }
  }
  const queue = new TaskQueue(1);
  queue.setStartGate(() => false);
  const task = new PendingTask('fixture');
  queue.addTask(task);
  assert.equal(queue.getTaskCount(), 1);
  assert.equal(queue.getTaskCount(), 1);
  assert.equal(runs, 0);
  assert.equal(task.status, 'pending');
  queue.removePendingTasks(() => true);
  assert.equal(queue.getTaskCount(), 0);
});
