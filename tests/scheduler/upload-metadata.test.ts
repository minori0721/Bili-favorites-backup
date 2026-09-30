import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecoveryUploadItem } from '../../src/scheduler/upload-work.js';
import { parseVerificationPayload, VerificationPayloadError } from '../../src/scheduler/verification-payload.js';
import { UploadPayloadDecodeError } from '../../src/scheduler/upload-payload-decoders.js';
import { required } from '../contract-values.js';

const identity = { bvid: 'BVTEST', localDir: '/local', remotePath: '/remote' };
const measured = {
  width: 1080, height: 1920, duration: 30.5, fps: 59.94, codec: 'HEVC',
  source: 'ffprobe', observedAt: '2026-09-30T10:00:00.000Z',
};
const decoders = [
  { name: 'upload', decode: parseRecoveryUploadItem, error: UploadPayloadDecodeError },
  { name: 'verification', decode: parseVerificationPayload, error: VerificationPayloadError },
];

for (const { name, decode, error: ErrorType } of decoders) {
  test(`${name} preserves measured media evidence and excludes unknown fields`, () => {
    for (const source of ['ffprobe', 'browser']) {
      const input = { ...identity, filenameMetadataByPath: { 'video.mp4': {
        cid: 123, pageIndex: 1, bilibiliQuality: '1080P60', dfn: '1080p60', videoCodecs: 'HEVC',
        mediaMetadata: { ...measured, source, unrelated: 'drop' }, unrelated: 'drop',
      } } };
      const output = required(decode(input).filenameMetadataByPath?.['video.mp4']);
      assert.deepEqual(output.mediaMetadata, { ...measured, source });
      assert.equal(output.cid, 123);
      assert.equal(output.dfn, '1080p60');
      assert.equal('unrelated' in output, false);
      assert.notEqual(output.mediaMetadata, input.filenameMetadataByPath['video.mp4'].mediaMetadata);
    }
  });

  test(`${name} accepts legacy filename-only evidence without inventing measurements`, () => {
    const output = required(decode({ ...identity,
      filenameMetadataByPath: { 'video.mp4': { cid: 123, pageIndex: 1 } },
    }).filenameMetadataByPath?.['video.mp4']);
    assert.equal(output.cid, 123);
    assert.equal(output.mediaMetadata, undefined);
    assert.equal(decode(identity).filenameMetadataByPath, undefined);
    const minimal = { width: 1920, height: 1080, source: 'browser', observedAt: measured.observedAt };
    const media = required(decode({ ...identity,
      filenameMetadataByPath: { 'video.mp4': { mediaMetadata: minimal } },
    }).filenameMetadataByPath?.['video.mp4']).mediaMetadata;
    assert.equal(media?.duration, undefined);
    assert.equal(media?.fps, undefined);
    assert.equal(media?.codec, undefined);
  });

  test(`${name} rejects malformed measurements with field-only diagnostics`, () => {
    const invalid: unknown[] = [null, [], {},
      ...[undefined, '1920', 0, -1, 1.5, Infinity].map(width => ({ ...measured, width })),
      ...[undefined, 0, -1].map(height => ({ ...measured, height })),
      ...[0, -1, NaN, '30'].map(duration => ({ ...measured, duration })),
      ...[0, -1, Infinity, '60'].map(fps => ({ ...measured, fps })),
      { ...measured, codec: {} }, { ...measured, source: 'credential-marker' },
      { ...measured, observedAt: undefined }, { ...measured, observedAt: 'credential-marker' },
    ];
    for (const mediaMetadata of invalid) {
      assert.throws(() => decode({ ...identity,
        filenameMetadataByPath: { 'video.mp4': { mediaMetadata } },
      }), (error: unknown) => {
        assert.ok(error instanceof ErrorType);
        assert.match(error.message, /filenameMetadataByPath\.video\.mp4\.mediaMetadata/);
        assert.equal(error.message.includes('credential-marker'), false);
        return true;
      });
    }
  });
}
