import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeQualityProofFiles,
  qualityTargetsFromPayload,
  resolveQualityUpgradeTarget,
} from '../../src/scheduler/quality-rules.js';

test('quality target projection deduplicates by account and archive source', () => {
  const targets = qualityTargetsFromPayload({
    targets: [
      { userId: 'u1', mediaId: 1, folderTitle: 'A', remotePath: '/a', oldFiles: [] },
      { userId: 'u1', mediaId: 1, folderTitle: 'new', remotePath: '/new', oldFiles: [] },
      { userId: 'u2', mediaId: 2, folderTitle: 'B', remotePath: '/b', oldFiles: [] },
    ],
  });
  assert.deepEqual(targets.map(target => target.remotePath), ['/new', '/b']);
  assert.equal(resolveQualityUpgradeTarget({ kind: 'quality_replace', userId: 'u1', mediaId: 1 }, {}, targets)?.remotePath, '/new');
  assert.equal(resolveQualityUpgradeTarget({ kind: 'quality_download', userId: undefined, mediaId: undefined }, { target: { userId: 'u2', mediaId: 2 } }, targets)?.remotePath, '/b');
});

test('quality proof files prefer the persisted relation and otherwise merge payload files', () => {
  const relation = [{ name: 'new.mp4', path: '/new', verificationStatus: 'verified' as const }];
  assert.deepEqual(mergeQualityProofFiles([{ name: 'old.mp4', path: '/old' }], relation), relation);
  assert.deepEqual(mergeQualityProofFiles([
    { name: 'old.mp4', path: '/old' },
    { name: 'old.mp4', path: '/replaced' },
  ], undefined), [{ name: 'old.mp4', path: '/replaced' }]);
});
