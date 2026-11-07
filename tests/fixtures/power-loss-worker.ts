import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { commitVerifiedTransfer } from '../../src/scheduler/verified-transfer.js';

const [root, stage] = process.argv.slice(2);
fs.mkdirSync(root, { recursive: true });
const local = path.join(root, 'local'); fs.mkdirSync(local);
const body = Buffer.alloc(64 * 1024, 37);
fs.writeFileSync(path.join(local, 'v.mp4'), body, { flush: true });
const state = new StateManager({ dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json') });
const jobs = new PersistentJobStore(state.getDatabase()), sessions = new TransferSessionStore(state.getDatabase());
state.recordFavoriteItem('fixture-user', 1, 'Fixture', { bvid: 'BVPOWERAUDIT', title: 'Fixture', upperName: 'Fixture' });
const session = sessions.ensurePrepared({ dedupeKey: 'fixture-session', bvid: 'BVPOWERAUDIT', userId: 'fixture-user', mediaId: 1,
  localDir: local, remotePath: '/fixture' }, [{ name: 'v.mp4', relativePath: 'v.mp4', expectedSize: body.length }]);
const job = jobs.enqueue({ kind: 'upload', dedupeKey: 'fixture-job', bvid: 'BVPOWERAUDIT', userId: 'fixture-user', mediaId: 1,
  payload: { localDir: local, remotePath: '/fixture', files: ['v.mp4'], sessionId: session.id, sessionGeneration: session.generation } });
jobs.claimByDedupeKey('fixture-job', 'killed-owner', 10_000);
const signal = () => process.send!({ ready: true, jobId: job.id, sessionId: session.id, generation: session.generation });
if (stage === 'transaction-open') {
  state.runAtomic(() => {
    state.markUploading('BVPOWERAUDIT', 'fixture-user', 1);
    sessions.updateFile(session.id, 'v.mp4', { status: 'verified', putAcceptedAt: Date.now(), verifiedAt: Date.now() }, session.generation);
    jobs.complete(job.id);
    signal(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
} else {
  if (stage === 'content-checkpoint') jobs.updatePayload(job.id, { ...job.payload, uploadContentProof: { sessionId: session.id,
    generation: session.generation, files: [{ relativePath: 'v.mp4', finalPath: '/fixture/v.mp4', size: body.length,
      md5: createHash('md5').update(body).digest('hex') }] } });
  if (stage === 'put-accepted' || stage === 'verified-commit') sessions.updateFile(session.id, 'v.mp4', {
    putAcceptedAt: Date.now(), status: stage === 'verified-commit' ? 'verified' : 'awaiting_remote',
    ...(stage === 'verified-commit' ? { verifiedAt: Date.now() } : {}) }, session.generation);
  if (stage === 'verified-commit') commitVerifiedTransfer({ state, jobs, sessions, now: Date.now, leaseOwner: 'killed-owner' }, {
    bvid: 'BVPOWERAUDIT', userId: 'fixture-user', mediaId: 1, jobId: job.id, partialBackup: false, historyOnly: false,
    result: { remotePath: '/fixture', allVerified: true, sessionId: session.id, sessionGeneration: session.generation,
      files: [{ name: 'v.mp4', path: '/fixture/v.mp4', size: body.length, verificationStatus: 'verified' }] } });
  signal(); setInterval(() => {}, 1000);
}
