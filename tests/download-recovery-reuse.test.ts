import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BBDOWN_SOURCE_COMMIT, DOWNLOAD_SESSION_FILE, cleanupDownloadRecoveryArtifacts, cleanupUploadedSessionFiles,
  inspectDownloadCache, reuseVerifiedRecoveryOutputs, writeDownloadSession, type DownloadSessionManifest } from '../src/download-session.js';
import { isRecoveryProtected, protectRecoveryDirectory } from '../src/recovery-file-protection.js';
import { createTestDir, removeTestDir } from './helpers.js';

async function fixture() {
  const root = await createTestDir('recovery-reuse');
  const source = path.join(root, 'BVREUSE');
  const target = path.join(root, 'fresh');
  await fs.mkdir(source); await fs.mkdir(target);
  const timestamp = '2026-10-03T00:00:00.000Z';
  const pages = [{ index: 1, cid: 11, title: 'P1', duration: 1 }, { index: 2, cid: 22, title: 'P2', duration: 1 }];
  const manifest: DownloadSessionManifest = { schemaVersion: 1, sessionId: 'source', kind: 'backup', bvid: 'BVREUSE', accountUid: 1,
    bbdownCommit: BBDOWN_SOURCE_COMMIT, configFingerprint: 'same',
    configSnapshot: { quality: '', encoding: '', apiMode: 'web', hiRes: false, dolby: false, filenameTemplate: '<videoTitle>-<bvid>' },
    createdAt: timestamp, updatedAt: timestamp, snapshotAt: timestamp, status: 'partial', pages, history: [],
    outputs: [{ relativePath: 'video_P1.mp4', pageIndex: 1, cid: 11, size: 5, duration: 1, videoCodec: 'h264', verifiedAt: timestamp, quickHash: 'same-hash' }] };
  await fs.writeFile(path.join(source, 'video_P1.mp4'), 'media');
  await fs.writeFile(path.join(source, 'video_P2.mp4.aria2'), 'partial');
  writeDownloadSession(source, manifest);
  return { root, source, target, pages, manifest, close: () => removeTestDir(root) };
}

test('reuse copies only a matching verified page, preserves incomplete fragments, and never overwrites a new attempt', async () => {
  const f = await fixture(); let inspections = 0;
  try {
    const verify = async () => { inspections++; return { size: 5, duration: 1, videoCodec: 'h264', quickHash: 'same-hash' }; };
    assert.equal(await reuseVerifiedRecoveryOutputs(f.source, f.target, 'BVREUSE', f.pages, 'same', verify), 1);
    assert.deepEqual(await fs.readdir(f.target), ['video_P1.mp4']);
    assert.equal(await fs.readFile(path.join(f.source, 'video_P2.mp4.aria2'), 'utf8'), 'partial');
    await fs.writeFile(path.join(f.target, 'video_P1.mp4'), 'newer');
    assert.equal(await reuseVerifiedRecoveryOutputs(f.source, f.target, 'BVREUSE', f.pages, 'same', verify), 0);
    assert.equal(await fs.readFile(path.join(f.target, 'video_P1.mp4'), 'utf8'), 'newer');
    assert.equal(inspections, 2); assert.equal(await fs.readFile(path.join(f.source, 'video_P1.mp4'), 'utf8'), 'media');
  } finally { await f.close(); }
});

for (const mode of ['cid', 'fingerprint', 'hash', 'corrupt-manifest', 'changed-during-probe', 'invalid-media', 'ambiguous-name'] as const) {
  test(`untrusted existing media is preserved and excluded from reuse: ${mode}`, async () => {
    const f = await fixture();
    try {
      if (mode === 'corrupt-manifest') await fs.writeFile(path.join(f.source, DOWNLOAD_SESSION_FILE), '{bad');
      if (mode === 'ambiguous-name') {
        f.manifest.outputs[0].relativePath = 'ambiguous.mp4';
        await fs.rename(path.join(f.source, 'video_P1.mp4'), path.join(f.source, 'ambiguous.mp4'));
        writeDownloadSession(f.source, f.manifest);
      }
      const pages = mode === 'cid' ? [{ ...f.pages[0], cid: 99 }, f.pages[1]] : f.pages;
      const copied = await reuseVerifiedRecoveryOutputs(f.source, f.target, 'BVREUSE', pages, mode === 'fingerprint' ? 'changed' : 'same', async () => {
        if (mode === 'invalid-media') throw new Error('no playable stream');
        if (mode === 'changed-during-probe') await fs.writeFile(path.join(f.source, 'video_P1.mp4'), 'changed');
        return { size: 5, duration: 1, videoCodec: 'h264', quickHash: mode === 'hash' ? 'different' : 'same-hash' };
      });
      assert.equal(copied, 0); assert.deepEqual(await fs.readdir(f.target), []);
      assert.ok((await fs.readdir(f.source)).includes('video_P2.mp4.aria2'));
    } finally { await f.close(); }
  });
}

test('durable protection blocks direct cleanup, automatic fragment cleanup and eligible-byte accounting after restart', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.source, '_invalid'));
    await fs.writeFile(path.join(f.source, '_invalid', 'old.part'), 'old-fragment');
    const original = await fs.readFile(path.join(f.source, DOWNLOAD_SESSION_FILE), 'utf8');
    protectRecoveryDirectory(f.source); protectRecoveryDirectory(f.source);
    assert.equal(isRecoveryProtected(f.source), true);
    const direct = await cleanupUploadedSessionFiles(f.source, { confirmedRelativePaths: ['video_P1.mp4'] });
    assert.equal(direct.removedFiles, 0); assert.ok(direct.retainedBytes > 0);
    const automatic = await cleanupDownloadRecoveryArtifacts(f.root);
    assert.equal(automatic.removedFiles, 0);
    const summary = await inspectDownloadCache(f.root);
    assert.equal(summary.recovery.cleanupEligibleBytes, 0); assert.ok(summary.recovery.retainedBytes >= 5);
    assert.equal(await fs.readFile(path.join(f.source, DOWNLOAD_SESSION_FILE), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(f.source, '_invalid', 'old.part'), 'utf8'), 'old-fragment');
    assert.equal(await fs.readFile(path.join(f.source, 'video_P1.mp4'), 'utf8'), 'media');
  } finally { await f.close(); }
});

test('reuse refuses a redirected destination directory and never writes through it', async () => {
  const f = await fixture();
  const outside = path.join(f.root, 'outside');
  try {
    await fs.mkdir(outside);
    await fs.rmdir(f.target);
    await fs.symlink(outside, f.target, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(reuseVerifiedRecoveryOutputs(f.source, f.target, 'BVREUSE', f.pages, 'same', async () => ({
      size: 5, duration: 1, videoCodec: 'h264', quickHash: 'same-hash',
    })), /destination is not a regular directory/);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(await fs.readFile(path.join(f.source, 'video_P1.mp4'), 'utf8'), 'media');
  } finally { await f.close(); }
});
