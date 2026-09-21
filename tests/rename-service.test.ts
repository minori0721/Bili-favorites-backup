import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLoadedConfig } from '../src/config.js';
import { createRenameService } from '../src/rename-service.js';
import type { batchRenameRemotePaths } from '../src/uploader.js';

function fixture() {
  let config = normalizeLoadedConfig({alistDest: '/backup', filenameTemplate: '<videoTitle>-<bvid>'});
  let blocked = false;
  let scans = 0;
  let executions = 0;
  let finish: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const updates: Array<{bvid: string; paths: Array<{oldPath: string; newPath: string}>}> = [];
  const rename: typeof batchRenameRemotePaths = async (_config, items) => {
    executions++;
    await barrier;
    return {success: 0, failed: items.length, results: items.map(item => ({
      oldPath: item.oldPath, newPath: item.newPath, actualPath: '/backup/recovery-BVTEST.mp4',
      observedPaths: ['/backup/recovery-BVTEST.mp4'], ok: false, status: 'stranded' as const, error: 'partial MOVE',
    }))};
  };
  const service = createRenameService({
    config: () => config, hasUnfinishedDeletion: () => blocked,
    state: {getRemoteFilePreviewRecords: () => [{bvid: 'BVTEST', title: 'New', upperName: 'UP', relations: [],
      remoteFiles: [{name: 'old-BVTEST.mp4', path: '/backup/old-BVTEST.mp4', size: 10, verificationStatus: 'verified' as const}]}],
      renameRemoteFilesBatch(bvid, paths) { updates.push({bvid, paths}); return true; }},
    scan: async () => { scans++; return {files: [], skipped: [], skippedTotal: 0, skippedByReason: {}, complete: false, scannedEntries: 0, scannedDirectories: 0}; },
    rename,
  });
  return {service, updates, scans: () => scans, executions: () => executions,
    finish: () => { assert.ok(finish); finish(); },
    block: () => { blocked = true; }, changeConfig: () => { config = {...config, alistDest: '/different'}; service.invalidateConfig(config); }};
}
async function preview(service: ReturnType<typeof createRenameService>) {
  const result = await service.preview({});
  assert.equal(result.status, 200);
  assert.ok(result.body.data);
  assert.equal(result.body.data.candidates.length, 1);
  return result.body.data;
}

test('rename service coalesces scans and executes candidate IDs once, preserving partial remote outcomes', async () => {
  const f = fixture();
  const first = await preview(f.service);
  const second = await preview(f.service);
  assert.equal(first.previewId, second.previewId);
  assert.equal(f.scans(), 1);
  assert.equal('sourceAccessPath' in first.candidates[0], false);
  const input = {previewId: first.previewId, candidateIds: first.candidates.map(item => item.candidateId)};
  const pending = f.service.execute(input);
  assert.equal((await f.service.execute(input)).status, 202);
  f.finish();
  const complete = await pending;
  assert.deepEqual(await f.service.execute(input), complete);
  assert.equal(f.executions(), 1);
  assert.deepEqual(f.updates, [{bvid: 'BVTEST', paths: [{oldPath: '/backup/old-BVTEST.mp4', newPath: '/backup/recovery-BVTEST.mp4'}]}]);
  assert.equal(await f.service.stop(100), true);
  f.service.clear();
});

test('rename service rejects obsolete config and deletion maintenance before remote mutation', async () => {
  const f = fixture();
  const initial = await preview(f.service);
  assert.equal((await f.service.status({previewId: initial.previewId, sinceRevision: -1})).status, 400);
  f.changeConfig();
  assert.equal((await f.service.status({previewId: initial.previewId})).status, 409);
  assert.equal((await f.service.execute({previewId: initial.previewId, candidateIds: [initial.candidates[0].candidateId]})).status, 409);
  f.block();
  assert.equal((await f.service.preview({})).status, 409);
  assert.equal((await f.service.execute({})).status, 409);
  assert.equal(f.executions(), 0);
  assert.equal(f.scans(), 1);
  await f.service.stop(100);
  f.service.clear();
});
