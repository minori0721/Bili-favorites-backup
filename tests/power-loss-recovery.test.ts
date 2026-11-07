import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../src/state.js';
import { PersistentJobStore } from '../src/job-store.js';
import { TransferSessionStore } from '../src/transfer-session.js';
import { decodeUploadContentProof } from '../src/upload-content-proof.js';
import { createTestDir, removeTestDir } from './helpers.js';

for (const stage of ['transaction-open', 'content-checkpoint', 'put-accepted', 'verified-commit']) {
  test(`abrupt process termination at ${stage} preserves committed evidence and local media`, {timeout: 30_000}, async () => {
    const root = await createTestDir(`crash-${stage}`);
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/power-loss-worker.ts', import.meta.url)), root, stage],
      {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    child.stderr!.on('data', chunk => {stderr += chunk;});
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Worker readiness timed out: ${stderr}`)), 15_000);
        child.once('message', () => {clearTimeout(timeout); resolve();});
        child.once('error', error => {clearTimeout(timeout); reject(error);});
        child.once('exit', code => {clearTimeout(timeout); reject(new Error(`Worker exited ${code}: ${stderr}`));});
      });
      const closed = once(child, 'close');
      assert.equal(child.kill('SIGKILL'), true);
      await closed;
      const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
      try {
        const database = state.getDatabase();
        const jobs = new PersistentJobStore(database), sessions = new TransferSessionStore(database);
        assert.equal(database.db.pragma('quick_check', {simple: true}), 'ok');
        assert.equal(database.db.pragma('synchronous', {simple: true}), 2);
        const session = sessions.getByDedupeKey('fixture-session')!;
        const file = sessions.getFile(session.id, 'v.mp4', session.generation)!;
        const job = jobs.findByDedupeKey('fixture-job');
        if (stage === 'verified-commit') {
          assert.equal(job, null);
          assert.equal(session.phase, 'completed');
          assert.equal(state.listRelationsForBvid('BVPOWERAUDIT')[0].backupStatus, 'verified');
        } else {
          assert.ok(job);
          assert.equal(job.status, 'running');
          if (stage === 'transaction-open') {assert.equal(file.status, 'pending'); assert.equal(file.putAcceptedAt, undefined);}
          if (stage === 'content-checkpoint') assert.equal(decodeUploadContentProof(job.payload.uploadContentProof)?.files.length, 1);
          if (stage === 'put-accepted') assert.ok(file.putAcceptedAt);
          assert.equal(jobs.nextDueAt('next-process'), job.leaseExpiresAt);
          jobs.recoverExpiredLeases(job.leaseExpiresAt!);
          assert.equal(jobs.findById(job.id)?.status, 'pending');
        }
        assert.deepEqual(fs.readFileSync(path.join(root, 'local', 'v.mp4')), Buffer.alloc(64 * 1024, 37));
      } finally {state.close();}
    } finally {
      if (child.exitCode === null && child.signalCode === null) {const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;}
      await removeTestDir(root);
    }
  });
}
