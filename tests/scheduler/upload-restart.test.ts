import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {StateManager} from '../../src/state.js';
import {PersistentJobStore} from '../../src/job-store.js';
import {TransferSessionStore, TransferSessionGenerationError} from '../../src/transfer-session.js';
import {UploadTask, UploadVerificationTask} from '../../src/tasks.js';
import {createUploadTaskFactory} from '../../src/scheduler/upload-task-factory.js';
import {parseRecoveryUploadItem} from '../../src/scheduler/upload-work.js';
import {commitVerifiedTransfer} from '../../src/scheduler/verified-transfer.js';
import {UploadCircuitBreaker} from '../../src/upload-health.js';
import {taskUploadFailure} from '../../src/scheduler/task-failure.js';
import {createUploadFailureHandler} from '../../src/scheduler/upload-failure.js';
import {createTestDir, removeTestDir, testConfig} from '../helpers.js';

type HashReply = 'match' | 'mismatch' | 'unsupported' | 'transient-once';
const bytes = Buffer.alloc(130_000, 37);
const md5 = (body: Buffer) => createHash('md5').update(body).digest('hex');
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Real WebDAV and OpenList requests exercise the production task/factory wiring.
async function storage(options: {files: Map<string, Buffer>; hashReply?: HashReply; onHash?(): void}) {
  const directories = new Set(['/', '/target']);
  const hidden = new Set<string>();
  let metadataUnavailable = false;
  const puts: string[] = [], hashReads: string[] = [];
  function entry(name: string, directory: boolean) {
    return `<d:response><d:href>${xml('/dav' + name)}</d:href><d:propstat><d:prop><d:displayname>${xml(path.posix.basename(name))}</d:displayname><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${options.files.get(name)?.length ?? 0}</d:getcontentlength><d:getcontenttype>application/octet-stream</d:getcontenttype><d:getlastmodified>${new Date().toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/api/fs/get') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const target: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(target && typeof target === 'object' && 'path' in target && typeof target.path === 'string');
      hashReads.push(target.path); options.onHash?.();
      if (options.hashReply === 'transient-once' && hashReads.length === 1) {response.writeHead(503).end(); return;}
      const body = options.files.get(target.path);
      assert.ok(body, 'content lookup must address an existing file');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({code: 200, data: {name: path.posix.basename(target.path), size: body.length, is_dir: false,
        hash_info: options.hashReply === 'unsupported' ? null : {md5: options.hashReply === 'mismatch' ? '0'.repeat(32) : md5(body)}}}));
      return;
    }
    const name = decodeURIComponent(url.pathname).replace(/^\/dav/, '').replace(/\/$/, '') || '/';
    if (request.method === 'PROPFIND') {
      if (metadataUnavailable) {response.writeHead(503, {'Retry-After': '2'}).end(); return;}
      if (hidden.has(name) || (!options.files.has(name) && !directories.has(name))) {response.writeHead(404).end(); return;}
      const entries = [entry(name, directories.has(name))];
      if (directories.has(name) && request.headers.depth !== '0') {
        for (const child of options.files.keys()) if (path.posix.dirname(child) === name && !hidden.has(child)) entries.push(entry(child, false));
      }
      response.writeHead(207, {'Content-Type': 'application/xml'});
      response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`);
    } else if (request.method === 'MKCOL') {
      directories.add(name); response.writeHead(201).end();
    } else if (request.method === 'PUT') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      puts.push(name); options.files.set(name, Buffer.concat(chunks)); response.writeHead(201).end();
    } else {response.writeHead(405).end();}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return {url: `http://127.0.0.1:${address.port}`, puts, hashReads, files: options.files,
    hide(name: string) {hidden.add(name);}, show(name: string) {hidden.delete(name);},
    setMetadataUnavailable(value: boolean) {metadataUnavailable = value;},
    close: async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}};
}

async function fixture(options: {hashReply?: HashReply; partial?: boolean; proof?: 'none' | 'session' | 'generation' | 'relative' | 'path' | 'size'; fresh?: boolean} = {}) {
  const root = await createTestDir('upload-restart');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  let now = Date.now(), generation = 0, onHash = () => {};
  const jobs = new PersistentJobStore(state.getDatabase(), {normalizeRecovery: false, now: () => now});
  const sessions = new TransferSessionStore(state.getDatabase());
  const remote = await storage({files: new Map(options.fresh ? [] : [['/target/v.mp4', bytes]]), hashReply: options.hashReply, onHash: () => onHash()});
  const local = path.join(root, 'media'); await fs.promises.mkdir(local);
  await fs.promises.writeFile(path.join(local, 'v.mp4'), bytes);
  const names = options.partial ? ['v.mp4', 'p2.mp4'] : ['v.mp4'];
  if (options.partial) await fs.promises.writeFile(path.join(local, 'p2.mp4'), bytes);
  state.recordFavoriteItem('fixture', 1, 'Fixture', {bvid: 'BVRESTART', title: 'Fixture', upperName: 'Fixture'});
  const session = sessions.ensurePrepared({dedupeKey: 'restart-session', bvid: 'BVRESTART', userId: 'fixture', mediaId: 1,
    localDir: local, remotePath: '/target'}, names.map(name => ({name, relativePath: name, expectedSize: bytes.length})));
  const proof = {sessionId: options.proof === 'session' ? 'another-session' : session.id,
    generation: session.generation + (options.proof === 'generation' ? 1 : 0),
    files: [{relativePath: options.proof === 'relative' ? 'another.mp4' : 'v.mp4', finalPath: options.proof === 'path' ? '/another/v.mp4' : '/target/v.mp4',
      size: bytes.length + (options.proof === 'size' ? 1 : 0), md5: md5(bytes)}]};
  const job = jobs.enqueue({kind: 'upload', dedupeKey: 'restart-job', bvid: 'BVRESTART', userId: 'fixture', mediaId: 1,
    payload: {bvid: 'BVRESTART', userId: 'fixture', mediaId: 1, localDir: local, remotePath: '/target', files: names,
      sessionId: session.id, sessionGeneration: session.generation, sessionDedupeKey: session.dedupeKey,
      uploadIntent: 'normal_backup', conflictCandidateId: 'restart-candidate', conflictCandidateRemotePath: '/target/_conflicts/restart-candidate',
      ...(!options.fresh && options.proof !== 'none' ? {uploadContentProof: proof} : {})}});
  const previous = jobs.claimByDedupeKey(job.dedupeKey, 'terminated-process', 1000)!;
  now = previous.leaseExpiresAt! + 1; jobs.recoverExpiredLeases(now);
  const owner = 'restarted-process'; jobs.claimByDedupeKey(job.dedupeKey, owner, 300_000);
  const factory = createUploadTaskFactory({stateManager: state, configStore: {get: () => testConfig({alistUrl: remote.url})},
    jobStore: jobs, transferSessions: sessions, leaseOwner: owner, generation: () => generation,
    captureExistingArchiveProof: () => undefined, legacyConflictSideEffectsStarted: () => false, restoreConflictCandidateExistingArchive: () => false});
  function build(resumeOnly = false) {
    const live = jobs.findById(job.id); assert.ok(live);
    const task = factory.build(parseRecoveryUploadItem({...live.payload, resumeOnly}));
    task.persistentJobId = job.id; task.persistentJob = live;
    return task;
  }
  return {state, jobs, sessions, session, job, owner, local, remote, build,
    setOnHash(callback: () => void) {onHash = callback;}, invalidateRuntime() {generation++;},
    async close() {await remote.close(); state.close(); await removeTestDir(root);}};
}

for (const resumeOnly of [false, true]) {
  test(`reclaimed production upload uses its saved fingerprint without another PUT or fabricated receipt: resumeOnly=${resumeOnly}`, async () => {
    const f = await fixture();
    try {
      if (resumeOnly) await fs.promises.unlink(path.join(f.local, 'v.mp4'));
      const task = f.build(resumeOnly); await task.run();
      assert.ok(task.result?.allVerified); assert.equal(task.result.disposition, resumeOnly ? undefined : 'resumed_current_session');
      assert.deepEqual(f.remote.hashReads, ['/target/v.mp4']); assert.deepEqual(f.remote.puts, []);
      assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.putAcceptedAt, undefined);
      commitVerifiedTransfer({state: f.state, jobs: f.jobs, sessions: f.sessions, now: Date.now, leaseOwner: f.owner}, {
        bvid: 'BVRESTART', userId: 'fixture', mediaId: 1, jobId: f.job.id, result: task.result, partialBackup: false, historyOnly: false,
      });
      assert.equal(f.jobs.findById(f.job.id), null); assert.equal(f.sessions.get(f.session.id)?.phase, 'completed');
      assert.equal(f.state.getRelationStatus('fixture', 1, 'BVRESTART')?.backupStatus, 'verified');
      assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.putAcceptedAt, undefined);
      assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
    } finally {await f.close();}
  });
}

test('a reclaimed multipart upload retains the checksum-confirmed page and PUTs only the missing page', async () => {
  const f = await fixture({partial: true});
  try {
    const task = f.build(); await task.run();
    assert.ok(task.result?.allVerified); assert.equal(task.result.files.length, 2);
    assert.deepEqual(f.remote.puts, ['/target/p2.mp4']); assert.deepEqual(f.remote.hashReads, ['/target/v.mp4']);
    assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.putAcceptedAt, undefined);
    assert.ok(f.sessions.getFile(f.session.id, 'p2.mp4')?.putAcceptedAt);
    assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
  } finally {await f.close();}
});

test('fresh production uploads make no content lookup requests', async () => {
  const f = await fixture({fresh: true});
  try {
    const task = f.build(); await task.run();
    assert.ok(task.result?.allVerified); assert.deepEqual(f.remote.hashReads, []); assert.deepEqual(f.remote.puts, ['/target/v.mp4']);
  } finally {await f.close();}
});

test('a recorded PUT receipt remains sufficient and does not add content lookups', async () => {
  const f = await fixture();
  try {
    const at = Date.now();
    f.sessions.updateFile(f.session.id, 'v.mp4', {putAcceptedAt: at}, f.session.generation);
    const task = f.build(); await task.run();
    assert.ok(task.result?.allVerified); assert.deepEqual(f.remote.hashReads, []); assert.deepEqual(f.remote.puts, []);
    assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.putAcceptedAt, at);
  } finally {await f.close();}
});

test('a temporary WebDAV outage keeps its retry status instead of turning restart recovery into a conflict candidate', async () => {
  const f = await fixture();
  try {
    f.remote.setMetadataUnavailable(true);
    const failed = f.build();
    await assert.rejects(failed.run(), (error: unknown) => {
      const failure = taskUploadFailure(error, 'BVRESTART');
      assert.equal(failure.status, 503); assert.equal(failure.category, 'server');
      assert.equal(failure.retryAfterMs, 2000); return true;
    });
    assert.equal(failed.conflictCandidateAttempted, false);
    assert.deepEqual(f.remote.puts, []); assert.deepEqual(f.remote.hashReads, []);
    f.remote.setMetadataUnavailable(false);
    const task = f.build(); await task.run(); assert.ok(task.result?.allVerified);
    assert.deepEqual(f.remote.puts, []); assert.deepEqual(f.remote.hashReads, ['/target/v.mp4']);
    assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
  } finally {await f.close();}
});

test('ordinary restart waits for an acknowledged but temporarily invisible file, then verification finishes without another PUT', async () => {
  const f = await fixture();
  try {
    const acceptedAt = Date.now();
    f.sessions.updateFile(f.session.id, 'v.mp4', {putAcceptedAt: acceptedAt, attempts: 1}, f.session.generation);
    f.remote.hide('/target/v.mp4');
    const task = f.build(); await task.run();
    assert.equal(task.result?.allVerified, false); assert.equal(task.result.pendingChecks?.length, 1);
    assert.deepEqual(f.remote.puts, []); assert.deepEqual(f.remote.hashReads, []);
    assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.status, 'awaiting_remote');
    assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.putAcceptedAt, acceptedAt);
    assert.notEqual(f.state.getRelationStatus('fixture', 1, 'BVRESTART')?.backupStatus, 'verified');
    f.remote.show('/target/v.mp4');
    const verify = new UploadVerificationTask('BVRESTART', 'fixture', 1, '/target/v.mp4', bytes.length,
      testConfig({alistUrl: f.remote.url}), {transferSessionStore: f.sessions, sessionId: f.session.id, sessionGeneration: f.session.generation});
    await verify.run();
    assert.equal(verify.result?.status, 'verified'); assert.equal(verify.transferResult?.allVerified, true);
    assert.deepEqual(f.remote.puts, []); assert.deepEqual(f.remote.hashReads, []);
    assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
  } finally {await f.close();}
});

for (const resumeOnly of [false, true]) test(`a transient content lookup failure sends no PUT and the next attempt can finish without uploading: resumeOnly=${resumeOnly}`, async () => {
  const f = await fixture({hashReply: 'transient-once'});
  try {
    await assert.rejects(f.build(resumeOnly).run(), (error: unknown) => {
      const failure = taskUploadFailure(error, 'BVRESTART');
      assert.equal(failure.status, 503); assert.equal(failure.category, 'server'); return true;
    });
    assert.deepEqual(f.remote.puts, []); assert.ok(f.jobs.findById(f.job.id));
    assert.notEqual(f.state.getRelationStatus('fixture', 1, 'BVRESTART')?.backupStatus, 'verified');
    const task = f.build(resumeOnly); await task.run(); assert.ok(task.result?.allVerified);
    assert.deepEqual(f.remote.puts, []); assert.equal(f.remote.hashReads.length, 2);
  } finally {await f.close();}
});

for (const reply of ['mismatch', 'unsupported'] as const) {
  test(`unconfirmed remote content retains the existing conflict policy without overwriting the original: ${reply}`, async () => {
    const f = await fixture({hashReply: reply});
    try {
      const task = f.build(); await task.run();
      assert.equal(task.result?.disposition, 'conflict_candidate'); assert.deepEqual(f.remote.hashReads, ['/target/v.mp4']);
      assert.deepEqual(f.remote.puts, ['/target/_conflicts/restart-candidate/v.mp4']);
      assert.equal(f.sessions.getFile(f.session.id, 'v.mp4')?.putAcceptedAt, undefined);
      assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
    } finally {await f.close();}
  });
}

for (const proof of ['none', 'session', 'generation', 'relative', 'path', 'size'] as const) {
  test(`a proof for another upload cannot authorize ordinary restart recovery: ${proof}`, async () => {
    const f = await fixture({proof});
    try {
      const task = f.build(); await task.run();
      assert.equal(task.result?.disposition, 'conflict_candidate'); assert.deepEqual(f.remote.hashReads, []);
      assert.deepEqual(f.remote.puts, ['/target/_conflicts/restart-candidate/v.mp4']);
      assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
    } finally {await f.close();}
  });
}

for (const change of ['runtime', 'lease', 'session', 'superseded'] as const) {
  test(`late content lookup results cannot mutate the upload after ${change} changes`, async () => {
    const f = await fixture();
    try {
      const snapshot = () => JSON.stringify({job: f.jobs.findById(f.job.id), session: f.sessions.get(f.session.id),
        relation: f.state.getRelationStatus('fixture', 1, 'BVRESTART')});
      let expected = '';
      f.setOnHash(() => {
        if (change === 'runtime') f.invalidateRuntime();
        else if (change === 'lease') f.jobs.releaseOwner(f.owner);
        else {
          f.sessions.supersede(f.session.id, f.session.generation);
          if (change === 'session') f.sessions.ensurePrepared({dedupeKey: f.session.dedupeKey, bvid: 'BVRESTART', localDir: f.local, remotePath: '/target'},
            [{name: 'v.mp4', relativePath: 'v.mp4', expectedSize: bytes.length}]);
        }
        expected = snapshot();
      });
      const task = f.build(); let failure: unknown;
      await assert.rejects(task.run(), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, /inactive|ownership|no longer current|superseded/i);
        failure = error; return true;
      });
      assert.equal(snapshot(), expected, 'late lookup must not change persisted state');
      let dispatches = 0;
      const rejectCallback = () => assert.fail('stale failure must not enter ordinary failure handling');
      const onFailure = createUploadFailureHandler({jobStore: f.jobs, uploadCircuit: new UploadCircuitBreaker(),
        downloadQueue: {poke: rejectCallback}, leaseOwner: f.owner, now: Date.now, random: () => 0,
        dispatchPersistentJobs: () => {dispatches++;}, handleEncodingRetryUploadError: rejectCallback,
        recordUploadFailure: rejectCallback, syncQualityUpgradeControl: rejectCallback, queueAutomaticQualityRecovery: rejectCallback,
        markUploadTaskFailed: rejectCallback, formatUploadFailureLog: rejectCallback, startConflictCandidate: rejectCallback});
      onFailure(task, failure);
      assert.equal(dispatches, 1); assert.equal(snapshot(), expected, 'the queue failure callback must also preserve current state');
      assert.deepEqual(f.remote.puts, []); assert.ok(f.jobs.findById(f.job.id));
      assert.equal(f.sessions.getFile(f.session.id, 'v.mp4', f.session.generation)?.status, 'pending');
      assert.equal(f.sessions.getFile(f.session.id, 'v.mp4', f.session.generation)?.putAcceptedAt, undefined);
      assert.deepEqual(f.remote.files.get('/target/v.mp4'), bytes);
    } finally {await f.close();}
  });
}

test('a stale session error cannot turn into a conflict upload even without a scheduler guard', async () => {
  const stale = new TransferSessionGenerationError('session', 1, 2); let calls = 0;
  const task = new UploadTask('BVRESTART', '/unused', '/target', testConfig(), {
    files: ['v.mp4'], upload: async () => {calls++; throw stale;}, conflictCandidateId: 'candidate', conflictCandidateRemotePath: '/target/_conflicts/candidate',
  });
  await assert.rejects(task.run(), error => error === stale); assert.equal(calls, 1); assert.equal(task.result, undefined);
});
