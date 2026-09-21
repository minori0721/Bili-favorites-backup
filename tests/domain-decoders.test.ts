import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PersistedDomainDecodeError,
  decodeDownloadApiCooldown,
  decodeFavoriteRelation,
  decodeQualityProfile,
  decodeUploadCooldown,
  decodeVideoPayload,
} from '../src/repositories/domain-decoders.js';

test('persisted video decoder rejects malformed records with field context', () => {
  assert.throws(
    () => decodeVideoPayload({ bvid: 'BV1', title: 'title', backupStatus: 'not-a-status', biliStatus: 'available' }, 'video BV1'),
    (error: unknown) => error instanceof PersistedDomainDecodeError
      && error.message.includes('video BV1')
      && error.message.includes('backupStatus'),
  );
});

test('persisted relation decoder distinguishes a missing required field from an empty relation', () => {
  assert.throws(
    () => decodeFavoriteRelation({ userId: 'u1', mediaId: 1, bvid: 'BV1', folderTitle: 'favorites', firstSeenAt: '2026-01-01' }, 'relation u1:1'),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('lastSeenAt'),
  );
});

test('persisted domain decoders reject malformed nested evidence and discard unknown fields', () => {
  const baseVideo = {
    bvid: 'BV1', title: 'title', upperName: 'upper', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-02',
    backupStatus: 'verified', biliStatus: 'available',
  };
  assert.throws(
    () => decodeVideoPayload({ ...baseVideo, remoteFiles: 'invalid' }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('remoteFiles'),
  );
  assert.throws(
    () => decodeVideoPayload({ ...baseVideo, downloadSession: 42 }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('downloadSession'),
  );
  const decoded = decodeVideoPayload({ ...baseVideo, untrustedFutureField: 'ignored' });
  assert.equal(Reflect.has(decoded, 'untrustedFutureField'), false);

  const baseRelation = {
    userId: 'u1', mediaId: 1, bvid: 'BV1', folderTitle: 'favorites', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-02',
  };
  assert.throws(
    () => decodeFavoriteRelation({ ...baseRelation, backupStatus: 'not-a-status' }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('backupStatus'),
  );
  assert.throws(
    () => decodeFavoriteRelation({ ...baseRelation, remoteFiles: 42 }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('remoteFiles'),
  );
});

test('legacy main download sessions are decoded as backup sessions', () => {
  const baseVideo = {
    bvid: 'BV1', title: 'title', upperName: 'upper', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-02',
    backupStatus: 'verified', biliStatus: 'available',
  };
  const decoded = decodeVideoPayload({
    ...baseVideo,
    downloadSession: {
      id: 'legacy', localDir: '/tmp/legacy', kind: 'main', status: 'partial',
      completedPages: 1, totalPages: 2, updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(decoded.downloadSession?.kind, 'backup');
});

test('legacy empty quality metadata is treated as unknown without weakening validation', () => {
  assert.equal(decodeQualityProfile({ quality: '', encoding: '', hiRes: false, dolby: false }), undefined);
  assert.equal(decodeQualityProfile({ quality: '4K', encoding: '', hiRes: false, dolby: false }), undefined);
  assert.deepEqual(decodeQualityProfile({ quality: '4K', encoding: 'HEVC', hiRes: false, dolby: true }), {
    quality: '4K', encoding: 'HEVC', hiRes: false, dolby: true,
  });

  assert.throws(
    () => decodeQualityProfile({ quality: '', encoding: '', hiRes: 'false' }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('hiRes'),
  );
  assert.throws(
    () => decodeQualityProfile({ quality: null, encoding: 'HEVC' }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('quality'),
  );
});

test('video payloads with legacy unknown quality remain readable', () => {
  const decoded = decodeVideoPayload({
    bvid: 'BV1', title: 'title', upperName: 'upper', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-02',
    backupStatus: 'verified', biliStatus: 'available',
    remoteFiles: [{ name: 'video.mp4', path: '/archive/video.mp4', qualityProfile: { quality: '', encoding: '' } }],
  });
  assert.equal(decoded.remoteFiles?.[0].qualityProfile, undefined);
});

test('download API cooldown decoder validates its persisted control mode', () => {
  assert.throws(
    () => decodeDownloadApiCooldown({ until: 10, reason: 'cooldown', probeBvid: 'BV1', probeUserId: 'u1', probeMode: 'desktop', setAt: '2026-01-01' }),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('probeMode'),
  );
  assert.deepEqual(decodeDownloadApiCooldown({
    until: 10,
    reason: 'cooldown',
    probeBvid: 'BV1',
    probeUserId: 'u1',
    probeMode: 'web',
    setAt: '2026-01-01',
  }), {
    until: 10,
    reason: 'cooldown',
    probeBvid: 'BV1',
    probeUserId: 'u1',
    probeMode: 'web',
    setAt: '2026-01-01',
  });
});

test('upload cooldown decoder rejects malformed health control fields', () => {
  assert.throws(
    () => decodeUploadCooldown({ state: 'open', retryAt: 'later', category: 'auth' }, 'upload health'),
    (error: unknown) => error instanceof PersistedDomainDecodeError && error.message.includes('retryAt'),
  );
  assert.deepEqual(decodeUploadCooldown({ state: 'open', retryAt: 20, category: 'transient' }, 'upload health'), {
    state: 'open', retryAt: 20, category: 'transient',
  });
});
