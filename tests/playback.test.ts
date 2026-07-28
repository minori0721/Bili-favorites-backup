import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { StateDatabase } from "../src/database.js";
import {
  getPlaybackQueue,
  getPlaybackDeliveryStatus,
  getPlaybackSearch,
  playbackFileAlistLocation,
  fetchPlaybackUpstream,
  playbackAvailability,
  PlaybackHttpError,
  safePlaybackRedirectLocation,
  streamPlaybackFile,
} from "../src/playback.js";
import type { FavoriteRelation, RemoteFileRecord, StateFile, VideoArchiveEntry } from "../src/state.js";

const now = "2026-07-24T08:00:00.000Z";

function remoteFile(name: string, options: Partial<RemoteFileRecord> = {}): RemoteFileRecord {
  return {
    name,
    path: `/archive/${name}`,
    size: 128,
    verificationStatus: "verified",
    ...options,
  };
}

function video(bvid: string, title: string, files: RemoteFileRecord[]): VideoArchiveEntry {
  return {
    bvid,
    title,
    upperName: `${title} UP`,
    cover: `https://example.invalid/${bvid}.jpg`,
    firstSeenAt: now,
    lastSeenAt: now,
    biliStatus: "available",
    backupStatus: "verified",
    remotePath: `/archive/${bvid}`,
    remoteFiles: files,
  };
}

function relation(bvid: string, order: number, files: RemoteFileRecord[], active = true): FavoriteRelation {
  return {
    userId: "u1",
    mediaId: 10,
    bvid,
    folderTitle: "播放测试",
    firstSeenAt: now,
    lastSeenAt: now,
    favOrder: order,
    activeInFavorite: active,
    backupStatus: "verified",
    remotePath: `/archive/${bvid}`,
    remoteFiles: files,
  };
}

function playbackState(): StateFile {
  const p1 = remoteFile("合集_P1.mp4", {
    path: "/archive/BVPLAY003/合集_P1.mp4",
    qualityProfile: { quality: "4K", encoding: "HEVC", hiRes: false, dolby: false },
    mediaMetadata: {
      width: 1920, height: 1080, duration: 120, fps: 60, codec: "h264",
      source: "ffprobe", observedAt: now,
    },
    filenameMetadata: { pageIndex: 1, cid: 301, bilibiliQuality: "1080P60", dfn: "1080P", videoCodecs: "AVC" },
  });
  const p2a = remoteFile("合集_P2-a.mp4", {
    path: "/archive/BVPLAY003/合集_P2-a.mp4",
    filenameMetadata: { pageIndex: 2, cid: 302, dfn: "1080P", videoCodecs: "HEVC" },
  });
  const p2b = remoteFile("合集_P2-b.mp4", {
    path: "/archive/BVPLAY003/合集_P2-b.mp4",
    filenameMetadata: { pageIndex: 2, cid: 303, dfn: "720P", videoCodecs: "AVC" },
  });
  const one = remoteFile("BVPLAY001.mp4", { path: "/archive/BVPLAY001/BVPLAY001.mp4" });
  const two = remoteFile("BVPLAY002.mp4", { path: "/archive/BVPLAY002/BVPLAY002.mp4" });
  const history = remoteFile("BVHISTORY.mp4", { path: "/archive/BVHISTORY/BVHISTORY.mp4" });
  const pending = remoteFile("BVPENDING.mp4", {
    path: "/archive/BVPENDING/BVPENDING.mp4",
    verificationStatus: "awaiting_verification",
  });
  const records = [
    ["BVPLAY001", "第一条", [one], 1, true],
    ["BVPLAY002", "第二条", [two], 2, true],
    ["BVPLAY003", "三分P", [p2b, p1, p2a], 3, true],
    ["BVHISTORY", "历史归档", [history], 4, false],
    ["BVPENDING", "确认中", [pending], 5, true],
  ] as const;
  return {
    schemaVersion: 13,
    processedByUser: {},
    failedByUser: {},
    userCooldowns: {},
    videos: Object.fromEntries(records.map(([bvid, title, files]) => [bvid, video(bvid, title, [...files])])),
    relations: Object.fromEntries(records.map(([bvid, _title, files, order, active]) => [
      `u1:10:${bvid}`,
      {
        ...relation(bvid, order, [...files], active),
        backupStatus: bvid === "BVPENDING" ? "uploaded" : "verified",
      },
    ])),
    folderScans: {},
  };
}

test("playback availability only exposes verified playable archive files", () => {
  assert.deepEqual(playbackAvailability("verified", [remoteFile("video.mp4")]), {
    available: true,
    partCount: 1,
    partial: false,
  });
  assert.deepEqual(playbackAvailability("partial_verified", [remoteFile("video.webm")]), {
    available: true,
    partCount: 1,
    partial: true,
  });
  assert.equal(playbackAvailability("uploaded", [remoteFile("video.mp4")]).reason, "awaiting_verification");
  assert.equal(playbackAvailability("verified", [remoteFile("video.mkv")]).reason, "no_playable_media");
  assert.equal(playbackAvailability("verified", [remoteFile("video.mp4", { verificationStatus: "failed" })]).available, false);
});

test("playback redirect validation only accepts external public HTTPS locations", () => {
  const alistBase = new URL("http://alist:5244");
  assert.equal(
    safePlaybackRedirectLocation("https://media.example.com/video.mp4?signature=test#ignored", alistBase),
    "https://media.example.com/video.mp4?signature=test"
  );
  assert.equal(safePlaybackRedirectLocation("https://1.1.1.1/video.mp4", alistBase), "https://1.1.1.1/video.mp4");
  for (const location of [
    null,
    "/storage/video.mp4",
    "http://media.example.com/video.mp4",
    "https://user:pass@media.example.com/video.mp4",
    "https://alist/video.mp4",
    "https://localhost/video.mp4",
    "https://files.local/video.mp4",
    "https://127.0.0.1/video.mp4",
    "https://10.0.0.1/video.mp4",
    "https://100.64.0.1/video.mp4",
    "https://169.254.1.2/video.mp4",
    "https://172.16.0.1/video.mp4",
    "https://192.168.1.2/video.mp4",
    "https://192.0.2.1/video.mp4",
    "https://198.51.100.1/video.mp4",
    "https://203.0.113.1/video.mp4",
    "https://[::1]/video.mp4",
    "https://[fd00::1]/video.mp4",
    "https://[fe80::1]/video.mp4",
    "https://[2001:db8::1]/video.mp4",
    "https://media.example.com:8443/video.mp4",
    "not a URL",
  ]) {
    assert.equal(safePlaybackRedirectLocation(location, alistBase), null, String(location));
  }
  assert.equal(safePlaybackRedirectLocation(`https://media.example.com/${"x".repeat(8_192)}`, alistBase), null);
});

test("playback proxy validates every redirect and strips AList authorization across origins", async () => {
  const alistBase = new URL("http://alist:5244");
  const requests: Array<{ url: string; authorization: string | null; range: string | null }> = [];
  const fetchImpl = async (value: string | URL | Request, init?: RequestInit) => {
    const url = String(value);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization"), range: headers.get("range") });
    if (url.startsWith("http://alist:5244")) {
      return new Response(null, { status: 302, headers: { Location: "https://media.example.com/first" } });
    }
    if (url.endsWith("/first")) {
      return new Response(null, { status: 307, headers: { Location: "https://cdn.example.com/final" } });
    }
    return new Response("data", { status: 206, headers: { "Content-Type": "video/mp4" } });
  };
  const result = await fetchPlaybackUpstream(
    new URL("http://alist:5244/dav/video.mp4"),
    alistBase,
    "GET",
    { Authorization: "Basic secret", Range: "bytes=0-3" },
    new AbortController().signal,
    false,
    {
      fetch: fetchImpl as typeof fetch,
      lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as any,
    }
  );
  assert.equal(result.response?.status, 206);
  assert.deepEqual(requests.map((request) => request.authorization), ["Basic secret", null, null]);
  assert.deepEqual(requests.map((request) => request.range), ["bytes=0-3", "bytes=0-3", "bytes=0-3"]);
});

test("playback proxy never restores AList authorization after an external redirect", async () => {
  const alistBase = new URL("http://alist:5244");
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = async (value: string | URL | Request, init?: RequestInit) => {
    const url = String(value);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (requests.length === 1) {
      return new Response(null, { status: 302, headers: { Location: "https://media.example.com/first" } });
    }
    if (requests.length === 2) {
      return new Response(null, { status: 302, headers: { Location: "http://alist:5244/storage/video.mp4" } });
    }
    return new Response("data", { status: 206, headers: { "Content-Type": "video/mp4" } });
  };
  const result = await fetchPlaybackUpstream(
    new URL("http://alist:5244/dav/video.mp4"),
    alistBase,
    "GET",
    { Authorization: "Basic secret" },
    new AbortController().signal,
    false,
    {
      fetch: fetchImpl as typeof fetch,
      lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as any,
    }
  );
  assert.equal(result.response?.status, 206);
  assert.deepEqual(requests.map((request) => request.authorization), ["Basic secret", null, null]);
});

test("playback proxy rejects private DNS, HTTP, cyclic, and excessive redirects", async () => {
  const alistBase = new URL("http://alist:5244");
  const auth = { Authorization: "Basic secret" };
  const signal = new AbortController().signal;
  const redirectFetch = (location: string) => (async () => new Response(null, { status: 302, headers: { Location: location } })) as typeof fetch;

  await assert.rejects(
    () => fetchPlaybackUpstream(new URL("http://alist:5244/dav/video.mp4"), alistBase, "GET", auth, signal, false, {
      fetch: redirectFetch("https://private.example/video.mp4"),
      lookup: (async () => [{ address: "10.0.0.2", family: 4 }]) as any,
    }),
    (error: any) => error?.code === "PLAYBACK_REDIRECT_UNSAFE"
  );
  await assert.rejects(
    () => fetchPlaybackUpstream(new URL("http://alist:5244/dav/video.mp4"), alistBase, "GET", auth, signal, false, {
      fetch: redirectFetch("http://public.example/video.mp4"),
    }),
    (error: any) => error?.code === "PLAYBACK_REDIRECT_UNSAFE"
  );
  await assert.rejects(
    () => fetchPlaybackUpstream(new URL("http://alist:5244/dav/video.mp4"), alistBase, "GET", auth, signal, false, {
      fetch: redirectFetch("/dav/video.mp4"),
    }),
    (error: any) => error?.code === "PLAYBACK_REDIRECT_LOOP"
  );
  let hop = 0;
  await assert.rejects(
    () => fetchPlaybackUpstream(new URL("http://alist:5244/dav/video.mp4"), alistBase, "GET", auth, signal, false, {
      fetch: (async () => new Response(null, { status: 302, headers: { Location: `/hop-${++hop}` } })) as typeof fetch,
    }),
    (error: any) => error?.code === "PLAYBACK_REDIRECT_LIMIT"
  );
});

test("playback queue uses favorite order, focus pagination, stable parts, and historical single mode", () => {
  const database = new StateDatabase(":memory:");
  try {
    database.replaceState(playbackState());
    const page = getPlaybackQueue(database, "u1", 10, { focusBvid: "BVPLAY003", pageSize: 2 });
    assert.ok(page);
    assert.equal(page.mode, "favorite");
    assert.equal(page.page, 2);
    assert.equal(page.total, 3);
    assert.equal(page.focusIndex, 2);
    assert.deepEqual(page.items.map((item) => item.bvid), ["BVPLAY003"]);
    assert.equal(page.items[0].queuePosition, 3);
    assert.deepEqual(page.items[0].parts.map((part) => [part.pageIndex, part.label, part.cid]), [
      [1, "P1", 301],
      [2, "P2 · 1", 302],
      [2, "P2 · 2", 303],
    ]);
    assert.deepEqual({
      requestedQuality: page.items[0].parts[0].requestedQuality,
      requestedCodec: page.items[0].parts[0].requestedCodec,
      bilibiliQuality: page.items[0].parts[0].bilibiliQuality,
      actualQuality: page.items[0].parts[0].actualQuality,
      actualWidth: page.items[0].parts[0].actualWidth,
      actualHeight: page.items[0].parts[0].actualHeight,
      actualFps: page.items[0].parts[0].actualFps,
      quality: page.items[0].parts[0].quality,
      codec: page.items[0].parts[0].codec,
      mediaMetadataSource: page.items[0].parts[0].mediaMetadataSource,
    }, {
      requestedQuality: "4K",
      requestedCodec: "HEVC",
      bilibiliQuality: "1080P60",
      actualQuality: "1080p60",
      actualWidth: 1920,
      actualHeight: 1080,
      actualFps: 60,
      quality: "1080p60",
      codec: "AVC",
      mediaMetadataSource: "ffprobe",
    });
    assert.match(page.items[0].parts[0].streamUrl, /\/playback\/files\/\d+$/);
    assert.equal(JSON.stringify(page).includes("/archive/"), false);

    const history = getPlaybackQueue(database, "u1", 10, { focusBvid: "BVHISTORY" });
    assert.ok(history);
    assert.equal(history.mode, "single");
    assert.equal(history.total, 1);
    assert.equal(history.items[0].queuePosition, 1);
    assert.equal(history.items[0].activeInFavorite, false);
    assert.equal(getPlaybackQueue(database, "u1", 10, { focusBvid: "BVPENDING" }), null);
  } finally {
    database.close();
  }
});

test("playback search matches archived metadata, BVID, Chinese, AND terms, and literal wildcards", () => {
  const database = new StateDatabase(":memory:");
  const state = playbackState();
  state.videos!.BVPLAY001.title = "当前别名 %_";
  state.videos!.BVPLAY001.upperName = "当前作者";
  state.videos!.BVPLAY001.originalMeta = {
    title: "归档前中文标题",
    upperName: "原始 UP",
    cover: "https://example.invalid/original.jpg",
    capturedAt: now,
  };
  state.videos!.BVPLAY002.title = "另一个中文示例";
  state.videos!.BVPLAY002.upperName = "Alice Creator";
  state.videos!.BVHISTORY.title = "EXCLUDED 历史";
  state.videos!.BVPENDING.title = "EXCLUDED 确认中";
  const unsupported = remoteFile("unsupported.mkv", { path: "/archive/BVUNSUPPORTED/unsupported.mkv" });
  state.videos!.BVUNSUPPORTED = video("BVUNSUPPORTED", "EXCLUDED 不支持", [unsupported]);
  state.relations!["u1:10:BVUNSUPPORTED"] = relation("BVUNSUPPORTED", 6, [unsupported]);
  try {
    database.replaceState(state);
    const archived = getPlaybackSearch(database, "u1", 10, { query: "归档前 原始", pageSize: 50 });
    assert.equal(archived.total, 1);
    assert.deepEqual(archived.items.map((item) => [item.bvid, item.queuePosition, item.title, item.upperName]), [
      ["BVPLAY001", 1, "归档前中文标题", "原始 UP"],
    ]);
    assert.deepEqual(getPlaybackSearch(database, "u1", 10, { query: "当前别名" }).items.map((item) => item.bvid), ["BVPLAY001"]);
    assert.deepEqual(getPlaybackSearch(database, "u1", 10, { query: "%_" }).items.map((item) => item.bvid), ["BVPLAY001"]);
    assert.deepEqual(getPlaybackSearch(database, "u1", 10, { query: "Alice 中文" }).items.map((item) => item.bvid), ["BVPLAY002"]);
    assert.deepEqual(getPlaybackSearch(database, "u1", 10, { query: "BVPLAY003" }).items.map((item) => item.bvid), ["BVPLAY003"]);
    assert.equal(getPlaybackSearch(database, "u1", 10, { query: "EXCLUDED" }).total, 0);
    assert.equal(getPlaybackSearch(database, "u1", 10, { query: "不存在" }).total, 0);
  } finally {
    database.close();
  }
});

test("browser metadata fills missing dimensions in place without replacing ffprobe proof", () => {
  const database = new StateDatabase(":memory:");
  try {
    const state = playbackState();
    const file = state.relations!["u1:10:BVPLAY001"].remoteFiles![0];
    file.qualityProfile = { quality: "4K", encoding: "HEVC", hiRes: false, dolby: false };
    state.videos!.BVPLAY001.remoteFiles = [file];
    database.replaceState(state);
    const before = database.db.prepare(`
      SELECT id, expected_size, updated_at FROM remote_files
      WHERE user_id='u1' AND media_id=10 AND bvid='BVPLAY001'
    `).get() as any;
    const fingerprint = `${before.id}:${before.expected_size}:${before.updated_at}`;
    const result = database.updateBrowserMediaMetadata("u1", 10, Number(before.id), {
      fingerprint,
      width: 1080,
      height: 1920,
      duration: 90,
    });
    assert.equal(result?.status, "updated");
    const after = database.db.prepare(`
      SELECT id, updated_at, actual_width, actual_height, actual_duration, actual_metadata_source
      FROM remote_files WHERE id=?
    `).get(before.id) as any;
    assert.deepEqual(after, {
      id: before.id,
      updated_at: before.updated_at,
      actual_width: 1080,
      actual_height: 1920,
      actual_duration: 90,
      actual_metadata_source: "browser",
    });
    const queue = getPlaybackQueue(database, "u1", 10, { focusBvid: "BVPLAY001" });
    assert.equal(queue?.items[0].parts[0].requestedQuality, "4K");
    assert.equal(queue?.items[0].parts[0].actualQuality, "1080p");
    assert.equal(queue?.items[0].parts[0].codec, undefined);
    assert.equal(database.updateBrowserMediaMetadata("u1", 10, Number(before.id), {
      fingerprint,
      width: 720,
      height: 1280,
      duration: 80,
    })?.status, "unchanged");
    assert.equal(database.updateBrowserMediaMetadata("u1", 10, Number(before.id), {
      fingerprint: `${before.id}:999:${before.updated_at}`,
      width: 720,
      height: 1280,
      duration: 80,
    }), null);

    database.db.prepare(`
      UPDATE remote_files SET actual_width=3840, actual_height=2160, actual_codec='hevc',
        actual_metadata_source='ffprobe', actual_metadata_at=? WHERE id=?
    `).run(Date.parse(now), before.id);
    assert.equal(database.updateBrowserMediaMetadata("u1", 10, Number(before.id), {
      fingerprint,
      width: 720,
      height: 1280,
      duration: 80,
    })?.status, "ffprobe_preserved");
  } finally {
    database.close();
  }
});

test("browser metadata propagates only to equivalent verified remote-file rows", () => {
  const database = new StateDatabase(":memory:");
  try {
    const state = playbackState();
    const shared = state.relations!["u1:10:BVPLAY001"].remoteFiles![0];
    state.videos!.BVPLAY001.remoteFiles = [shared];
    state.relations!["u1:11:BVPLAY001"] = {
      ...relation("BVPLAY001", 1, [shared]),
      mediaId: 11,
      folderTitle: "Second folder",
    };
    database.replaceState(state);
    const primary = database.db.prepare(`
      SELECT id, expected_size, updated_at FROM remote_files
      WHERE user_id='u1' AND media_id=10 AND bvid='BVPLAY001'
    `).get() as any;
    database.db.prepare(`
      INSERT INTO remote_files(bvid,user_id,media_id,name,remote_path,expected_size,status,updated_at)
      VALUES('BVPLAY001','isolated',99,'same.mp4',?,999,'verified',?)
    `).run(shared.path, Date.now());

    const result = database.updateBrowserMediaMetadata("u1", 10, Number(primary.id), {
      fingerprint: `${primary.id}:${primary.expected_size}:${primary.updated_at}`,
      width: 1920,
      height: 1080,
      duration: 120,
    });
    assert.equal(result?.status, "updated");
    const equivalent = database.db.prepare(`
      SELECT actual_width,actual_height,actual_metadata_source FROM remote_files
      WHERE user_id='u1' AND media_id=11 AND bvid='BVPLAY001'
    `).get() as any;
    assert.deepEqual(equivalent, {
      actual_width: 1920,
      actual_height: 1080,
      actual_metadata_source: "browser",
    });
    const isolated = database.db.prepare(`
      SELECT actual_width FROM remote_files WHERE user_id='isolated' AND media_id=99
    `).get() as any;
    assert.equal(isolated.actual_width, null);
    const relationPayload = JSON.parse(String((database.db.prepare(`
      SELECT payload_json FROM favorite_relations
      WHERE user_id='u1' AND media_id=11 AND bvid='BVPLAY001'
    `).get() as any).payload_json));
    assert.equal(relationPayload.remoteFiles[0].mediaMetadata.width, 1920);

    database.db.prepare(`
      UPDATE remote_files SET actual_width=3840,actual_height=2160,actual_codec='hevc',
        actual_metadata_source='ffprobe',actual_metadata_at=?
      WHERE user_id='u1' AND media_id=11 AND bvid='BVPLAY001'
    `).run(Date.parse(now));
    database.updateBrowserMediaMetadata("u1", 10, Number(primary.id), {
      fingerprint: `${primary.id}:${primary.expected_size}:${primary.updated_at}`,
      width: 1280,
      height: 720,
      duration: 60,
    });
    const protectedRow = database.db.prepare(`
      SELECT actual_width,actual_height,actual_metadata_source FROM remote_files
      WHERE user_id='u1' AND media_id=11 AND bvid='BVPLAY001'
    `).get() as any;
    assert.deepEqual(protectedRow, {
      actual_width: 3840,
      actual_height: 2160,
      actual_metadata_source: "ffprobe",
    });
  } finally {
    database.close();
  }
});

test("AList browser links preserve base paths and encode archive paths without exposing them in queue JSON", () => {
  const database = new StateDatabase(":memory:");
  try {
    const state = playbackState();
    const file = state.relations!["u1:10:BVPLAY001"].remoteFiles![0];
    file.path = "/天翼云盘/收藏 夹/视频#1.mp4";
    file.name = "视频#1.mp4";
    state.relations!["u1:10:BVPLAY001"].remotePath = "/天翼云盘/收藏 夹";
    state.videos!.BVPLAY001.remoteFiles = [file];
    database.replaceState(state);
    const fileId = Number((database.db.prepare(`
      SELECT id FROM remote_files WHERE user_id='u1' AND media_id=10 AND bvid='BVPLAY001'
    `).get() as any).id);
    const location = playbackFileAlistLocation(database, {
      alistBrowserUrl: "https://alist.example.com/base/",
    } as any, "u1", 10, fileId);
    assert.equal(location, "https://alist.example.com/base/%E5%A4%A9%E7%BF%BC%E4%BA%91%E7%9B%98/%E6%94%B6%E8%97%8F%20%E5%A4%B9/%E8%A7%86%E9%A2%91%231.mp4");
    assert.throws(() => playbackFileAlistLocation(database, {
      alistBrowserUrl: "https://user:pass@alist.example.com/base",
    } as any, "u1", 10, fileId), PlaybackHttpError);
    const queue = getPlaybackQueue(database, "u1", 10, { focusBvid: "BVPLAY001" });
    assert.equal(JSON.stringify(queue).includes("天翼云盘"), false);
  } finally {
    database.close();
  }
});

test("playback pagination and search stay bounded with 10000 SQLite relations", { timeout: 30_000 }, () => {
  const database = new StateDatabase(":memory:");
  const insertVideo = database.db.prepare(`
    INSERT INTO videos(bvid,backup_status,bili_status,payload_json,updated_at)
    VALUES(?,'verified','available',?,?)
  `);
  const insertRelation = database.db.prepare(`
    INSERT INTO favorite_relations(user_id,media_id,bvid,backup_status,active_in_favorite,folder_title,fav_order,last_seen_at,payload_json,updated_at)
    VALUES('scale-user',88,?,'verified',1,'规模测试',?,?,?,?)
  `);
  const insertRemote = database.db.prepare(`
    INSERT INTO remote_files(bvid,user_id,media_id,kind,name,remote_path,expected_size,status,updated_at)
    VALUES(?,'scale-user',88,'main',?,?,128,'verified',?)
  `);
  const insertAll = database.db.transaction(() => {
    for (let index = 1; index <= 10_000; index += 1) {
      const bvid = `BVSCALE${String(index).padStart(6, "0")}`;
      const name = `${bvid}.mp4`;
      const remotePath = `/archive/${bvid}/${name}`;
      const title = index === 9876 ? "Needle 9876" : `规模视频 ${index}`;
      const file = remoteFile(name, { path: remotePath });
      const videoEntry = video(bvid, title, [file]);
      videoEntry.upperName = index === 9876 ? "Scale UP" : "批量账号";
      const relationEntry = relation(bvid, index, [file]);
      relationEntry.userId = "scale-user";
      relationEntry.mediaId = 88;
      insertVideo.run(bvid, JSON.stringify(videoEntry), index);
      insertRelation.run(bvid, index, index, JSON.stringify(relationEntry), index);
      insertRemote.run(bvid, name, remotePath, index);
    }
  });
  try {
    insertAll();
    const focus = getPlaybackQueue(database, "scale-user", 88, { focusBvid: "BVSCALE000525", pageSize: 50 });
    assert.ok(focus);
    assert.equal(focus.page, 11);
    assert.equal(focus.total, 10_000);
    assert.equal(focus.items.length, 50);
    assert.equal(focus.items[0].queuePosition, 501);
    assert.equal(focus.items[24].bvid, "BVSCALE000525");
    assert.equal(focus.items[49].queuePosition, 550);

    const previous = getPlaybackQueue(database, "scale-user", 88, { page: 10, pageSize: 50 });
    const next = getPlaybackQueue(database, "scale-user", 88, { page: 12, pageSize: 50 });
    assert.deepEqual([previous?.items[0].queuePosition, previous?.items.at(-1)?.queuePosition], [451, 500]);
    assert.deepEqual([next?.items[0].queuePosition, next?.items.at(-1)?.queuePosition], [551, 600]);

    const search = getPlaybackSearch(database, "scale-user", 88, { query: "Needle UP 9876", pageSize: 50 });
    assert.equal(search.total, 1);
    assert.equal(search.items[0].bvid, "BVSCALE009876");
    assert.equal(search.items[0].queuePosition, 9876);
    const plan = database.db.prepare(`
      EXPLAIN QUERY PLAN SELECT r.bvid FROM favorite_relations r
      WHERE r.user_id=? AND r.media_id=? AND r.active_in_favorite=1
      ORDER BY CASE WHEN r.fav_order IS NULL THEN 1 ELSE 0 END, r.fav_order ASC, r.last_seen_at DESC, r.bvid ASC
      LIMIT 50
    `).all("scale-user", 88) as any[];
    assert.match(plan.map((row) => String(row.detail || "")).join("\n"), /idx_relations_folder_page/);
  } finally {
    database.close();
  }
});

test("legacy multipart archives fall back to P suffix ordering up to 24 parts", () => {
  const database = new StateDatabase(":memory:");
  const files = Array.from({ length: 24 }, (_, index) => {
    const page = 24 - index;
    return remoteFile(`旧归档_P${page}.mp4`, { path: `/archive/BVLEGACY24/旧归档_P${page}.mp4` });
  });
  const state: StateFile = {
    schemaVersion: 13,
    processedByUser: {},
    failedByUser: {},
    userCooldowns: {},
    videos: { BVLEGACY24: video("BVLEGACY24", "旧式24P归档", files) },
    relations: { "u1:10:BVLEGACY24": relation("BVLEGACY24", 1, files) },
    folderScans: {},
  };
  try {
    database.replaceState(state);
    const queue = getPlaybackQueue(database, "u1", 10, { focusBvid: "BVLEGACY24" });
    assert.ok(queue);
    assert.equal(queue.items[0].parts.length, 24);
    assert.deepEqual(queue.items[0].parts.map((part) => part.pageIndex), Array.from({ length: 24 }, (_, index) => index + 1));
  } finally {
    database.close();
  }
});

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("playback proxy forwards safe byte ranges, streams early, and aborts upstream", { timeout: 20_000 }, async () => {
  const content = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  let upstreamRequests = 0;
  let upstreamClosed = false;
  let mode: "normal" | "slow" | "auth" | "forbidden" | "missing" | "error" | "redirect" | "direct" | "httpredirect" | "wrongtype" = "normal";
  let upstreamBase = "";
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("alist-user:alist-pass").toString("base64")}`);
    if (mode === "auth") { res.writeHead(401).end("credential detail must stay private"); return; }
    if (mode === "forbidden") { res.writeHead(403).end("forbidden credential detail"); return; }
    if (mode === "missing") { res.writeHead(404).end("/archive/private/video.mp4"); return; }
    if (mode === "error") { res.writeHead(503).end("upstream secret body"); return; }
    if (mode === "redirect" && String(req.url || "").startsWith("/dav/")) {
      res.writeHead(302, { Location: "/storage/playback.mp4" }).end();
      return;
    }
    if (mode === "direct" && String(req.url || "").startsWith("/dav/")) {
      res.writeHead(302, { Location: "https://media.example.com/playback.mp4?signature=test" }).end("must not be relayed");
      return;
    }
    if (mode === "httpredirect" && String(req.url || "").startsWith("/dav/")) {
      res.writeHead(302, { Location: `${upstreamBase}/storage/playback.mp4` }).end();
      return;
    }
    const range = String(req.headers.range || "");
    let start = 0;
    let end = content.length - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match || Number(match[1]) >= content.length) {
        res.writeHead(416, { "Content-Range": `bytes */${content.length}`, "Accept-Ranges": "bytes" }).end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    }
    const body = content.subarray(start, end + 1);
    res.writeHead(range ? 206 : 200, {
      "Content-Type": mode === "wrongtype" ? "text/html" : "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": String(body.length),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${content.length}` } : {}),
      ETag: '"playback-test"',
    });
    if (req.method === "HEAD") { res.end(); return; }
    if (mode === "slow") {
      res.write(body.subarray(0, 4));
      res.once("close", () => { upstreamClosed = true; });
      setTimeout(() => { if (!res.destroyed) res.end(body.subarray(4)); }, 250).unref();
      return;
    }
    res.end(body);
  });

  const database = new StateDatabase(":memory:");
  const state = playbackState();
  const only = state.relations!["u1:10:BVPLAY001"];
  const file = only.remoteFiles![0];
  file.path = "/archive/BVPLAY001/video.mp4";
  file.name = "video.mp4";
  state.videos!.BVPLAY001.remoteFiles = [file];
  database.replaceState(state);
  const fileId = Number((database.db.prepare("SELECT id FROM remote_files WHERE user_id='u1' AND media_id=10 AND bvid='BVPLAY001'").get() as any).id);
  upstreamBase = await listen(upstream);
  const app = express();
  app.all("/stream", async (req, res) => {
    try {
      await streamPlaybackFile(database, {
        alistUrl: upstreamBase,
        alistUsername: "alist-user",
        alistPassword: "alist-pass",
        playbackDeliveryMode: "auto",
      } as any, req, res, {
        userId: "u1",
        mediaId: 10,
        fileId,
        ownerKey: "test-owner",
        attemptId: typeof req.query.attempt === "string" ? req.query.attempt : undefined,
        forceProxy: req.query.forceProxy === "1",
        transport: {
          lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as any,
        },
      });
    } catch (error) {
      if (error instanceof PlaybackHttpError && !res.headersSent) {
        res.status(error.statusCode).json({ code: error.code, message: error.message });
        return;
      }
      throw error;
    }
  });
  const proxy = http.createServer(app);
  const proxyBase = await listen(proxy);

  try {
    const head = await fetch(`${proxyBase}/stream`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-type"), "video/mp4");

    const ranged = await fetch(`${proxyBase}/stream`, { headers: { Range: "bytes=5-11", "If-Range": '"playback-test"' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 5-11/${content.length}`);
    assert.equal(await ranged.text(), content.subarray(5, 12).toString());

    const beforeInvalid = upstreamRequests;
    const invalid = await fetch(`${proxyBase}/stream`, { headers: { Range: "bytes=0-1,4-5" } });
    assert.equal(invalid.status, 416);
    assert.equal(upstreamRequests, beforeInvalid);

    const unsatisfied = await fetch(`${proxyBase}/stream`, { headers: { Range: "bytes=999-" } });
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.headers.get("content-range"), `bytes */${content.length}`);

    mode = "auth";
    const denied = await fetch(`${proxyBase}/stream`);
    assert.equal(denied.status, 502);
    const deniedBody = await denied.text();
    assert.equal(deniedBody.includes("credential detail"), false);
    assert.equal(deniedBody.includes("alist-pass"), false);

    mode = "forbidden";
    const forbidden = await fetch(`${proxyBase}/stream`);
    assert.equal(forbidden.status, 502);
    assert.equal((await forbidden.text()).includes("forbidden credential detail"), false);

    mode = "missing";
    const missing = await fetch(`${proxyBase}/stream`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.text()).includes("/archive/BVPLAY001"), false);

    mode = "error";
    const failed = await fetch(`${proxyBase}/stream`);
    assert.equal(failed.status, 502);
    assert.equal((await failed.text()).includes("upstream secret body"), false);

    mode = "redirect";
    const redirected = await fetch(`${proxyBase}/stream`, { headers: { Range: "bytes=0-3" } });
    assert.equal(redirected.status, 206);
    assert.equal(await redirected.text(), "0123");

    mode = "httpredirect";
    const insecureRedirect = await fetch(`${proxyBase}/stream`, { headers: { Range: "bytes=1-3" } });
    assert.equal(insecureRedirect.status, 206);
    assert.equal(await insecureRedirect.text(), "123");

    mode = "direct";
    const beforeDirect = upstreamRequests;
    const direct = await fetch(`${proxyBase}/stream`, {
      headers: { Range: "bytes=0-3" },
      redirect: "manual",
    });
    assert.equal(direct.status, 302);
    assert.equal(direct.headers.get("location"), "https://media.example.com/playback.mp4?signature=test");
    assert.equal(direct.headers.get("cache-control"), "private, no-store");
    assert.equal(direct.headers.get("referrer-policy"), "no-referrer");
    assert.equal(direct.headers.get("content-length"), "0");
    assert.equal(await direct.text(), "");
    assert.equal(upstreamRequests, beforeDirect + 1);

    const directHead = await fetch(`${proxyBase}/stream`, { method: "HEAD", redirect: "manual" });
    assert.equal(directHead.status, 302);
    assert.equal(directHead.headers.get("location"), "https://media.example.com/playback.mp4?signature=test");

    const attemptId = "0123456789abcdef0123456789abcdef";
    const directTracked = await fetch(`${proxyBase}/stream?attempt=${attemptId}`, { redirect: "manual" });
    assert.equal(directTracked.status, 302);
    assert.equal(getPlaybackDeliveryStatus("test-owner", "u1", 10, attemptId).status, "direct");
    mode = "error";
    const failedProxyAfterDirect = await fetch(`${proxyBase}/stream?attempt=${attemptId}&forceProxy=1`);
    assert.equal(failedProxyAfterDirect.status, 502);
    assert.equal(getPlaybackDeliveryStatus("test-owner", "u1", 10, attemptId).status, "direct");
    mode = "normal";
    const proxiedTracked = await fetch(`${proxyBase}/stream?attempt=${attemptId}&forceProxy=1`);
    assert.equal(proxiedTracked.status, 200);
    await proxiedTracked.body?.cancel();
    assert.equal(getPlaybackDeliveryStatus("test-owner", "u1", 10, attemptId).status, "proxy");

    mode = "wrongtype";
    const forcedMediaType = await fetch(`${proxyBase}/stream`);
    assert.equal(forcedMediaType.status, 200);
    assert.equal(forcedMediaType.headers.get("content-type"), "video/mp4");
    await forcedMediaType.body?.cancel();

    mode = "slow";
    const firstByteAt = await new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const request = http.get(`${proxyBase}/stream`, (response) => {
        response.once("data", () => {
          resolve(Date.now() - started);
          request.destroy();
        });
      });
      request.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
    });
    assert.ok(firstByteAt < 200, `first byte waited ${firstByteAt}ms`);
    for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamClosed, true);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
    database.close();
  }
});

test("playback file resolver rejects wrong relation and replaced paths", async () => {
  const database = new StateDatabase(":memory:");
  database.replaceState(playbackState());
  const row = database.db.prepare("SELECT id FROM remote_files WHERE user_id='u1' AND media_id=10 LIMIT 1").get() as any;
  const request = { headers: {}, method: "GET", once() {}, off() {} } as any;
  const response = { once() {}, off() {} } as any;
  try {
    await assert.rejects(
      streamPlaybackFile(database, {} as any, request, response, { userId: "other", mediaId: 10, fileId: Number(row.id), ownerKey: "test" }),
      (error: any) => error instanceof PlaybackHttpError && error.statusCode === 404
    );
    database.db.prepare("UPDATE remote_files SET remote_path='/archive/replaced.mp4' WHERE id=?").run(row.id);
    await assert.rejects(
      streamPlaybackFile(database, {} as any, request, response, { userId: "u1", mediaId: 10, fileId: Number(row.id), ownerKey: "test" }),
      (error: any) => error instanceof PlaybackHttpError && error.statusCode === 404
    );
  } finally {
    database.close();
  }
});
