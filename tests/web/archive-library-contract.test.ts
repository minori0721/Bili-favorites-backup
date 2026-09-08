import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseArchiveLibraryPage,
  parseArchiveNavigation,
  parseLocalReleasePreview,
} from '../../src/shared/api/archive-library.js';
import { parsePlaybackQueuePage, parsePlaybackSearchPage } from '../../src/shared/api/playback-queue.js';

const part = { fileId: 1, pageIndex: 1, label: '正片', fingerprint: '1:0:1', streamUrl: '/media/1' };

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

test('manual archives and an unfocused empty queue preserve server sentinel values', () => {
  const empty = { mode: 'library', page: 1, pageSize: 50, total: 0, focusIndex: -1, hasMore: false, items: [] };
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
  const queue = parsePlaybackQueuePage({ mode: 'favorite', page: 1, pageSize: 50, total: 1, focusIndex: 0, hasMore: false, items: [item] });
  assert.equal(queue.items[0]?.parts[0]?.streamUrl, '/media/1');
  assert.equal(parsePlaybackSearchPage({ query: '标题', page: 1, pageSize: 50, total: 1, hasMore: false, items: [item] }).total, 1);
  assert.throws(() => parsePlaybackQueuePage({ mode: 'favorite', page: 1, pageSize: 50, total: 1, focusIndex: 0, hasMore: false, items: [{ ...item, parts: [{ ...part, fileId: '1' }] }] }));
  assert.throws(() => parsePlaybackSearchPage({ query: '标题', page: 1, pageSize: 50, total: 1, hasMore: false, items: [{ ...item, source: null }] }));
});
