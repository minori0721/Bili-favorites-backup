import assert from 'node:assert/strict';
import test from 'node:test';
import { StateDatabase } from '../../src/database.js';
import { queryArchiveLibraryItems } from '../../src/archive-library.js';
import type { FavoriteRelation, VideoArchiveEntry } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import { readField } from '../contract-values.js';
const now = Date.parse('2026-07-28T12:00:00.000Z');

test("large archive pagination stays bounded and library indexes serve both orderings", { timeout: 60_000 }, () => {
  const database = new StateDatabase(":memory:");
  const stressUsers: BiliUser[] = Array.from({ length: 5 }, (_, index) => ({
    id: `stress-${index + 1}`,
    uid: 100 + index,
    name: `压力账号 ${index + 1}`,
    cookie: { bili_jct: '', SESSDATA: `test-${index}`, DedeUserID: String(100 + index) },
    favorites: [{ mediaId: 100 + index, title: `压力收藏夹 ${index + 1}` }],
    enabled: true,
    lastLoginAt: new Date(now).toISOString(),
  }));
  try {
    const insertVideo = database.db.prepare(`
      INSERT INTO videos(bvid,backup_status,bili_status,local_dir,access_restriction_type,access_last_checked_at,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
    `);
    const insertRelation = database.db.prepare(`
      INSERT INTO favorite_relations(
        user_id,media_id,bvid,backup_status,active_in_favorite,folder_title,fav_order,last_seen_at,
        favorite_unavailable,self_visible,payload_json,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    database.db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const bvid = `BVSTRESS${String(index).padStart(5, "0")}`;
        const seen = now + index;
        const video: VideoArchiveEntry = {
          bvid,
          title: `压力视频 ${String(index).padStart(5, "0")}`,
          upperName: `UP ${index % 23}`,
          firstSeenAt: new Date(seen).toISOString(),
          lastSeenAt: new Date(seen).toISOString(),
          biliStatus: "available" as const,
          backupStatus: "failed" as const,
        };
        insertVideo.run(bvid, "failed", "available", null, null, null, JSON.stringify(video), seen);
        for (let userIndex = 0; userIndex < stressUsers.length; userIndex += 1) {
          const user = stressUsers[userIndex];
          const mediaId = 100 + userIndex;
          const relation: FavoriteRelation = {
            userId: user.id,
            mediaId,
            bvid,
            folderTitle: `压力收藏夹 ${userIndex + 1}`,
            firstSeenAt: new Date(seen).toISOString(),
            lastSeenAt: new Date(seen).toISOString(),
            favOrder: index + 1,
            activeInFavorite: true,
            backupStatus: "failed" as const,
          };
          insertRelation.run(
            user.id, mediaId, bvid, "failed", 1, relation.folderTitle, relation.favOrder,
            seen, 0, 0, JSON.stringify(relation), seen
          );
        }
      }
    })();
    database.rebuildArchiveLibraryProjection();

    const seenBvids = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = queryArchiveLibraryItems(database, stressUsers, {
        scope: "global", filter: "issue", pageSize: 50, cursor,
      });
      pages += 1;
      assert.ok(page.items.length <= 50);
      for (const item of page.items) {
        assert.equal(seenBvids.has(item.bvid), false);
        seenBvids.add(item.bvid);
      }
      if (pages === 1) assert.deepEqual(page.summary, { total: 10_000, playable: 0, pending: 0, issue: 10_000 });
      cursor = page.nextCursor || undefined;
      if (!page.hasMore) break;
    } while (pages < 250);
    assert.equal(pages, 200);
    assert.equal(seenBvids.size, 10_000);

    const recentPlan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT bvid FROM archive_library_projection
      WHERE scope_type='global' AND scope_id='' AND visibility='normal' AND status_group='issue'
      ORDER BY recent_key DESC,bvid
      LIMIT 51
    `).all() as unknown[];
    const recentDetails = recentPlan.map((row) => readField(row, 'detail')).join("\n");
    assert.match(recentDetails, /idx_archive_library_projection_status_recent/);
    assert.doesNotMatch(recentDetails, /USE TEMP B-TREE|MATERIALIZE/i);
    const titlePlan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT bvid FROM archive_library_projection
      WHERE scope_type='account' AND scope_id='stress-1' AND visibility='normal' AND status_group='issue'
      ORDER BY title_key ASC,bvid
      LIMIT 51
    `).all() as unknown[];
    assert.match(titlePlan.map((row) => readField(row, 'detail')).join("\n"), /idx_archive_library_projection_status_title_asc/);
    const folderPlan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT bvid FROM favorite_relations
      WHERE user_id=? AND media_id=?
      ORDER BY active_in_favorite DESC,fav_order,last_seen_at DESC,bvid
      LIMIT 51
    `).all("stress-1", 100) as unknown[];
    assert.match(folderPlan.map((row) => readField(row, 'detail')).join("\n"), /idx_relations_library_folder/);
  } finally {
    database.close();
  }
});
