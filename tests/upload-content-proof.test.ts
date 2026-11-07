import assert from 'node:assert/strict';
import test from 'node:test';
import { contentProofForFile, decodeUploadContentProof } from '../src/upload-content-proof.js';
import { parseRecoveryUploadItem } from '../src/scheduler/upload-work.js';

const file = { relativePath: 'p1.mp4', finalPath: '/backup/p1.mp4', size: 12, md5: 'A'.repeat(32) };
test('upload fingerprints decode at the real job boundary and bind to the exact session, file and generation', () => {
  const input = { sessionId: 's', generation: 2, files: [file] };
  const item = parseRecoveryUploadItem({ bvid: 'BVPROOF', localDir: '/local', remotePath: '/backup', uploadContentProof: input });
  const expected = { relativePath: file.relativePath, finalPath: file.finalPath, expectedSize: file.size };
  assert.equal(contentProofForFile(item.uploadContentProof, { id: 's', generation: 2 }, expected)?.md5, 'a'.repeat(32));
  for (const session of [{ id: 'old', generation: 2 }, { id: 's', generation: 3 }]) assert.equal(contentProofForFile(item.uploadContentProof, session, expected), undefined);
  assert.equal(contentProofForFile(item.uploadContentProof, { id: 's', generation: 2 }, { ...expected, expectedSize: 13 }), undefined);
  assert.equal(contentProofForFile(item.uploadContentProof, { id: 's', generation: 2 }, { ...expected, finalPath: '/other' }), undefined);
  assert.equal(decodeUploadContentProof(undefined), undefined);
  for (const bad of [null, { ...input, generation: 0 }, { ...input, files: [] }, { ...input, files: [file, file] },
    ...[{ md5: 'bad' }, { size: '12' }, { size: 0 }, { relativePath: '../v' }, { finalPath: '/a/../b' }].map(patch => ({ ...input, files: [{ ...file, ...patch }] }))]) {
    assert.throws(() => decodeUploadContentProof(bad), /Invalid persisted JSON/);
  }
});
