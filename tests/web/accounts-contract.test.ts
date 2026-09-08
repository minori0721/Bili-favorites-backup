import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicAccounts, parseFavoriteFolders } from '../../src/shared/api/accounts.js';
import { parseRemovalPreview, parseRemovalOperation, parseRemovalResult } from '../../src/web/client/features/accounts/removal-contract.js';

test('public account boundaries retain display data without forwarding credential fields', () => {
  const [account] = parsePublicAccounts([{id:'u1',name:'Owner',uid:1,enabled:true,cookie:{SESSDATA:'fixture'},refreshToken:'fixture',
    favorites:[{mediaId:7,title:'Videos'}],authHealth:{level:'good',autoRefreshEnabled:true}}]);
  assert.equal(account.favorites[0].mediaId,7);
  assert.equal('cookie' in account,false);
  assert.equal('refreshToken' in account,false);
  assert.throws(() => parsePublicAccounts([{id:'u1',enabled:'yes'}]));
  assert.throws(() => parsePublicAccounts([{id:'u1',authHealth:[]} ]));
  assert.throws(() => parseFavoriteFolders([{mediaId:'7'}]));
  assert.throws(() => parseFavoriteFolders([{mediaId:-1}]));
});

test('destructive account previews require an identifier and finite nonnegative counts', () => {
  assert.equal(parseRemovalPreview({previewId:'preview',fileCount:3}).fileCount,3);
  for (const value of [{fileCount:3},{previewId:'preview',totalBytes:-1},{previewId:'preview',fileCount:Infinity}]) assert.throws(() => parseRemovalPreview(value));
  assert.throws(() => parseRemovalOperation({status:'pending'}));
  assert.equal(parseRemovalOperation({id:'operation',status:'pending'}).id,'operation');
});

test('account deletion submission accepts an operation reference while polling requires status', () => {
  assert.deepEqual(parseRemovalResult({operation:{id:'cleanup'}}),{operation:{id:'cleanup'}});
  assert.deepEqual(parseRemovalResult({}),{operation:undefined});
  assert.throws(()=>parseRemovalResult({operation:{}}));
  assert.throws(()=>parseRemovalOperation({id:'cleanup'}));
});
