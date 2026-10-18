import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { inspectDownloadCache } from '../../src/download-session.js';
import { createTestDir, removeTestDir } from '../helpers.js';

test("async download cache inspection matches recovery classification without blocking the event loop", { timeout: 60_000 }, async () => {
  const runtime = await createTestDir("download-cache-async");
  try {
    for (let directoryIndex = 0; directoryIndex < 100; directoryIndex += 1) {
      const downloadDir = path.join(runtime, `BVASYNC${String(directoryIndex).padStart(4, "0")}`);
      await fs.promises.mkdir(downloadDir, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, fileIndex) =>
        fs.promises.writeFile(path.join(downloadDir, `track-${fileIndex}.part`), Buffer.alloc(1))
      ));
    }
    const credentialDir = path.join(runtime, "bbdown-credentials-old");
    await fs.promises.mkdir(credentialDir, { recursive: true });
    await fs.promises.writeFile(path.join(credentialDir, "secret.txt"), Buffer.alloc(7));

    let settled = false;
    const pending = inspectDownloadCache(runtime).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const inspection = await pending;
    assert.equal(inspection.usedBytes, 10_007);
    assert.equal(inspection.fileCount, 10_001);
    assert.equal(inspection.exportableBytes, 10_000);
    assert.equal(inspection.exportableFiles, 10_000);
    assert.equal(inspection.recovery.legacyDirectories, 100);
    assert.equal(inspection.recovery.cleanupEligibleBytes, 10_000);
  } finally {
    await removeTestDir(runtime);
  }
});
