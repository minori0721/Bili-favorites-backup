import { required } from '../contract-values.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeDownloadSession } from '../../src/download-session.js';
import { createBackupEnqueue } from '../../src/scheduler/backup-enqueue.js';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { createConflictResolution } from '../../src/scheduler/conflict-resolution.js';
import { createRecoveryAbandonment } from '../../src/scheduler/recovery-abandonment.js';
import { createRecoveryWork } from '../../src/scheduler/recovery-work.js';
import { createRecoveryFinalization } from '../../src/scheduler/recovery-finalization.js';
import { createLegacyDownloadRecovery } from '../../src/scheduler/legacy-download-recovery.js';
import type { BiliUser } from '../../src/users.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

async function fixture() {
  const directory = await createTestDir('recovery-actions-atomic');
  const state = new StateManager({ statePath: path.join(directory, 'state.json'), dbPath: path.join(directory, 'state.sqlite') });
  const bvid = 'BVATOMIC';
  state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP' });
  const sessions = new TransferSessionStore(state.getDatabase());
  const jobs = new PersistentJobStore(state.getDatabase());
  const session = sessions.ensure({ dedupeKey: 'candidate', bvid, localDir: directory, remotePath: '/candidate' });
  const candidate = { id: 'candidate', originalRemotePath: '/original', candidateRemotePath: '/candidate', reasonCode: 'CONFLICT', reasonSummary: 'Fixture',
    files: [{ name: 'v.mp4', path: '/candidate/v.mp4', size: 12, verificationStatus: 'verified' as const }] };
  state.recordRemoteConflictCandidate(bvid, 'u', 1, candidate);
  const job = jobs.enqueue({ kind: 'upload' as const, dedupeKey: 'candidate', bvid, userId: 'u', mediaId: 1, initialStatus: 'manual_wait',
    payload: { awaitingManualRecovery: true, conflictCandidate: candidate, sessionId: session.id, sessionGeneration: session.generation } });
  const work = createRecoveryWork<void>();
  return { directory, state, sessions, jobs, session, job, candidate, work, bvid,
    close: async () => { state.close(); await removeTestDir(directory); } };
}

for (const localStatus of ['missing', 'changed'] as const) {
  for (const rejectCompletion of [false, true]) {
    test(`real recovery preparation ignores stale completed media: ${localStatus}, rollback=${rejectCompletion}`, async () => {
      const f = await fixture();
      const user: BiliUser = {id:'u',uid:1,name:'Fixture',enabled:true,lastLoginAt:'',favorites:[{mediaId:1,title:'Favorites'}],
        cookie:{SESSDATA:'',bili_jct:'',DedeUserID:'1'}};
      try {
        writeDownloadSession(f.directory, {
          schemaVersion:1,sessionId:'local',kind:'backup' as const,bvid:f.bvid,accountUid:1,bbdownCommit:'test',configFingerprint:'test',
          configSnapshot:{quality:'4K',encoding:'HEVC',apiMode:'web',hiRes:false,dolby:false,filenameTemplate:'<bvid>'},
          createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:00:00Z',snapshotAt:'2026-09-08T00:00:00Z',
          status:'complete' as const,pages:[{index:1,cid:1,title:'P1',duration:1}],history:[],
          outputs:[{pageIndex:1,cid:1,relativePath:'v.mp4',size:12,duration:1,videoCodec:'hevc',audioCodec:'aac',width:64,height:64,frameRate:30,quickHash:'old',verifiedAt:'2026-09-08T00:00:00Z'}],
        });
        if(localStatus === 'changed') await fs.writeFile(path.join(f.directory,'v.mp4'),'changed');
        f.state.markDownloaded(f.bvid,f.directory,[{userId:'u',mediaId:1}]);
        assert.ok(f.state.getCompletedLocalDownload(f.bvid), 'stale manifest remains discoverable');
        let dispatches = 0;
        const enqueue = createBackupEnqueue({config:{get:()=>testConfig()},state:f.state,jobs:f.jobs,
          eligible:()=>true,blocked:()=>false,remotePath:()=>'/candidate',proof:()=>undefined,
          uploadJob:()=>({kind:'upload' as const,dedupeKey:f.job.dedupeKey,bvid:f.bvid}),historySegment:value=>value,
          probe:()=>assert.fail('unexpected probe'),cycleStartedAt:()=>undefined,generation:()=>1,now:()=>100,dispatch:()=>{dispatches++;},
        });
        assert.equal(enqueue.prepare(user,1,'Favorites',f.bvid,{persisted:true})?.kind,'upload');
        const before = f.state.getStateSnapshot();
        const service = createRecoveryFinalization({stateManager:f.state,transferSessions:f.sessions,
          jobStore:{findById:id=>f.jobs.findById(id),complete:id=>rejectCompletion ? false : f.jobs.complete(id)},
          resolveRelation:()=>({user,folderTitle:'Favorites'}),prepareDownload:enqueue.prepareRecoveryDownload,
          verifiedFilesFromRecovery:()=>[],buildLocalCleanupPlan:()=>null,cleanup:()=>{},now:()=>100,dispatchPersistentJobs:()=>{dispatches++;},
        });
        assert.equal(service.queueFreshDownloadForRecovery(f.job,localStatus,true),!rejectCompletion);
        const replacement = f.jobs.findByDedupeKey(`download:${f.bvid}`);
        assert.equal(dispatches,rejectCompletion ? 0 : 1);
        if(rejectCompletion) {
          assert.equal(replacement,null);
          assert.deepEqual(f.state.getStateSnapshot(),before);
          assert.equal(f.sessions.get(f.session.id)?.phase,f.session.phase);
          assert.ok(f.jobs.findById(f.job.id));
        } else {
          assert.equal(replacement?.kind,'download');
          assert.equal(replacement?.status,'pending');
          assert.equal(f.jobs.findById(f.job.id),null);
          assert.equal(service.queueFreshDownloadForRecovery(f.job,localStatus,true),false);
          assert.equal(f.jobs.findByDedupeKey(`download:${f.bvid}`)?.id,replacement?.id);
        }
      } finally {await f.close();}
    });
  }
}

for (const accepted of [false, true]) {
  test(`legacy recovery preserves failure evidence until replacement commits: accepted=${accepted}`, async () => {
    const f = await fixture();
    const user: BiliUser = { id: 'u', uid: 1, name: 'Fixture', enabled: true, lastLoginAt: '', favorites: [{ mediaId: 1, title: 'Favorites' }],
      cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };
    f.state.markFailed('u', f.bvid, 1, 'legacy tool failure', true);
    const before = f.state.getStateSnapshot();
    const failure = f.state.getDatabase().getFailure('u', f.bvid, 1);
    let dispatches = 0;
    const service = createLegacyDownloadRecovery({
      database: () => f.state.getDatabase(), stateManager: f.state, jobStore: f.jobs,
      userStore: { getById: () => user }, recoveryWork: f.work,
      videoAccessProbe: async () => { throw new Error('unexpected remote request'); },
      generation: () => 1, now: () => 100, resolveRelation: () => ({ user, mediaId: 1, folderTitle: 'Favorites' }),
      isUserSyncEligible: (value): value is BiliUser => value?.enabled === true,
      prepareBackup: () => ({ kind: 'download' as const, commit: () => {
        f.jobs.enqueue({ kind: 'download' as const, dedupeKey: `download:${f.bvid}`, bvid: f.bvid });
        return accepted;
      } }),
      dispatchPersistentJobs: () => { dispatches++; }, getRecoveryIssueSnapshot: () => ({ issues: [] }),
    });
    try {
      assert.equal((await service.resolve(`u:1:${f.bvid}`, 'retry_download', {})).ok, accepted);
      assert.equal(dispatches, accepted ? 1 : 0);
      assert.equal(f.work.busy, false);
      if (!accepted) {
        assert.deepEqual(f.state.getStateSnapshot(), before);
        assert.deepEqual(f.state.getDatabase().getFailure('u', f.bvid, 1), failure);
        assert.equal(f.jobs.findByDedupeKey(`download:${f.bvid}`), null);
      } else {
        assert.ok(f.jobs.findByDedupeKey(`download:${f.bvid}`));
        assert.equal(f.state.getDatabase().getFailure('u', f.bvid, 1), undefined);
      }
    } finally { await f.close(); }
  });
}

for (const failCommit of [true, false]) {
  test(`fresh download replacement commits session, relation and parent together: fail=${failCommit}`, async () => {
    const f = await fixture();
    const user = { id: 'u', uid: 1, name: 'Fixture', enabled: true, lastLoginAt: '', favorites: [{ mediaId: 1, title: 'Favorites' }],
      cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };
    let dispatched = 0;
    const service = createRecoveryFinalization({
      stateManager: f.state, jobStore: f.jobs, transferSessions: f.sessions,
      resolveRelation: () => ({ user, folderTitle: 'Favorites' }),
      prepareDownload: () => ({ kind: 'download' as const, commit: () => {
        f.jobs.enqueue({ kind: 'download' as const, dedupeKey: 'fresh', bvid: f.bvid });
        return !failCommit;
      } }),
      verifiedFilesFromRecovery: () => [], buildLocalCleanupPlan: () => null, cleanup: () => {}, now: () => 100,
      dispatchPersistentJobs: () => { dispatched++; },
    });
    try {
      const before = f.state.getStateSnapshot();
      assert.equal(service.queueFreshDownloadForRecovery(f.job, 'missing', true), !failCommit);
      assert.equal(dispatched, failCommit ? 0 : 1);
      if (failCommit) {
        assert.equal(f.jobs.findByDedupeKey('fresh'), null);
        assert.equal(f.jobs.findById(f.job.id)?.status, 'manual_wait');
        assert.equal(f.sessions.get(f.session.id)?.phase, f.session.phase);
        assert.deepEqual(f.state.getStateSnapshot(), before);
      } else {
        assert.ok(f.jobs.findByDedupeKey('fresh'));
        assert.equal(f.jobs.findById(f.job.id), null);
        assert.equal(f.sessions.get(f.session.id)?.phase, 'superseded');
      }
    } finally { await f.close(); }
  });
}

for (const scenario of ['complete', 'completion-rejected', 'late-generation', 'candidate-changed', 'remote-error'] as const) {
  test(`conflict selection preserves atomic state: ${scenario}`, async () => {
    const f = await fixture();
    let generation = 1;
    let cleanups = 0;
    let dispatched = 0;
    const before = f.state.getStateSnapshot();
    const service = createConflictResolution({
      state: f.state, sessions: f.sessions, config: { get: () => testConfig() }, locks: f.work.locks,
      jobs: { findById: id => f.jobs.findById(id), complete: id => scenario === 'completion-rejected' ? false : f.jobs.complete(id) },
      inspect: async () => {
        if (scenario === 'late-generation') generation++;
        if (scenario === 'candidate-changed') f.state.recordRemoteConflictCandidate(f.bvid, 'u', 1, { ...f.candidate, reasonCode: 'CHANGED' });
        if (scenario === 'remote-error') throw new Error('offline');
        return { status: 'verified' as const, remoteSize: 12, parentStatus: 'visible' };
      },
      proof: () => null, generation: () => generation, now: () => 100,
      cleanup: () => { cleanups++; }, dispatch: () => { dispatched++; }, snapshot: () => ({ issues: [] }),
    });
    try {
      const result = await service.resolve(f.job.id, 'use_candidate');
      assert.equal(result.ok, scenario === 'complete');
      assert.equal(f.work.busy, false);
      if (scenario === 'complete') {
        assert.equal(f.jobs.findById(f.job.id), null);
        assert.equal(f.sessions.get(f.session.id)?.phase, 'superseded');
        const relation = f.state.getRelationStatus('u', 1, f.bvid);
        assert.equal(relation?.remotePath, '/candidate');
        assert.equal(required(relation?.remoteConflictCandidates?.[0]).resolution, 'selected_candidate');
        assert.equal(cleanups, 1);
        assert.equal(dispatched, 1);
      } else {
        assert.equal(f.jobs.findById(f.job.id)?.status, 'manual_wait');
        assert.equal(f.sessions.get(f.session.id)?.phase, f.session.phase);
        assert.equal(cleanups, 0);
        assert.equal(dispatched, 0);
        if (scenario !== 'candidate-changed') assert.deepEqual(f.state.getStateSnapshot(), before);
      }
    } finally { await f.close(); }
  });
}

test('abandon shares the task lock with remote verification and rolls back rejected session changes', async () => {
  const f = await fixture();
  let rejectSession = true;
  const service = createRecoveryAbandonment({ jobStore: f.jobs, stateManager: f.state, recoveryWork: f.work,
    transferSessions: { get: id => f.sessions.get(id), supersede: (id, generation) => rejectSession ? false : f.sessions.supersede(id, generation) },
    now: () => 100, getRecoveryIssueSnapshot: () => ({ issues: [] }), dispatchPersistentJobs: () => {},
  });
  try {
    const before = f.state.getStateSnapshot();
    f.work.locks.add(f.job.id);
    assert.equal(service.abandon(f.job.id, ['upload']).ok, false);
    assert.equal(f.work.locks.has(f.job.id), true);
    f.work.locks.delete(f.job.id);
    assert.equal(service.abandon(f.job.id, ['upload']).ok, false);
    assert.equal(required(f.jobs.findById(f.job.id)?.payload).awaitingManualRecovery, true);
    assert.deepEqual(f.state.getStateSnapshot(), before);
    rejectSession = false;
    assert.equal(service.abandon(f.job.id, ['upload']).ok, true);
    assert.equal(required(f.jobs.findById(f.job.id)?.payload).userDisposition, 'abandoned');
    assert.equal(f.sessions.get(f.session.id)?.phase, 'superseded');
    const repeated = service.abandon(f.job.id, ['upload']);
    assert.ok(repeated.ok && repeated.idempotent);
  } finally { await f.close(); }
});
