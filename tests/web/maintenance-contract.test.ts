import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRenamePreview, parseRenameUpdate, parseRenameResult } from '../../src/web/client/features/settings/rename-contract.js';
import { parseMigrationPreview, parseMigrationResult } from '../../src/web/client/features/settings/migration-contract.js';

test('rename boundary validates authorization identities and strips private source paths', () => {
  const candidate = {candidateId:'candidate', oldPath:'/old', newPath:'/new', sourceAccessPath:'private'};
  const data = {previewId:'preview', revision:1, expiresAt:100, candidates:[candidate]};
  const result = parseRenamePreview(data);
  assert.equal(result.candidates[0].candidateId, 'candidate');
  assert.equal('sourceAccessPath' in result.candidates[0], false);
  for (const malformed of [{...data,previewId:''}, {...data,revision:'1'}, {...data,candidates:[candidate,candidate]}, {...data,candidates:[{...candidate,candidateId:undefined}]}]) {
    assert.throws(() => parseRenamePreview(malformed));
  }
  assert.deepEqual(parseRenameUpdate({unchanged:true,remoteScan:{status:'scanning'}}), {unchanged:true,remoteScan:{status:'scanning',complete:undefined,error:''}});
  assert.throws(() => parseRenameUpdate({unchanged:true,remoteScan:{status:'ready',complete:'false'}}));
});

test('rename result retains recovery evidence without accepting malformed paths', () => {
  const result = parseRenameResult({success:0,failed:1,results:[{ok:false,status:'stranded',oldPath:'/old',newPath:'/new',actualPath:'/tmp',observedPaths:['/tmp','/old'],error:'fixture'}]});
  assert.equal(result.results[0].actualPath, '/tmp');
  assert.deepEqual(result.results[0].observedPaths, ['/tmp','/old']);
  assert.throws(() => parseRenameResult({success:0,failed:1,results:[{ok:false,observedPaths:[7]}]}));
});

test('migration preview and import results validate before enabling a restore', () => {
  assert.equal(parseMigrationPreview({manifest:{version:'fixture',counts:{users:0}},conflicts:{tempItemCount:1}}).tempItemCount,1);
  for (const malformed of [null, {}, {manifest:{counts:{users:'0'}}}, {manifest:{},conflicts:{tempItemCount:-1}}]) assert.throws(() => parseMigrationPreview(malformed));
  assert.deepEqual(parseMigrationResult({restored:['config'],backupPath:'fixture'}), {restored:['config'],backupPath:'fixture'});
  assert.throws(() => parseMigrationResult({restored:[{}]}));
});
