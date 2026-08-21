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
  database.rebuildArchiveLibraryProjection();
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
    database.refreshArchiveLibraryProjection(["BVSHARED"]);
    const replacement = getArchiveLibraryPlaybackQueue(database, users(), {
      scope: "global", sort: "title_asc", filter: "all",
    }, { focusBvid: "BVSHARED", pageSize: 50 })!;
    assert.equal(replacement.items.find((item) => item.bvid === "BVSHARED")?.source.userId, "u1");
  } finally {
    database.close();
  }
});

test("projection keeps normal and deleted visibility independent across shared sources", () => {
  const database = fixture();
  try {
    database.db.prepare(`
      INSERT INTO archive_deletions(
        id,scope,user_id,media_id,bvid,status,alist_identity_hash,archive_root,
        file_count,total_bytes,created_at,updated_at,completed_at
      ) VALUES('projection-delete','source','u1',10,'BVSHARED','completed','test','/archive',1,1001,?,?,?)
    `).run(now, now, now);
    database.db.prepare(`
      INSERT INTO archive_deleted_sources(
        user_id,media_id,bvid,deletion_id,status,file_count,total_bytes,deleted_at
      ) VALUES('u1',10,'BVSHARED','projection-delete','completed',1,1001,?)
    `).run(now);
    database.refreshArchiveLibraryProjection(["BVSHARED"]);

    const normal = queryArchiveLibraryItems(database, users(), { scope: "global" });
    assert.equal(normal.items.find((item) => item.bvid === "BVSHARED")?.membershipCount, 1);
    assert.equal(normal.items.find((item) => item.bvid === "BVSHARED")?.memberships[0].userId, "u2");
    const deleted = queryArchiveLibraryItems(database, users(), { scope: "global", filter: "deleted" });
    assert.equal(deleted.items.find((item) => item.bvid === "BVSHARED")?.memberships[0].userId, "u1");
    assert.equal(queryArchiveLibraryItems(database, users(), {
      scope: "account", userId: "u1", filter: "all",
    }).items.some((item) => item.bvid === "BVSHARED"), false);

    database.db.prepare(`
      UPDATE archive_deleted_sources SET status='restored', restored_at=?
      WHERE deletion_id='projection-delete'
    `).run(now + 1);
    database.refreshArchiveLibraryProjection(["BVSHARED"]);
    assert.equal(queryArchiveLibraryItems(database, users(), {
      scope: "account", userId: "u1", filter: "all",
    }).items.some((item) => item.bvid === "BVSHARED"), true);
  } finally {
    database.close();
  }
});

test("failed or running archive cleanup remains visible in the normal library", () => {
  const database = fixture();
  try {
    database.db.prepare(`
      INSERT INTO archive_deletions(
        id,scope,user_id,media_id,bvid,status,alist_identity_hash,archive_root,
        file_count,total_bytes,created_at,updated_at
      ) VALUES('projection-failed','source','u1',10,'BVSHARED','failed','test','/archive',1,1001,?,?)
    `).run(now, now);
    database.db.prepare(`
      INSERT INTO archive_deleted_sources(
        user_id,media_id,bvid,deletion_id,status,file_count,total_bytes,deleted_at
      ) VALUES('u1',10,'BVSHARED','projection-failed','failed',1,1001,?)
    `).run(now);
    database.refreshArchiveLibraryProjection(["BVSHARED"]);

    const normal = queryArchiveLibraryItems(database, users(), { scope: "global" });
    const item = normal.items.find((entry) => entry.bvid === "BVSHARED")!;
    assert.equal(item.statusGroup, "playable");
    assert.equal(item.memberships.length, 2);
    assert.equal(item.memberships.find((membership) => membership.userId === "u1")?.deletionStatus, "failed");
    assert.equal(queryArchiveLibraryItems(database, users(), { scope: "global", filter: "deleted" }).items.some((entry) => entry.bvid === "BVSHARED"), false);
  } finally {
    database.close();
  }
});

test("historical folder pagination preserves every row without unsafe integer cursor loss", () => {
  const database = new StateDatabase(":memory:");
  try {
    for (let index = 0; index < 121; index += 1) {
      insertArchive(database, {
        userId: "u1",
        mediaId: 10,
        folderTitle: "正在同步",
        bvid: `BVHIST${String(index).padStart(4, "0")}`,
        title: `历史视频 ${index}`,
        status: "failed",
        active: false,
        seenOffset: index,
      });
    }
    database.db.prepare(`
      UPDATE favorite_relations SET fav_order=9223372036854775807
      WHERE bvid='BVHIST0000'
    `).run();

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = queryArchiveLibraryItems(database, users(), {
        scope: "folder", userId: "u1", mediaId: 10, pageSize: 17, cursor,
      });
      seen.push(...page.items.map((item) => item.bvid));
      cursor = page.nextCursor || undefined;
      if (!page.hasMore) break;
    } while (seen.length < 200);
    assert.equal(seen.length, 121);
    assert.equal(new Set(seen).size, 121);
    assert.deepEqual(seen.slice(0, 3), ["BVHIST0120", "BVHIST0119", "BVHIST0118"]);

    const first = queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, pageSize: 17,
    });
    const stale = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    stale.v = 1;
    delete stale.k;
    stale.o = 9223372036854776000;
    assert.throws(() => queryArchiveLibraryItems(database, users(), {
      scope: "folder", userId: "u1", mediaId: 10, pageSize: 17,
      cursor: Buffer.from(JSON.stringify(stale)).toString("base64url"),
    }), (error: any) => error?.code === "ARCHIVE_CURSOR_STALE");
  } finally {
    database.close();
  }
});

test("library playback locates focus without a window scan and pages in both directions with cursors", () => {
  const database = new StateDatabase(":memory:");
  try {
    for (let index = 0; index < 125; index += 1) {
      insertArchive(database, {
        userId: "u1",
        mediaId: 10,
        folderTitle: "正在同步",
        bvid: `BVQUEUE${String(index).padStart(4, "0")}`,
        title: `队列视频 ${String(index).padStart(4, "0")}`,
        status: "verified",
        order: index,
        seenOffset: index,
        playable: { width: 1920, height: 1080, fps: 30 },
      });
    }
    database.rebuildArchiveLibraryProjection();
    const context = { scope: "global" as const, sort: "context" as const };
    const focused = getArchiveLibraryPlaybackQueue(database, users(), context, {
      focusBvid: "BVQUEUE0062", pageSize: 25,
    })!;
    assert.equal(focused.page, 3);
    assert.equal(focused.focusIndex, 62);
    assert.equal(focused.items[0].queuePosition, 51);
    assert.equal(focused.items.at(-1)?.queuePosition, 75);
    assert.equal(focused.hasPrevious, true);
    assert.equal(focused.hasMore, true);
    assert.ok(focused.previousCursor);
    assert.ok(focused.nextCursor);

    const previous = getArchiveLibraryPlaybackQueue(database, users(), context, {
      page: 2, pageSize: 25, cursor: focused.previousCursor!, direction: "before",
    })!;
    const next = getArchiveLibraryPlaybackQueue(database, users(), context, {
      page: 4, pageSize: 25, cursor: focused.nextCursor!, direction: "after",
    })!;
    assert.deepEqual([previous.items[0].queuePosition, previous.items.at(-1)?.queuePosition], [26, 50]);
    assert.deepEqual([next.items[0].queuePosition, next.items.at(-1)?.queuePosition], [76, 100]);
    assert.equal(new Set([...previous.items, ...focused.items, ...next.items].map((item) => item.bvid)).size, 75);

    const legacy = getArchiveLibraryPlaybackQueue(database, users(), context, { page: 5, pageSize: 25 })!;
    assert.deepEqual([legacy.items[0].queuePosition, legacy.items.at(-1)?.queuePosition], [101, 125]);
    assert.equal(legacy.hasMore, false);
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
    `).all() as any[];
    const recentDetails = recentPlan.map((row) => row.detail).join("\n");
    assert.match(recentDetails, /idx_archive_library_projection_status_recent/);
    assert.doesNotMatch(recentDetails, /USE TEMP B-TREE|MATERIALIZE/i);
    const titlePlan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT bvid FROM archive_library_projection
      WHERE scope_type='account' AND scope_id='stress-1' AND visibility='normal' AND status_group='issue'
      ORDER BY title_key ASC,bvid
      LIMIT 51
    `).all() as any[];
    assert.match(titlePlan.map((row) => row.detail).join("\n"), /idx_archive_library_projection_status_title_asc/);
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
