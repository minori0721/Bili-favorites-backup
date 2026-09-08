import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createLocalReleaseRouter } from '../../src/http/local-release.js';
import { parseLocalReleasePreview } from '../../src/shared/api/archive-library.js';

test('local release routes preserve preview contracts and central maintenance admission', async () => {
  let blocked = false;
  const writes: string[][] = [];
  const app = express();
  app.use(express.json());
  app.use(createLocalReleaseRouter({
    boundary: handler => (req, res, next) => {
      if (blocked) { res.status(503).json({ success: false, message: '维护中' }); return; }
      Promise.resolve().then(() => handler(req, res, next)).catch(next);
    },
    service: {
      preview: bvid => ({ ok: true, bvid, fileCount: 1, totalBytes: 5,
        candidates: [{ releaseId: 'reviewed', manifestSessionId: 'session', fileCount: 1, totalBytes: 5, requiresExplicitDeletion: false }] }),
      release: (bvid, id, confirmation) => {
        writes.push([bvid, id, confirmation]);
        return { ok: true, status: 202, bvid, releaseId: id, fileCount: 1, totalBytes: 5 };
      },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/videos`;
  const release = () => fetch(base + '/BVFIXTURE/local-release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ releaseId: 'reviewed', confirmation: 'DELETE LOCAL' }) });
  try {
    const preview = await fetch(base + '/BVFIXTURE/local-release-preview');
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.equal(parseLocalReleasePreview((await preview.json()).data).candidates[0].hasVerifiedArchive, false);
    assert.equal((await fetch(base + '/invalid/local-release-preview')).status, 400);
    blocked = true;
    assert.equal((await release()).status, 503);
    assert.equal(writes.length, 0);
    blocked = false;
    const response = await release();
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(writes, [['BVFIXTURE', 'reviewed', 'DELETE LOCAL']]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
