import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskQueue } from '../../src/queue.js';
import { createRuntimeConfigController } from '../../src/scheduler/runtime-config.js';
import { testConfig } from '../helpers.js';

class RecordingQueue extends TaskQueue {
  concurrencyValues: number[] = [];
  maxSizeValues: number[] = [];

  override setConcurrency(value: number) {
    this.concurrencyValues.push(value);
    super.setConcurrency(value);
  }

  override setMaxSize(value: number) {
    this.maxSizeValues.push(value);
    super.setMaxSize(value);
  }
}

test('runtime config applies queue limits and observable adapter resets once', () => {
  const calls: string[] = [];
  const download = new RecordingQueue();
  const upload = new RecordingQueue();
  const verification = new RecordingQueue();
  const previous = testConfig();
  const next = {
    ...previous,
    alistUrl: `${previous.alistUrl}/changed`,
    bbdownApiMode: 'app' as const,
    concurrentDownloads: 3,
    concurrentUploads: 4,
    remoteVerifyConcurrency: 20,
    queuePrefetchLimit: 7,
  };
  let current = next;
  const controller = createRuntimeConfigController({
    isShuttingDown: () => false,
    config: () => current,
    clearRemoteListings: () => { calls.push('remote'); },
    clearDownloadApiCooldown: () => { calls.push('cooldown'); },
    downloadAdmission: { configure: mode => { calls.push(`mode:${mode}`); } },
    downloadQueue: download,
    uploadQueue: upload,
    verificationQueue: verification,
    localCapacity: { refreshAndWake: force => { calls.push(`capacity:${force}`); } },
    dispatchPersistentJobs: () => { calls.push('dispatch'); },
    queueHighWater: (concurrency = 1, prefetch = 25) => Math.max(concurrency * 2, prefetch),
    start: () => true,
  });

  controller.applyConfigUpdate(previous, next);
  assert.deepEqual(download.concurrencyValues, [3]);
  assert.deepEqual(upload.concurrencyValues, [4]);
  assert.deepEqual(verification.concurrencyValues, [10]);
  assert.deepEqual(download.maxSizeValues, [7]);
  assert.deepEqual(upload.maxSizeValues, [8]);
  assert.deepEqual(verification.maxSizeValues, [20]);
  assert.deepEqual(calls.slice(0, 3), ['remote', 'mode:app', 'cooldown']);
  assert.equal(calls.filter(call => call === 'dispatch').length, 1);

  current = { ...next, concurrentDownloads: 1 };
  controller.updateInterval();
  assert.equal(download.concurrencyValues.at(-1), 1);
});

test('runtime config ignores changes after shutdown begins', () => {
  const queue = new RecordingQueue();
  let configured = false;
  const config = testConfig();
  const controller = createRuntimeConfigController({
    isShuttingDown: () => true,
    config: () => config,
    clearRemoteListings: () => { configured = true; },
    clearDownloadApiCooldown: () => { configured = true; },
    downloadAdmission: { configure: () => { configured = true; } },
    downloadQueue: queue,
    uploadQueue: queue,
    verificationQueue: queue,
    localCapacity: { refreshAndWake: () => { configured = true; } },
    dispatchPersistentJobs: () => { configured = true; },
    queueHighWater: () => 5,
    start: () => true,
  });

  controller.applyConfigUpdate(config, config);
  controller.updateInterval();
  assert.equal(configured, false);
  assert.deepEqual(queue.concurrencyValues, []);
});
