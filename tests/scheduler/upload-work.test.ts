import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecoveryUploadItem } from '../../src/scheduler/upload-work.js';

test('persisted upload metadata requires the transfer identity and local/remote roots', () => {
  assert.deepEqual(parseRecoveryUploadItem({
    bvid: 'BVTEST', localDir: 'C:/archive/BVTEST', remotePath: '/archive/BVTEST',
    historyOnly: false, files: ['P1.mp4'], priority: false,
  }), {
    bvid: 'BVTEST', localDir: 'C:/archive/BVTEST', remotePath: '/archive/BVTEST',
    historyOnly: false, files: ['P1.mp4'], priority: false,
  });
  assert.throws(() => parseRecoveryUploadItem({localDir: 'C:/archive', remotePath: '/archive'}), /bvid/);
  assert.throws(() => parseRecoveryUploadItem({bvid: 'BVTEST', localDir: 'C:/archive'}), /remotePath/);
});

test('persisted upload metadata does not coerce malformed control fields', () => {
  assert.throws(() => parseRecoveryUploadItem({
    bvid: 'BVTEST', localDir: 'C:/archive', remotePath: '/archive', historyOnly: 'false',
  }), /historyOnly/);
  assert.throws(() => parseRecoveryUploadItem({
    bvid: 'BVTEST', localDir: 'C:/archive', remotePath: '/archive', files: ['P1.mp4', 1],
  }), /files/);
});

test('upload decoding validates optional evidence and drops unknown fields', () => {
  const identity = {bvid: 'BVTEST', localDir: '/local', remotePath: '/remote'};
  for (const [key, value] of Object.entries({sessionGeneration: 'bad', existingArchiveProof: 42,
    uploadIntent: 'invalid', userId: 1, mediaId: '2', encodingRetry: {}, strictMediaTarget: {encoding: 'bad'},
    conflictArchiveOldFiles: [{name: 'a', path: 1}], filenameMetadataByPath: {a: {cid: 'bad'}}})) {
    assert.throws(() => parseRecoveryUploadItem({...identity, [key]: value}), new RegExp(key));
  }
  assert.deepEqual(parseRecoveryUploadItem({...identity, untrusted: true}), identity);
});
