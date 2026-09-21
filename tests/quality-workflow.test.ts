import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualityWorkflow } from '../src/scheduler/quality-workflow.js';
import { QualityUpgradeTask } from '../src/tasks.js';
import { testConfig } from './helpers.js';

test('quality workflow keeps cleanup ownership visible while stopped and waits for release', async () => {
  const workflow = createQualityWorkflow();
  let now = 0;
  let mergeCalls = 0;
  workflow.configure({
    jobs: {
      hasQualityTarget: () => false,
      mergeQualityDownload: () => {
        mergeCalls += 1;
        throw new Error('a stopped workflow must not persist new quality work');
      },
    },
    configStore: { get: () => testConfig() },
    downloadQueue: { getTasks: () => [] },
    onApiReady: () => undefined,
    dispatch: () => undefined,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });

  workflow.acquireCleanupLock('artifact');
  workflow.stop();
  assert.equal(workflow.isIdle(), false);
  assert.equal(await workflow.waitForIdle(20), false);

  const task = new QualityUpgradeTask(
    'BVQUALITYLIFECYCLE',
    { SESSDATA: 'test', bili_jct: 'test', DedeUserID: '1' },
    testConfig(),
    { userId: 'u1', mediaId: 1, folderTitle: 'Favorites', remotePath: '/backup/u1/1', oldFiles: [] },
  );
  assert.equal(workflow.enqueue(task), false);
  assert.equal(mergeCalls, 0);

  workflow.releaseCleanupLock('artifact');
  assert.equal(await workflow.waitForIdle(20), true);
  assert.equal(workflow.isIdle(), true);
});
