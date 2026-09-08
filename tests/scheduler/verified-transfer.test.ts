import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager, type LocalCleanupPlan } from '../../src/state.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { commitVerifiedTransfer, type VerifiedTransferCommit } from '../../src/scheduler/verified-transfer.js';
import { createTestDir, removeTestDir } from '../helpers.js';

test('verified transfer rolls back session, in-memory archive and cleanup permission when lease ownership changes', async () => {
  const directory = await createTestDir('verified-transfer-atomic');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  try {
    const bvid = 'BVATOMIC', now = '2026-09-07T00:00:00.000Z';
    state.replaceStateSnapshot({schemaVersion:13,processedByUser:{},failedByUser:{},folderScans:{},userCooldowns:{},relations:{},
      videos:{[bvid]:{bvid,title:'Atomic',upperName:'Fixture',firstSeenAt:now,lastSeenAt:now,biliStatus:'available',backupStatus:'downloaded',localDir:directory}}});
    const jobs = new PersistentJobStore(state.getDatabase());
    const sessions = new TransferSessionStore(state.getDatabase());
    const job = jobs.enqueue({kind:'upload',dedupeKey:'atomic',bvid});
    assert.ok(jobs.claimByDedupeKey('atomic','actual-owner'));
    const session = sessions.ensure({dedupeKey:'atomic',bvid,localDir:directory,remotePath:'/backup'});
    const file = sessions.ensureFile(session.id,{relativePath:'video.mp4',name:'video.mp4',expectedSize:12},session.generation);
    assert.ok(file);
    sessions.updateFile(session.id,'video.mp4',{status:'verified'},session.generation);
    const cleanupPlan: LocalCleanupPlan = {id:'cleanup',localDir:directory,manifestSessionId:'manifest',reason:'upload_verified',createdAt:now,
      transferSessionId:session.id,transferGeneration:session.generation,
      files:[{relativePath:'video.mp4',expectedSize:12,expectedIdentity:{dev:1,ino:1,mtimeMs:1,ctimeMs:1},remotePaths:[file.finalPath]}]};
    const command: VerifiedTransferCommit = {bvid,jobId:job.id,partialBackup:false,historyOnly:false,cleanupPlan,
      result:{remotePath:'/backup',allVerified:true,sessionId:session.id,sessionGeneration:session.generation,
        files:[{name:'video.mp4',path:file.finalPath,size:12,verificationStatus:'verified'}]}};
    const dependencies = {state,sessions,jobs,now:() => Date.parse(now),leaseOwner:'old-owner'};
    assert.throws(() => commitVerifiedTransfer(dependencies,command),/ownership changed/);
    assert.notEqual(sessions.get(session.id)?.phase,'completed');
    assert.equal(state.getStateSnapshot().videos?.[bvid]?.backupStatus,'downloaded');
    assert.equal(jobs.findById(job.id)?.payload.localCleanupPlans,undefined);
    commitVerifiedTransfer({...dependencies,leaseOwner:'actual-owner'},command);
    assert.equal(sessions.get(session.id)?.phase,'completed');
    assert.equal(state.getStateSnapshot().videos?.[bvid]?.backupStatus,'verified');
    assert.equal(jobs.findById(job.id)?.payload.localCleanupPlans.length,1);
    assert.equal(jobs.findById(job.id)?.status,'completed');
  } finally { state.close(); await removeTestDir(directory); }
});
