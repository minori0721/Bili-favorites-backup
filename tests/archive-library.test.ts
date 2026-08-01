import assert from "node:assert/strict";
import test from "node:test";
import {
  ArchiveLibraryQueryError,
  getArchiveLibraryItemDetail,
  getArchiveLibraryNavigation,
  getArchiveLibraryPlaybackQueue,
  getArchiveLibraryPlaybackSearch,
  queryArchiveLibraryItems,
} from "../src/archive-library.js";
import { StateDatabase } from "../src/database.js";
import type { BackupStatus, FavoriteRelation, RemoteFileRecord, VideoArchiveEntry } from "../src/state.js";
import type { BiliUser } from "../src/users.js";

const now = Date.parse("2026-07-28T12:00:00.000Z");

function users(): BiliUser[] {
  return [
    {
      id: "u1",
      uid: 1,
      name: "账号一",
      cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" },
      favorites: [
        { mediaId: 10, title: "正在同步" },
        { mediaId: 11, title: "空收藏夹" },
      ],
      enabled: true,
      lastLoginAt: new Date(now).toISOString(),
    },
    {
      id: "u2",
      uid: 2,
      name: "账号二",
      cookie: { SESSDATA: "two", bili_jct: "two", DedeUserID: "2" },
      favorites: [{ mediaId: 20, title: "另一个收藏夹" }],
      enabled: true,
      lastLoginAt: new Date(now).toISOString(),
    },
  ];
}

function insertArchive(
  database: StateDatabase,
  options: {
    userId: string;
    mediaId: number;
    folderTitle: string;
    bvid: string;
    title: string;
    upperName?: string;
    status: BackupStatus;
    active?: boolean;
    order?: number;
    seenOffset?: number;
    unavailable?: boolean;
    playable?: { width?: number; height?: number; fps?: number; parts?: number; quality?: string };
    error?: string;
  }
) {
  const seen = now + Number(options.seenOffset || 0);
  const existingVideo = database.db.prepare("SELECT 1 FROM videos WHERE bvid=?").get(options.bvid);
  const video: VideoArchiveEntry = {
    bvid: options.bvid,
    title: options.title,
    upperName: options.upperName || "测试UP",
    cover: `https://i0.hdslb.com/bfs/archive/${options.bvid}.jpg`,
    originalMeta: {
      title: options.title,
      upperName: options.upperName || "测试UP",
      cover: `https://i0.hdslb.com/bfs/archive/${options.bvid}.jpg`,
      coverLocalPath: `covers/${options.bvid}.webp`,
      capturedAt: new Date(seen).toISOString(),
    },
    firstSeenAt: new Date(seen).toISOString(),
    lastSeenAt: new Date(seen).toISOString(),
    biliStatus: options.unavailable ? "unavailable" : "available",
    backupStatus: options.status,
    favoriteUnavailable: options.unavailable,
  };
  if (!existingVideo) {
    database.db.prepare(`
      INSERT INTO videos(bvid,backup_status,bili_status,local_dir,access_restriction_type,access_last_checked_at,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(options.bvid, options.status, video.biliStatus, null, null, null, JSON.stringify(video), seen);
  }

  const remoteFiles: RemoteFileRecord[] = [];
  const partCount = Math.max(1, Number(options.playable?.parts || 1));
  if (options.playable) {
    for (let pageIndex = 1; pageIndex <= partCount; pageIndex += 1) {
      const remotePath = `/archive/${options.userId}/${options.mediaId}/${options.bvid}_P${pageIndex}.mp4`;
      const file: RemoteFileRecord = {
        name: `${options.bvid}_P${pageIndex}.mp4`,
        path: remotePath,
        size: 1000 + pageIndex,
        verificationStatus: "verified",
        filenameMetadata: { pageIndex, bilibiliQuality: options.playable.quality || "1080P" },
        ...(options.playable.width && options.playable.height ? {
          mediaMetadata: {
            width: options.playable.width,
            height: options.playable.height,
            fps: options.playable.fps,
            source: "ffprobe",
            observedAt: new Date(seen).toISOString(),
          },
        } : {}),
      };
      remoteFiles.push(file);
      database.db.prepare(`
        INSERT INTO remote_files(
          bvid,user_id,media_id,kind,name,remote_path,expected_size,status,quality_json,
          actual_width,actual_height,actual_fps,actual_metadata_source,actual_metadata_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        options.bvid,
        options.userId,
        options.mediaId,
        "main",
        file.name,
        remotePath,
        file.size,
        "verified",
        JSON.stringify({ quality: options.playable.quality || "1080P", encoding: "HEVC" }),
        options.playable.width || null,
        options.playable.height || null,
        options.playable.fps || null,
        options.playable.width ? "ffprobe" : null,
        options.playable.width ? seen : null,
        seen
      );
    }
  }

  const relation: FavoriteRelation = {
    userId: options.userId,
    mediaId: options.mediaId,
    bvid: options.bvid,
    folderTitle: options.folderTitle,
    firstSeenAt: new Date(seen).toISOString(),
    lastSeenAt: new Date(seen).toISOString(),
    favOrder: options.order,
    activeInFavorite: options.active !== false,
    backupStatus: options.status,
    remoteFiles,
    favoriteUnavailable: options.unavailable,
    lastError: options.error,
    verifiedAt: options.playable ? new Date(seen).toISOString() : undefined,
  };
  database.db.prepare(`
    INSERT INTO favorite_relations(
      user_id,media_id,bvid,backup_status,active_in_favorite,folder_title,fav_order,last_seen_at,
      favorite_unavailable,self_visible,payload_json,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    relation.userId,
    relation.mediaId,
    relation.bvid,
    relation.backupStatus,
    relation.activeInFavorite ? 1 : 0,
    relation.folderTitle,
    relation.favOrder ?? null,
    seen,
    relation.favoriteUnavailable ? 1 : 0,
    0,
    JSON.stringify(relation),
    seen
  );
}

function fixture() {
  const database = new StateDatabase(":memory:");
  insertArchive(database, {
    userId: "u1", mediaId: 10, folderTitle: "正在同步", bvid: "BVSHARED", title: "共享归档 100%_测试",
    upperName: "UP甲", status: "verified", order: 2, playable: { width: 1920, height: 1080, fps: 30, parts: 1 },
  });
  insertArchive(database, {
    userId: "u2", mediaId: 20, folderTitle: "另一个收藏夹", bvid: "BVSHARED", title: "共享归档 100%_测试",
    upperName: "UP甲", status: "verified", order: 1, seenOffset: 1000,
    playable: { width: 3840, height: 2160, fps: 60, parts: 2, quality: "4K" },
  });
  insertArchive(database, {
    userId: "u1", mediaId: 10, folderTitle: "正在同步", bvid: "BVCURRENT", title: "当前项目",
    upperName: "UP乙", status: "queued", order: 1, seenOffset: 2000,
  });
  insertArchive(database, {
    userId: "u1", mediaId: 10, folderTitle: "正在同步", bvid: "BVHISTORY", title: "历史可播放",
    upperName: "UP乙", status: "partial_verified", active: false, seenOffset: -1000,
    playable: { width: 1280, height: 720, fps: 30, parts: 1 },
  });
  insertArchive(database, {
    userId: "u1", mediaId: 12, folderTitle: "已经停用", bvid: "BVISSUE", title: "失效异常",
    upperName: "UP丙", status: "failed", unavailable: true, seenOffset: -2000,
    error: "failed path=/secret.mp4 token=do-not-return",
  });
  return database;
}

test("archive navigation keeps selected empty folders and exposes inactive archives", () => {
  const database = fixture();
  try {
    const navigation = getArchiveLibraryNavigation(database, users());
    assert.equal(navigation.summary.total, 4);
    assert.equal(navigation.summary.playable, 2);
    assert.equal(navigation.accounts[0].folders.length, 2);
    assert.equal(navigation.accounts[0].folders[1].title, "空收藏夹");
    assert.equal(navigation.accounts[0].folders[1].total, 0);
    assert.deepEqual(navigation.accounts[0].inactiveFolders.map((folder) => folder.title), ["已经停用"]);
    assert.deepEqual(navigation.accounts.map((account) => account.summary.total), [4, 1]);

    const emptyFolder = queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 11, pageSize: 50,
    });
    assert.deepEqual(emptyFolder.items, []);
    assert.deepEqual(emptyFolder.summary, { total: 0, playable: 0, pending: 0, issue: 0 });
    assert.equal(emptyFolder.hasMore, false);
    assert.equal(emptyFolder.nextCursor, null);

    const emptySearch = queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, query: "完全不存在的标题", pageSize: 50,
    });
    assert.deepEqual(emptySearch.items, []);
    assert.deepEqual(emptySearch.summary, { total: 0, playable: 0, pending: 0, issue: 0 });
  } finally {
    database.close();
  }
});

test("archive items deduplicate BVIDs, classify states and select the best verified source", () => {
  const database = fixture();
  try {
    const page = queryArchiveLibraryItems(database, users(), { scope: "global", pageSize: 50 });
    assert.equal(page.items.length, 4);
    assert.deepEqual(page.summary, { total: 4, playable: 2, pending: 1, issue: 1 });
    const shared = page.items.find((item) => item.bvid === "BVSHARED")!;
    assert.equal(shared.membershipCount, 2);
    assert.equal(shared.playback.source?.userId, "u2");
    assert.equal(shared.playback.partCount, 2);
    assert.equal(shared.playback.actualQuality, "2160p60");

    const pending = queryArchiveLibraryItems(database, users(), { scope: "global", filter: "pending" });
    assert.deepEqual(pending.items.map((item) => item.bvid), ["BVCURRENT"]);
    const issue = queryArchiveLibraryItems(database, users(), { scope: "global", filter: "issue" });
    assert.deepEqual(issue.items.map((item) => item.bvid), ["BVISSUE"]);
  } finally {
    database.close();
  }
});

test("folder order, keyset cursors and current-to-global search remain stable", () => {
  const database = fixture();
  try {
    const first = queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, pageSize: 1,
    });
    assert.deepEqual(first.items.map((item) => item.bvid), ["BVCURRENT"]);
    assert.equal(first.hasMore, true);
    const second = queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, pageSize: 1, cursor: first.nextCursor || undefined,
    });
    assert.deepEqual(second.items.map((item) => item.bvid), ["BVSHARED"]);
    assert.throws(() => queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, pageSize: 1,
      filter: "issue", cursor: first.nextCursor || undefined,
    }), ArchiveLibraryQueryError);

    const literal = queryArchiveLibraryItems(database, users(), {
      scope: "account", userId: "u1", query: "%_", searchScope: "current",
    });
    assert.deepEqual(literal.items.map((item) => item.bvid), ["BVSHARED"]);
    const global = queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, query: "共享 UP甲", searchScope: "global",
    });
    assert.equal(global.context.scope, "global");
    assert.equal(global.items[0].membershipCount, 2);

    for (const invalid of [
      { scope: "unknown" },
      { scope: "account", userId: "missing" },
      { scope: "folder", userId: "u1", mediaId: 0 },
      { scope: "global", searchScope: "other" },
      { scope: "global", filter: "other" },
      { scope: "global", sort: "other" },
      { scope: "global", query: "\0" },
      { scope: "global", pageSize: 51 },
    ]) {
      assert.throws(() => queryArchiveLibraryItems(database, users(), invalid as any), ArchiveLibraryQueryError);
    }
  } finally {
    database.close();
  }
});

test("archive details redact source errors and library playback preserves the filtered order", () => {
  const database = fixture();
  try {
    const detail = getArchiveLibraryItemDetail(database, users(), { scope: "global" }, "BVISSUE")!;
    assert.equal(detail.memberships.length, 1);
    assert.doesNotMatch(detail.memberships[0].error || "", /do-not-return|\/secret\.mp4/);
    assert.equal(getArchiveLibraryItemDetail(database, users(), { scope: "global", filter: "playable" }, "BVISSUE"), null);

    const queue = getArchiveLibraryPlaybackQueue(database, users(), {
      scope: "global", sort: "title_asc", filter: "all",
    }, { focusBvid: "BVSHARED", pageSize: 50 })!;
    assert.equal(queue.mode, "library");
    assert.equal(queue.total, 2);
    assert.equal(queue.items.find((item) => item.bvid === "BVSHARED")?.source.userId, "u2");

    const search = getArchiveLibraryPlaybackSearch(database, users(), {
      scope: "global", query: "可播放", searchScope: "current",
    }, { query: "历史", pageSize: 50 });
    assert.deepEqual(search.items.map((item) => item.bvid), ["BVHISTORY"]);

    database.db.prepare(`
      UPDATE remote_files SET status='missing'
      WHERE user_id='u2' AND media_id=20 AND bvid='BVSHARED'
    `).run();
    const replacement = getArchiveLibraryPlaybackQueue(database, users(), {
      scope: "global", sort: "title_asc", filter: "all",
    }, { focusBvid: "BVSHARED", pageSize: 50 })!;
    assert.equal(replacement.items.find((item) => item.bvid === "BVSHARED")?.source.userId, "u1");
  } finally {
    database.close();
  }
});

test("large archive pagination stays bounded and library indexes serve both orderings", { timeout: 60_000 }, () => {
  const database = new StateDatabase(":memory:");
  const stressUsers: BiliUser[] = Array.from({ length: 5 }, (_, index) => ({
    id: `stress-${index + 1}`,
    uid: 100 + index,
    name: `压力账号 ${index + 1}`,
    cookie: { SESSDATA: `test-${index}`, DedeUserID: String(100 + index) },
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
          biliStatus: "available",
          backupStatus: "failed",
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
            backupStatus: "failed",
          };
          insertRelation.run(
            user.id, mediaId, bvid, "failed", 1, relation.folderTitle, relation.favOrder,
            seen, 0, 0, JSON.stringify(relation), seen
          );
        }
      }
    })();

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
      SELECT bvid FROM favorite_relations
      WHERE user_id=?
      ORDER BY last_seen_at DESC,bvid,media_id
      LIMIT 51
    `).all("stress-1") as any[];
    assert.match(recentPlan.map((row) => row.detail).join("\n"), /idx_relations_library_recent/);
    const folderPlan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT bvid FROM favorite_relations
      WHERE user_id=? AND media_id=?
      ORDER BY active_in_favorite DESC,fav_order,last_seen_at DESC,bvid
      LIMIT 51
    `).all("stress-1", 100) as any[];
    assert.match(folderPlan.map((row) => row.detail).join("\n"), /idx_relations_library_folder/);
  } finally {
    database.close();
  }
});
