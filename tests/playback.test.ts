import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { StateDatabase } from "../src/database.js";
import {
  getPlaybackQueue,
  playbackAvailability,
  PlaybackHttpError,
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
    filenameMetadata: { pageIndex: 1, cid: 301, dfn: "1080P", videoCodecs: "AVC" },
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
    assert.deepEqual(page.items[0].parts.map((part) => [part.pageIndex, part.label, part.cid]), [
      [1, "P1", 301],
      [2, "P2 · 1", 302],
      [2, "P2 · 2", 303],
    ]);
    assert.match(page.items[0].parts[0].streamUrl, /\/playback\/files\/\d+$/);
    assert.equal(JSON.stringify(page).includes("/archive/"), false);

    const history = getPlaybackQueue(database, "u1", 10, { focusBvid: "BVHISTORY" });
    assert.ok(history);
    assert.equal(history.mode, "single");
    assert.equal(history.total, 1);
    assert.equal(history.items[0].activeInFavorite, false);
    assert.equal(getPlaybackQueue(database, "u1", 10, { focusBvid: "BVPENDING" }), null);
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
  let mode: "normal" | "slow" | "auth" | "forbidden" | "missing" | "error" | "redirect" | "wrongtype" = "normal";
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
  const upstreamBase = await listen(upstream);
  const app = express();
  app.all("/stream", async (req, res) => {
    try {
      await streamPlaybackFile(database, {
        alistUrl: upstreamBase,
        alistUsername: "alist-user",
        alistPassword: "alist-pass",
      } as any, req, res, { userId: "u1", mediaId: 10, fileId });
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
      streamPlaybackFile(database, {} as any, request, response, { userId: "other", mediaId: 10, fileId: Number(row.id) }),
      (error: any) => error instanceof PlaybackHttpError && error.statusCode === 404
    );
    database.db.prepare("UPDATE remote_files SET remote_path='/archive/replaced.mp4' WHERE id=?").run(row.id);
    await assert.rejects(
      streamPlaybackFile(database, {} as any, request, response, { userId: "u1", mediaId: 10, fileId: Number(row.id) }),
      (error: any) => error instanceof PlaybackHttpError && error.statusCode === 404
    );
  } finally {
    database.close();
  }
});
