import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadRecoveryTargets, parseLegacyDownloadFailureKey } from '../../src/scheduler/recovery-identifiers.js';

test('download recovery targets merge current and legacy identities without duplicates', () => {
  assert.deepEqual(downloadRecoveryTargets({
    userId: 'job-user',
    mediaId: 9,
    payload: {
      downloadRecovery: { targets: [{ userId: 'owner', mediaId: 1 }, { userId: 'owner', mediaId: 1 }] },
      detachedTargets: [{ userId: 'detached', mediaId: 2 }],
      primaryUserId: 'owner',
      primaryMediaId: 1,
    },
  }), [
    { userId: 'owner', mediaId: 1 },
    { userId: 'detached', mediaId: 2 },
    { userId: 'job-user', mediaId: 9 },
  ]);
});

test('legacy download failure keys preserve BVID colons and reject malformed identities', () => {
  assert.deepEqual(parseLegacyDownloadFailureKey('user:42:BV:with:colon'), {
    userId: 'user', mediaId: 42, bvid: 'BV:with:colon',
  });
  assert.equal(parseLegacyDownloadFailureKey('user:0:BV'), null);
  assert.equal(parseLegacyDownloadFailureKey('user:not-a-number:BV'), null);
  assert.equal(parseLegacyDownloadFailureKey('user:42:'), null);
});
