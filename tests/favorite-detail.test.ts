import { readField, required, readArray, readString } from './contract-values.js';
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
    backupStatus: "verified" as const,
    playback: { available: false, partCount: 0, partial: false, reason: "not_verified" as const },
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
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdminPass = process.env.ADMIN_PASS;
  const previousTestAppRoot = process.env.BFB_TEST_APP_ROOT;
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
      cookie: { bili_jct: '', SESSDATA: "invalid-test-cookie", DedeUserID: "10001" },
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
          biliStatus: "unavailable" as const,
          backupStatus: "verified" as const,
          remotePath: "/archive/BVDETAILLOST",
          remoteFiles: [{ name: "BVDETAILLOST.mp4", path: "/archive/BVDETAILLOST/BVDETAILLOST.mp4", size: 128, verificationStatus: "verified" as const }],
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
          biliStatus: "available" as const,
          backupStatus: "verified" as const,
          remotePath: "/archive/BVDETAILACTIVE",
          remoteFiles: [{ name: "BVDETAILACTIVE.mp4", path: "/archive/BVDETAILACTIVE/BVDETAILACTIVE.mp4", size: 256, verificationStatus: "verified" as const }],
        },
        BVDETAILHISTORY: {
          bvid: "BVDETAILHISTORY",
          title: "历史待补传",
          upperName: "历史 UP",
          firstSeenAt: "2026-07-12T00:00:00.000Z",
          lastSeenAt: "2026-07-21T00:00:00.000Z",
          biliStatus: "available" as const,
          backupStatus: "upload_failed" as const,
        },
      },
      relations: {
        "detail-user:1:BVDETAILLOST": {
          userId: "detail-user", mediaId: 1, bvid: "BVDETAILLOST", folderTitle: "详情测试",
          firstSeenAt: "2026-07-10T00:00:00.000Z", lastSeenAt: now, favOrder: 1,
          activeInFavorite: true, backupStatus: "verified" as const, favoriteUnavailable: true,
          remotePath: "/archive/BVDETAILLOST",
          remoteFiles: [{ name: "BVDETAILLOST.mp4", path: "/archive/BVDETAILLOST/BVDETAILLOST.mp4", size: 128, verificationStatus: "verified" as const }],
        },
        "detail-user:1:BVDETAILACTIVE": {
          userId: "detail-user", mediaId: 1, bvid: "BVDETAILACTIVE", folderTitle: "详情测试",
          firstSeenAt: "2026-07-11T00:00:00.000Z", lastSeenAt: now, favOrder: 2,
          activeInFavorite: true, backupStatus: "verified" as const,
          remotePath: "/archive/BVDETAILACTIVE",
          remoteFiles: [{ name: "BVDETAILACTIVE.mp4", path: "/archive/BVDETAILACTIVE/BVDETAILACTIVE.mp4", size: 256, verificationStatus: "verified" as const }],
        },
        "detail-user:1:BVDETAILHISTORY": {
          userId: "detail-user", mediaId: 1, bvid: "BVDETAILHISTORY", folderTitle: "详情测试",
          firstSeenAt: "2026-07-12T00:00:00.000Z", lastSeenAt: "2026-07-21T00:00:00.000Z", favOrder: 0,
          activeInFavorite: false, backupStatus: "upload_failed" as const,
        },
      },
      folderScans: {
        "detail-user:1": {
          userId: "detail-user", mediaId: 1, folderTitle: "详情测试", initStatus: "complete",
          nextHistoryPage: 1, catchupPage: 1, total: 2, lastScannedAt: now,
        },
      },
    }), "utf8");

    process.env.NODE_ENV = "test";
    process.env.BFB_TEST_APP_ROOT = runtime;
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
    const cookie = required(login.headers.get("set-cookie")?.split(";", 1))[0];
    assert.ok(cookie);

    const unauthorizedLibrary = await fetch(`${base}/api/archive-library/navigation`);
    assert.equal(unauthorizedLibrary.status, 401);
    const libraryNavigationResponse = await fetch(`${base}/api/archive-library/navigation`, { headers: { Cookie: cookie } });
    assert.equal(libraryNavigationResponse.status, 200);
    const libraryNavigation: unknown = await libraryNavigationResponse.json();
    assert.equal(readField(readField(readField(libraryNavigation, 'data'), 'summary'), 'total'), 3);
    assert.equal(readField(readField(readField(libraryNavigation, 'data'), 'summary'), 'playable'), 2);
    assert.equal(readField(libraryNavigation, 'data', 'accounts', 0, 'folders', 0, 'title'), "详情测试");

    const libraryItemsResponse = await fetch(
      `${base}/api/archive-library/items?scope=folder&userId=detail-user&mediaId=1&pageSize=2`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(libraryItemsResponse.status, 200);
    const libraryItems: unknown = await libraryItemsResponse.json();
    assert.deepEqual(readArray(readField(readField(libraryItems, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILLOST", "BVDETAILACTIVE"]);
    assert.equal(readField(readField(libraryItems, 'data'), 'hasMore'), true);
    assert.equal(JSON.stringify(libraryItems).includes("/archive/"), false);
    const librarySecondResponse = await fetch(
      `${base}/api/archive-library/items?scope=folder&userId=detail-user&mediaId=1&pageSize=2&cursor=${encodeURIComponent(readString(readField(libraryItems, 'data', 'nextCursor')))}`,
      { headers: { Cookie: cookie } }
    );
    const librarySecond: unknown = await librarySecondResponse.json();
    assert.equal(librarySecondResponse.status, 200);
    assert.deepEqual(readArray(readField(readField(librarySecond, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILHISTORY"]);

    const staleCursorResponse = await fetch(
      `${base}/api/archive-library/items?scope=folder&userId=detail-user&mediaId=1&pageSize=2&filter=issue&cursor=${encodeURIComponent(readString(readField(libraryItems, 'data', 'nextCursor')))}`,
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
    const libraryDetail: unknown = await libraryDetailResponse.json();
    assert.equal(readField(readField(libraryDetail, 'data'), 'title'), "归档前标题");
    assert.equal(readArray(readField(readField(libraryDetail, 'data'), 'memberships')).length, 1);
    assert.equal(JSON.stringify(libraryDetail).includes("/archive/"), false);

    const libraryQueueResponse = await fetch(
      `${base}/api/archive-library/playback-queue?scope=folder&userId=detail-user&mediaId=1&focusBvid=BVDETAILLOST&pageSize=50`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(libraryQueueResponse.status, 200);
    const libraryQueue: unknown = await libraryQueueResponse.json();
    assert.equal(readField(readField(libraryQueue, 'data'), 'mode'), "library");
    assert.deepEqual(readArray(readField(readField(libraryQueue, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILLOST", "BVDETAILACTIVE"]);
    assert.deepEqual(readField(readArray(readField(readField(libraryQueue, 'data'), 'items'))[0], 'source'), {
      userId: "detail-user", mediaId: 1, folderTitle: "详情测试",
    });
    assert.equal(JSON.stringify(libraryQueue).includes("/archive/"), false);

    const librarySearchResponse = await fetch(
      `${base}/api/archive-library/playback-search?scope=folder&userId=detail-user&mediaId=1&queueQ=${encodeURIComponent("归档 UP")}&pageSize=50`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(librarySearchResponse.status, 200);
    const librarySearch: unknown = await librarySearchResponse.json();
    assert.deepEqual(readArray(readField(readField(librarySearch, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILLOST"]);

    const detailResponse = await fetch(`${base}/api/users/detail-user/favorites/1/detail-items?page=1&pageSize=20&filter=all`, {
      headers: { Cookie: cookie },
    });
    assert.equal(detailResponse.status, 200);
    const detailJson: unknown = await detailResponse.json();
    const detail = readField(detailJson, 'data');
    assert.equal(readField(detail, 'source'), "state");
    assert.equal(readField(detail, 'tracked'), true);
    assert.equal(readField(detail, 'coverage'), "complete");
    assert.equal(readField(detail, 'lastSyncedAt'), now);
    assert.deepEqual(readArray(readField(detail, 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILLOST", "BVDETAILACTIVE", "BVDETAILHISTORY"]);
    assert.equal(readField(readArray(readField(detail, 'items'))[0], 'title'), "归档前标题");
    assert.equal(readField(readArray(readField(detail, 'items'))[0], 'coverLocalPath'), "covers/BVDETAILLOST.jpg");
    assert.deepEqual(readField(readArray(readField(detail, 'items'))[0], 'playback'), { available: true, partCount: 1, partial: false });
    assert.equal(readField(readArray(readField(detail, 'items'))[2], 'activeInFavorite'), false);
    assert.equal(readField(readField(detail, 'summary'), 'total'), 3);
    assert.equal(readField(readField(detail, 'summary'), 'activeTotal'), 2);
    assert.equal(readField(readField(detail, 'summary'), 'historicalTotal'), 1);
    assert.equal(readField(readField(detail, 'summary'), 'uploadedUnavailable'), 1);
    assert.equal(readField(readField(detail, 'indexSummary'), 'indexed'), 2);
    assert.equal(readField(readField(detail, 'indexSummary'), 'unreturnedCount'), 0);

    const aliasResponse = await fetch(`${base}/api/users/detail-user/favorites/1/state-items?page=1&pageSize=20&filter=all`, {
      headers: { Cookie: cookie },
    });
    const aliasJson: unknown = await aliasResponse.json();
    assert.equal(aliasResponse.status, 200);
    assert.deepEqual(readArray(readField(readField(aliasJson, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), readArray(readField(detail, 'items')).map((item: unknown) => readField(item, 'bvid')));
    assert.equal(readField(readField(aliasJson, 'data'), 'source'), "state");

    const unauthorizedQueue = await fetch(`${base}/api/users/detail-user/favorites/1/playback-queue?focusBvid=BVDETAILLOST`);
    assert.equal(unauthorizedQueue.status, 401);
    const unauthorizedSearch = await fetch(`${base}/api/users/detail-user/favorites/1/playback-search?q=归档`);
    assert.equal(unauthorizedSearch.status, 401);

    const queueResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback-queue?focusBvid=BVDETAILLOST&pageSize=30`, {
      headers: { Cookie: cookie },
    });
    assert.equal(queueResponse.status, 200);
    const queueJson: unknown = await queueResponse.json();
    assert.equal(readField(readField(queueJson, 'data'), 'mode'), "favorite");
    assert.deepEqual(readArray(readField(readField(queueJson, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILLOST", "BVDETAILACTIVE"]);
    assert.deepEqual(readArray(readField(readField(queueJson, 'data'), 'items')).map((item: unknown) => readField(item, 'queuePosition')), [1, 2]);
    assert.equal(JSON.stringify(queueJson).includes("/archive/"), false);

    const metadataPart = readField(queueJson, 'data', 'items', 0, 'parts', 0);
    const metadataResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback/files/${readField(metadataPart, 'fileId')}/media-metadata`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ fingerprint: readField(metadataPart, 'fingerprint'), width: 1772, height: 3840, duration: 12.5 }),
    });
    assert.equal(metadataResponse.status, 200);
    const metadataJson: unknown = await metadataResponse.json();
    assert.equal(readField(readField(metadataJson, 'data'), 'actualQuality'), "1772p");
    assert.deepEqual({
      width: readField(readField(readField(metadataJson, 'data'), 'mediaMetadata'), 'width'),
      height: readField(readField(readField(metadataJson, 'data'), 'mediaMetadata'), 'height'),
      source: readField(readField(readField(metadataJson, 'data'), 'mediaMetadata'), 'source'),
    }, { width: 1772, height: 3840, source: "browser" as const });

    const refreshedQueueResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback-queue?focusBvid=BVDETAILLOST&pageSize=30`, {
      headers: { Cookie: cookie },
    });
    const refreshedQueueJson: unknown = await refreshedQueueResponse.json();
    const refreshedPart = readField(refreshedQueueJson, 'data', 'items', 0, 'parts', 0);
    assert.deepEqual({
      actualQuality: readField(refreshedPart, 'actualQuality'),
      actualWidth: readField(refreshedPart, 'actualWidth'),
      actualHeight: readField(refreshedPart, 'actualHeight'),
    }, { actualQuality: "1772p", actualWidth: 1772, actualHeight: 3840 });

    const invalidDelivery = await fetch(`${base}${readString(readField(queueJson, 'data', 'items', 0, 'parts', 0, 'streamUrl'))}?delivery=direct`, {
      headers: { Cookie: cookie },
    });
    assert.equal(invalidDelivery.status, 400);
    assert.equal((await invalidDelivery.json()).message, "Invalid playback delivery mode");

    const searchResponse = await fetch(`${base}/api/users/detail-user/favorites/1/playback-search?q=${encodeURIComponent("归档 UP")}&pageSize=50`, {
      headers: { Cookie: cookie },
    });
    assert.equal(searchResponse.status, 200);
    const searchJson: unknown = await searchResponse.json();
    assert.equal(readField(readField(searchJson, 'data'), 'query'), "归档 UP");
    assert.equal(readField(readField(searchJson, 'data'), 'total'), 1);
    assert.deepEqual(readArray(readField(readField(searchJson, 'data'), 'items')).map((item: unknown) => [readField(item, 'bvid'), readField(item, 'queuePosition')]), [["BVDETAILLOST", 1]]);
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
    const unavailableJson: unknown = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 200);
    assert.deepEqual(readArray(readField(readField(unavailableJson, 'data'), 'items')).map((item: unknown) => readField(item, 'bvid')), ["BVDETAILLOST"]);

    const removalPreviewResponse = await fetch(`${base}/api/users/detail-user/removal-preview`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(removalPreviewResponse.status, 200);
    const removalPreview: unknown = await removalPreviewResponse.json();
    assert.equal(readField(readField(removalPreview, 'data'), 'scope'), "account");
    assert.equal(readField(readField(removalPreview, 'data'), 'userId'), "detail-user");
    assert.equal(readField(readField(removalPreview, 'data'), 'sourceCount'), 2);

    const legacyAccountRemoval = await fetch(`${base}/api/users/detail-user`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(legacyAccountRemoval.status, 200);
    const usersAfterRemoval = await fetch(`${base}/api/users`, { headers: { Cookie: cookie } });
    assert.deepEqual((await usersAfterRemoval.json()).data, []);

    const archivedNavigationResponse = await fetch(`${base}/api/archive-library/navigation`, { headers: { Cookie: cookie } });
    const archivedNavigation: unknown = await archivedNavigationResponse.json();
    assert.equal(archivedNavigationResponse.status, 200);
    assert.equal(readField(readArray(readField(readField(archivedNavigation, 'data'), 'accounts'))[0], 'id'), "detail-user");
    assert.equal(readField(readArray(readField(readField(archivedNavigation, 'data'), 'accounts'))[0], 'removed'), true);
    const archivedQueueResponse = await fetch(
      `${base}/api/archive-library/playback-queue?scope=account&userId=detail-user&focusBvid=BVDETAILLOST&pageSize=50`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(archivedQueueResponse.status, 200);
    assert.equal((await archivedQueueResponse.json()).data.items[0].source.userId, "detail-user");
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (closeAppResources) await closeAppResources();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdminPass === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = previousAdminPass;
    if (previousTestAppRoot === undefined) delete process.env.BFB_TEST_APP_ROOT;
    else process.env.BFB_TEST_APP_ROOT = previousTestAppRoot;
    await removeTestDir(runtime);
  }
});
