import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseArchiveLibraryPage,
  parseArchiveNavigation,
  parseArchiveReferenceStats,
  parseLocalReleasePreview,
  parseArchiveDeletion,
} from '../../src/shared/api/archive-library.js';
import { parsePlaybackQueuePage, parsePlaybackSearchPage } from '../../src/shared/api/playback-queue.js';
import {archiveDeletionProgressText} from '../../src/web/client/shared/archive-deletion.js';

const part = { fileId: 1, pageIndex: 1, label: '正片', fingerprint: '1:0:1', streamUrl: '/media/1' };

test('cleanup outcome distinguishes deleted, already absent and shared files and keeps old responses honest',()=>{
  const operation={id:'cleanup',status:'completed',fileCount:3,completedCount:3,retainedCount:1};
  const old=parseArchiveDeletion(operation);
  assert.equal(old.deletedCount,undefined);assert.equal(old.missingCount,undefined);
  assert.doesNotMatch(archiveDeletionProgressText(old),/已删除/);
  const current=parseArchiveDeletion({...operation,deletedCount:1,missingCount:1});
  assert.match(archiveDeletionProgressText(current),/已删除 1 个文件/);
  assert.match(archiveDeletionProgressText(current),/原本不存在 1 个/);
  assert.match(archiveDeletionProgressText(current),/共享保留 1 个文件/);
  for(const invalid of [-1,1.5,'1',Infinity,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>parseArchiveDeletion({...operation,deletedCount:invalid,missingCount:0}));
    assert.throws(()=>parseArchiveDeletion({...operation,deletedCount:0,missingCount:invalid}));
  }
});

test('on-demand statistics require a complete, consistent integer pair including valid zero',()=>{
  assert.deepEqual(parseArchiveReferenceStats({sourceReferenceCount:0,uniqueRemotePathCount:0}),{sourceReferenceCount:0,uniqueRemotePathCount:0});
  for(const value of [null,{}, {sourceReferenceCount:1}, {sourceReferenceCount:1,uniqueRemotePathCount:2},
    {sourceReferenceCount:-1,uniqueRemotePathCount:0},{sourceReferenceCount:'1',uniqueRemotePathCount:1},
    {sourceReferenceCount:1.5,uniqueRemotePathCount:1},{sourceReferenceCount:Infinity,uniqueRemotePathCount:1}])assert.throws(()=>parseArchiveReferenceStats(value));
});

test('directory artwork and cleanup fields remain optional for older responses and reject malformed values',()=>{
  const summary={total:0,playable:0,pending:0,issue:0};
  const folder={...summary,mediaId:10,title:'Folder'};
  const nav=(entry:unknown)=>({summary,accounts:[{id:'owner',name:'Account',uid:1,summary,folders:[entry],inactiveFolders:[]}]});
  assert.equal(parseArchiveNavigation(nav(folder)).accounts[0].folders[0].artworkUrl,undefined);
  const current={...folder,artworkUrl:'/api/archive-library/artwork?userId=owner&mediaId=10',deletion:{id:'op',status:'running',fileCount:2,completedCount:1}};
  assert.equal(parseArchiveNavigation(nav(current)).accounts[0].folders[0].deletion?.completedCount,1);
  assert.throws(()=>parseArchiveNavigation(nav({...folder,artworkUrl:123})));
  assert.throws(()=>parseArchiveNavigation(nav({...folder,uid:'1'})));
  assert.throws(()=>parseArchiveNavigation(nav({...current,deletion:{...current.deletion,fileCount:-1}})));
});

test('deletion progress accepts persistent epoch timestamps and historical ISO projections', () => {
  const operation = { id: 'cleanup', status: 'completed', fileCount: 1, completedCount: 1 };
  for (const time of [0, 1792929600000, '2026-10-25T12:00:00.000Z']) {
    const parsed = parseArchiveDeletion({ ...operation, updatedAt: time, completedAt: time });
    assert.equal(parsed.updatedAt, time);
    assert.equal(parsed.completedAt, time);
  }
  assert.equal(parseArchiveDeletion(operation).completedAt, undefined);
  for (const time of [-1, 1.5, Infinity, 8.64e15 + 1, 'invalid', true, {}]) {
    assert.throws(() => parseArchiveDeletion({ ...operation, updatedAt: time }), /时间/);
    assert.throws(() => parseArchiveDeletion({ ...operation, completedAt: time }), /时间/);
  }
});

test('archive navigation accepts numeric server UIDs and rejects invalid identifiers', () => {
  const account = { id: 'user', folders: [], inactiveFolders: [] };
  for (const uid of [0, 342080505, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseArchiveNavigation({ accounts: [{ ...account, uid }] }).accounts[0].uid, uid);
  }
  for (const uid of ['342080505', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, true]) {
    assert.throws(() => parseArchiveNavigation({ accounts: [{ ...account, uid }] }), /UID/);
  }
});

test('local release accepts optional proof metadata without inferring proof from missing data', () => {
  const candidate = { releaseId: 'reviewed-plan', fileCount: 1, totalBytes: 20, requiresExplicitDeletion: false };
  assert.equal(parseLocalReleasePreview({ fileCount: 1, candidates: [candidate] }).candidates[0].hasVerifiedArchive, false);
  assert.equal(parseLocalReleasePreview({ fileCount: 1, candidates: [{ ...candidate, hasVerifiedArchive: true }] }).candidates[0].hasVerifiedArchive, true);
  for (const patch of [{ hasVerifiedArchive: 'true' }, { requiresExplicitDeletion: undefined }, { releaseId: '' }]) {
    assert.throws(() => parseLocalReleasePreview({ fileCount: 1, candidates: [{ ...candidate, ...patch }] }));
  }
});
const item = {
  bvid: 'BVfixture', title: '标题', upperName: 'UP', unavailable: false,
  memberships: [], playback: { available: true, partCount: 1, partial: false },
  parts: [part], queuePosition: 1,
  source: { userId: 'user', mediaId: 1, folderTitle: '收藏夹' },
};

test('archive and playback reject missing evidence and duplicate rows while preserving explicit partial playback', () => {
  assert.throws(() => parseArchiveLibraryPage({items: [{...item, playback: undefined}], hasMore: false}));
  assert.throws(() => parseArchiveLibraryPage({items: [item, item], hasMore: false}));
  const base = {mode: 'favorite' as const, page: 1, pageSize: 50, total: 1, focusIndex: 0, hasMore: false};
  assert.throws(() => parsePlaybackQueuePage({...base, items: [item, item]}));
  assert.throws(() => parsePlaybackQueuePage({...base, items: [{...item, parts: [part, part]}]}));
  assert.equal(parsePlaybackQueuePage({...base, items: [{...item, partial: true}]}).items[0].partial, true);
});

test('manual archives and an unfocused empty queue preserve server sentinel values', () => {
  const empty = { mode: 'library' as const, page: 1, pageSize: 50, total: 0, focusIndex: -1, hasMore: false, items: [] };
  assert.equal(parsePlaybackQueuePage(empty).focusIndex, -1);
  const manual = { ...item, source: { userId: 'user', mediaId: -1 } };
  assert.equal(parsePlaybackQueuePage({ ...empty, total: 1, items: [manual] }).items[0].source.mediaId, -1);
  const page = parseArchiveLibraryPage({ items: [{ ...item, memberships: [{ userId: 'user', mediaId: -1 }] }], hasMore: false });
  assert.equal(page.items[0].memberships[0].mediaId, -1);
  const nav = parseArchiveNavigation({ accounts: [{ id: 'user', folders: [{ mediaId: -1, title: '手动归档' }], inactiveFolders: [] }] });
  assert.equal(nav.accounts[0].folders[0].mediaId, -1);
  for (const invalid of [{ focusIndex: -2 }, { page: 0 }, { pageSize: 0 }, { focusIndex: 0.5 }]) {
    assert.throws(() => parsePlaybackQueuePage({ ...empty, ...invalid }));
  }
  for (const membership of [{ folderTitle: '缺失身份' }, { userId: 'user', mediaId: -2 }]) {
    assert.throws(() => parseArchiveLibraryPage({ items: [{ ...item, memberships: [membership] }], hasMore: false }));
  }
});

test('archive library boundaries validate pagination and navigation before state mutation', () => {
  const page = parseArchiveLibraryPage({ items: [{ ...item, memberships: [] }], hasMore: true, nextCursor: 'next' });
  assert.equal(page.items[0]?.bvid, 'BVfixture');
  assert.equal(parseArchiveNavigation({ summary: {}, accounts: [] }).accounts.length, 0);
  assert.throws(() => parseArchiveLibraryPage({ items: [], hasMore: true }));
  assert.throws(() => parseArchiveNavigation({ summary: {}, accounts: [{ id: 'u', folders: 'bad', inactiveFolders: [] }] }));
});

test('playback boundaries reject malformed parts and preserve queue/search contracts', () => {
  const queue = parsePlaybackQueuePage({ mode: 'favorite' as const, page: 1, pageSize: 50, total: 1, focusIndex: 0, hasMore: false, items: [item] });
  assert.equal(queue.items[0]?.parts[0]?.streamUrl, '/media/1');
  assert.equal(parsePlaybackSearchPage({ query: '标题', page: 1, pageSize: 50, total: 1, hasMore: false, items: [item] }).total, 1);
  assert.throws(() => parsePlaybackQueuePage({ mode: 'favorite' as const, page: 1, pageSize: 50, total: 1, focusIndex: 0, hasMore: false, items: [{ ...item, parts: [{ ...part, fileId: '1' }] }] }));
  assert.throws(() => parsePlaybackSearchPage({ query: '标题', page: 1, pageSize: 50, total: 1, hasMore: false, items: [{ ...item, source: null }] }));
});


test('reference statistics reject malformed partial values and preserve older response absence', () => {
  const parse = (summary: unknown) => parseArchiveNavigation({summary, accounts: []}).summary;
  assert.equal(parse({}).sourceReferenceCount, undefined);
  assert.equal(parse({sourceReferenceCount: 2, uniqueRemotePathCount: 1}).uniqueRemotePathCount, 1);
  for (const summary of [
    {sourceReferenceCount: 2}, {uniqueRemotePathCount: 1},
    {sourceReferenceCount: null, uniqueRemotePathCount: null},
    {sourceReferenceCount: 1, uniqueRemotePathCount: 2},
    {sourceReferenceCount: 1.5, uniqueRemotePathCount: 1},
    {sourceReferenceCount: '2', uniqueRemotePathCount: 1},
    {sourceReferenceCount: -1, uniqueRemotePathCount: 0},
  ]) assert.throws(() => parse(summary), /引用统计/);
});
