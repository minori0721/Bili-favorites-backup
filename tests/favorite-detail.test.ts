import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { mergeLiveFavoriteDetailItem, selectFavoriteDetailSource } from "../src/favorite-detail.js";
import { createTestDir, removeTestDir } from "./helpers.js";

test("live favorite metadata falls back to the stored archive snapshot", () => {
  assert.equal(selectFavoriteDetailSource(true, "all"), "state");
  assert.equal(selectFavoriteDetailSource(false, "uploaded"), "state");
  assert.equal(selectFavoriteDetailSource(false, "all"), "bili");

  const merged = mergeLiveFavoriteDetailItem({
    bvid: "BVDETAILLOST",
    title: "已失效视频",
    upperName: "Unknown",
    cover: undefined,
    unavailable: true,
  }, {
    bvid: "BVDETAILLOST",
    title: "归档前标题",
    upperName: "归档 UP",
    cover: "https://example.invalid/original.jpg",
    coverLocalPath: "covers/BVDETAILLOST.jpg",
    unavailable: true,
    processed: true,
    failed: false,
    backupStatus: "verified",
    mediaId: 1,
    folderTitle: "详情测试",
    lastSeenAt: "2026-07-22T00:00:00.000Z",
    activeInFavorite: true,
  }, { mediaId: 1, folderTitle: "详情测试" });

  assert.equal(merged.title, "归档前标题");
  assert.equal(merged.upperName, "归档 UP");
  assert.equal(merged.cover, "https://example.invalid/original.jpg");
  assert.equal(merged.coverLocalPath, "covers/BVDETAILLOST.jpg");
  assert.equal(merged.backupStatus, "verified");
});
test("tracked favorite detail is served from SQLite with history and original metadata", { timeout: 60_000 }, async () => {
  const runtime = await createTestDir("favorite-detail");
  const originalCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdminPass = process.env.ADMIN_PASS;
  let server: import("node:http").Server | undefined;
  let closeAppResources: (() => Promise<void>) | undefined;
  try {
    const dataDir = path.join(runtime, "data");
    await fs.promises.mkdir(dataDir, { recursive: true });
    const now = "2026-07-22T08:30:00.000Z";
    await fs.promises.writeFile(path.join(dataDir, "users.json"), JSON.stringify([{
      id: "detail-user",
      uid: 10001,
      name: "详情测试账号",
      cookie: { SESSDATA: "invalid-test-cookie", DedeUserID: "10001" },
      favorites: [{ mediaId: 1, title: "详情测试" }],
      enabled: true,
      lastLoginAt: now,
    }]), "utf8");
    await fs.promises.writeFile(path.join(dataDir, "state.json"), JSON.stringify({
      schemaVersion: 13,
      processedByUser: {},
      failedByUser: {},
      userCooldowns: {},
      videos: {
        BVDETAILLOST: {
          bvid: "BVDETAILLOST",
          title: "已失效视频",
          upperName: "Unknown",
          firstSeenAt: "2026-07-10T00:00:00.000Z",
          lastSeenAt: now,
          biliStatus: "unavailable",
          backupStatus: "verified",
          remotePath: "/archive/BVDETAILLOST",
          remoteFiles: [{ name: "BVDETAILLOST.mp4", path: "/archive/BVDETAILLOST/BVDETAILLOST.mp4", size: 128, verificationStatus: "verified" }],
          favoriteUnavailable: true,
          originalMeta: {
            title: "归档前标题",
            upperName: "归档 UP",
            cover: "https://example.invalid/lost.jpg",
            coverLocalPath: "covers/BVDETAILLOST.jpg",
            capturedAt: "2026-07-10T00:00:00.000Z",
          },
        },
        BVDETAILACTIVE: {
          bvid: "BVDETAILACTIVE",
          title: "当前视频",
          upperName: "当前 UP",
          cover: "https://example.invalid/active.jpg",
          firstSeenAt: "2026-07-11T00:00:00.000Z",
          lastSeenAt: now,
          biliStatus: "available",
          backupStatus: "verified",
          remotePath: "/archive/BVDETAILACTIVE",
          remoteFiles: [{ name: "BVDETAILACTIVE.mp4", path: "/archive/BVDETAILACTIVE/BVDETAILACTIVE.mp4", size: 256, verificationStatus: "verified" }],
        },
        BVDETAILHISTORY: {
          bvid: "BVDETAILHISTORY",
          title: "历史待补传",
          upperName: "历史 UP",
          firstSeenAt: "2026-07-12T00:00:00.000Z",
          lastSeenAt: "2026-07-21T00:00:00.000Z",
          biliStatus: "available",
          backupStatus: "upload_failed",
        },
      },
      relations: {
        "detail-user:1:BVDETAILLOST": {
          userId: "detail-user", mediaId: 1, bvid: "BVDETAILLOST", folderTitle: "详情测试",
          firstSeenAt: "2026-07-10T00:00:00.000Z", lastSeenAt: now, favOrder: 1,
          activeInFavorite: true, backupStatus: "verified", favoriteUnavailable: true,
          remotePath: "/archive/BVDETAILLOST",
          remoteFiles: [{ name: "BVDETAILLOST.mp4", path: "/archive/BVDETAILLOST/BVDETAILLOST.mp4", size: 128, verificationStatus: "verified" }],
        },
        "detail-user:1:BVDETAILACTIVE": {
          userId: "detail-user", mediaId: 1, bvid: "BVDETAILACTIVE", folderTitle: "详情测试",
          firstSeenAt: "2026-07-11T00:00:00.000Z", lastSeenAt: now, favOrder: 2,
          activeInFavorite: true, backupStatus: "verified",
          remotePath: "/archive/BVDETAILACTIVE",
          remoteFiles: [{ name: "BVDETAILACTIVE.mp4", path: "/archive/BVDETAILACTIVE/BVDETAILACTIVE.mp4", size: 256, verificationStatus: "verified" }],
        },
        "detail-user:1:BVDETAILHISTORY": {
          userId: "detail-user", mediaId: 1, bvid: "BVDETAILHISTORY", folderTitle: "详情测试",
          firstSeenAt: "2026-07-12T00:00:00.000Z", lastSeenAt: "2026-07-21T00:00:00.000Z", favOrder: 0,
          activeInFavorite: false, backupStatus: "upload_failed",
        },
      },
      folderScans: {
        "detail-user:1": {
          userId: "detail-user", mediaId: 1, folderTitle: "详情测试", initStatus: "complete",
          nextHistoryPage: 1, catchupPage: 1, total: 2, lastScannedAt: now,
        },
      },
    }), "utf8");

    process.chdir(runtime);
    process.env.NODE_ENV = "test";
    process.env.ADMIN_PASS = "detail-pass";
    const appModule = await import("../src/index.js");
    closeAppResources = appModule.closeAppResources;
    server = appModule.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "admin", password: "detail-pass" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);

    const unauthorizedLibrary = await fetch(`${base}/api/archive-library/navigation`);
    assert.equal(unauthorizedLibrary.status, 401);
    const libraryNavigationResponse = await fetch(`${base}/api/archive-library/navigation`, { headers: { Cookie: cookie } });
    assert.equal(libraryNavigationResponse.status, 200);
    const libraryNavigation: any = await libraryNavigationResponse.json();
    assert.equal(libraryNavigation.data.summary.total, 3);
    assert.equal(libraryNavigation.data.summary.playable, 2);
    assert.equal(libraryNavigation.data.accounts[0].folders[0].title, "详情测试");

    const libraryItemsResponse = await fetch(
      `${base}/api/archive-library/items?scope=folder&userId=detail-user&mediaId=1&pageSize=2`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(libraryItemsResponse.status, 200);
    const libraryItems: any = await libraryItemsResponse.json();
    assert.deepEqual(libraryItems.data.items.map((item: any) => item.bvid), ["BVDETAILLOST", "BVDETAILACTIVE"]);
    assert.equal(libraryItems.data.hasMore, true);
    assert.equal(JSON.stringify(libraryItems).includes("/archive/"), false);
    const librarySecondResponse = await fetch(
      `${base}/api/archive-library/items?scope=folder&userId=detail-user&mediaId=1&pageSize=2&cursor=${encodeURIComponent(libraryItems.data.nextCursor)}`,
      { headers: { Cookie: cookie } }
    );
    const librarySecond: any = await librarySecondResponse.json();
    assert.equal(librarySecondResponse.status, 200);
    assert.deepEqual(librarySecond.data.items.map((item: any) => item.bvid), ["BVDETAILHISTORY"]);

    const staleCursorResponse = await fetch(
      `${base}/api/archive-library/items?scope=folder&userId=detail-user&mediaId=1&pageSize=2&filter=issue&cursor=${encodeURIComponent(libraryItems.data.nextCursor)}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(staleCursorResponse.status, 400);
    const invalidLibraryResponse = await fetch(`${base}/api/archive-library/items?scope=invalid`, { headers: { Cookie: cookie } });
    assert.equal(invalidLibraryResponse.status, 400);

    const libraryDetailResponse = await fetch(
      `${base}/api/archive-library/items/BVDETAILLOST?scope=folder&userId=detail-user&mediaId=1`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(libraryDetailResponse.status, 200);
    const libraryDetail: any = await libraryDetailResponse.json();
    assert.equal(libraryDetail.data.title, "归档前标题");
    assert.equal(libraryDetail.data.memberships.length, 1);
    assert.equal(JSON.stringify(libraryDetail).includes("/archive/"), false);

    const libraryQueueResponse = await fetch(
      `${base}/api/archive-library/playback-queue?scope=folder&userId=detail-user&mediaId=1&focusBvid=BVDETAILLOST&pageSize=50`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(libraryQueueResponse.status, 200);
    const libraryQueue: any = await libraryQueueResponse.json();
    assert.equal(libraryQueue.data.mode, "library");
    assert.deepEqual(libraryQueue.data.items.map((item: any) => item.bvid), ["BVDETAILLOST", "BVDETAILACTIVE"]);
    assert.deepEqual(libraryQueue.data.items[0].source, {
      userId: "detail-user", mediaId: 1, folderTitle: "详情测试",
    });
    assert.equal(JSON.stringify(libraryQueue).includes("/archive/"), false);

    const librarySearchResponse = await fetch(
      `${base}/api/archive-library/playback-search?scope=folder&userId=detail-user&mediaId=1&queueQ=${encodeURIComponent("归档 UP")}&pageSize=50`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(librarySearchResponse.status, 200);
    const librarySearch: any = await librarySearchResponse.json();
    assert.deepEqual(librarySearch.data.items.map((item: any) => item.bvid), ["BVDETAILLOST"]);

    const detailResponse = await fetch(`${base}/api/users/detail-user/favorites/1/detail-items?page=1&pageSize=20&filter=all`, {
      headers: { Cookie: cookie },
    });
    assert.equal(detailResponse.status, 200);
    const detailJson: any = await detailResponse.json();
    const detail = detailJson.data;
    assert.equal(detail.source, "state");
    assert.equal(detail.tracked, true);
    assert.equal(detail.coverage, "complete");
    assert.equal(detail.lastSyncedAt, now);
    assert.deepEqual(detail.items.map((item: any) => item.bvid), ["BVDETAILLOST", "BVDETAILACTIVE", "BVDETAILHISTORY"]);
    assert.equal(detail.items[0].title, "归档前标题");
    assert.equal(detail.items[0].coverLocalPath, "covers/BVDETAILLOST.jpg");
    assert.deepEqual(detail.items[0].playback, { available: true, partCount: 1, partial: false });
    assert.equal(detail.items[2].activeInFavorite, false);
    assert.equal(detail.summary.total, 3);
    assert.equal(detail.summary.activeTotal, 2);
    assert.equal(detail.summary.historicalTotal, 1);
    assert.equal(detail.summary.uploadedUnavailable, 1);
    assert.equal(detail.indexSummary.indexed, 2);
    assert.equal(detail.indexSummary.unreturnedCount, 0);

    const aliasResponse = await fetch(`${base}/api/users/detail-user/favorites/1/state-items?page=1&pageSize=20&filter=all`, {
      headers: { Cookie: cookie },
    });
    const aliasJson: any = await aliasResponse.json();
    assert.equal(aliasResponse.status, 200);
    assert.deepEqual(aliasJson.data.items.map((item: any) => item.bvid), detail.items.map((item: any) => item.bvid));
    assert.equal(aliasJson.data.source, "state");

    const unauthorizedQueue = await fetch(`${base}/api/users/detail-user/favorites/1/playback-queue?focusBvid=BVDETAILLOST`);
    assert.equal(unauthorizedQueue.status, 401);
    const unauthorizedSearch = await fetch(`${base}/api/users/detail-user/favorites/1/playback-search?q=归档`);
    assert.equal(unauthorizedSearch.status, 401);

    const queueResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback-queue?focusBvid=BVDETAILLOST&pageSize=30`, {
      headers: { Cookie: cookie },
    });
    assert.equal(queueResponse.status, 200);
    const queueJson: any = await queueResponse.json();
    assert.equal(queueJson.data.mode, "favorite");
    assert.deepEqual(queueJson.data.items.map((item: any) => item.bvid), ["BVDETAILLOST", "BVDETAILACTIVE"]);
    assert.deepEqual(queueJson.data.items.map((item: any) => item.queuePosition), [1, 2]);
    assert.equal(JSON.stringify(queueJson).includes("/archive/"), false);

    const metadataPart = queueJson.data.items[0].parts[0];
    const metadataResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback/files/${metadataPart.fileId}/media-metadata`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ fingerprint: metadataPart.fingerprint, width: 1772, height: 3840, duration: 12.5 }),
    });
    assert.equal(metadataResponse.status, 200);
    const metadataJson: any = await metadataResponse.json();
    assert.equal(metadataJson.data.actualQuality, "1772p");
    assert.deepEqual({
      width: metadataJson.data.mediaMetadata.width,
      height: metadataJson.data.mediaMetadata.height,
      source: metadataJson.data.mediaMetadata.source,
    }, { width: 1772, height: 3840, source: "browser" });

    const refreshedQueueResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback-queue?focusBvid=BVDETAILLOST&pageSize=30`, {
      headers: { Cookie: cookie },
    });
    const refreshedQueueJson: any = await refreshedQueueResponse.json();
    const refreshedPart = refreshedQueueJson.data.items[0].parts[0];
    assert.deepEqual({
      actualQuality: refreshedPart.actualQuality,
      actualWidth: refreshedPart.actualWidth,
      actualHeight: refreshedPart.actualHeight,
    }, { actualQuality: "1772p", actualWidth: 1772, actualHeight: 3840 });

    const invalidDelivery = await fetch(`${base}${queueJson.data.items[0].parts[0].streamUrl}?delivery=direct`, {
      headers: { Cookie: cookie },
    });
    assert.equal(invalidDelivery.status, 400);
    assert.equal((await invalidDelivery.json() as any).message, "Invalid playback delivery mode");

    const searchResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback-search?q=${encodeURIComponent("归档 UP")}&pageSize=50`, {
      headers: { Cookie: cookie },
    });
    assert.equal(searchResponse.status, 200);
    const searchJson: any = await searchResponse.json();
    assert.equal(searchJson.data.query, "归档 UP");
    assert.equal(searchJson.data.total, 1);
    assert.deepEqual(searchJson.data.items.map((item: any) => [item.bvid, item.queuePosition]), [["BVDETAILLOST", 1]]);
    assert.equal(JSON.stringify(searchJson).includes("/archive/"), false);

    const emptySearch = await fetch(`${base}/api/users/detail-user/favorites/1/playback-search?q=`, { headers: { Cookie: cookie } });
    assert.equal(emptySearch.status, 400);
    const oversizedSearch = await fetch(`${base}/api/users/detail-user/favorites/1/playback-search?q=test&pageSize=51`, { headers: { Cookie: cookie } });
    assert.equal(oversizedSearch.status, 400);

    const playerAsset = await fetch(`${base}/assets/vendor/artplayer-5.4.0.js`, { headers: { Cookie: cookie } });
    assert.equal(playerAsset.status, 200);
    assert.match(playerAsset.headers.get("content-type") || "", /javascript/);
    assert.match(await playerAsset.text(), /Artplayer/);

    const unavailableResponse = await fetch(`${base}/api/users/detail-user/favorites/1/detail-items?page=1&pageSize=20&filter=uploaded_unavailable`, {
      headers: { Cookie: cookie },
    });
    const unavailableJson: any = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 200);
    assert.deepEqual(unavailableJson.data.items.map((item: any) => item.bvid), ["BVDETAILLOST"]);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (closeAppResources) await closeAppResources();
    process.chdir(originalCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdminPass === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = previousAdminPass;
    await removeTestDir(runtime);
  }
});
