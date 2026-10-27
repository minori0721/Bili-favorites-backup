import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from 'node:https';
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createTestDir, removeTestDir } from "./helpers.js";
import { ARIA2_DOWNLOAD_ARGS } from '../src/aria2-options.js';

function run(command: string, args: string[], timeoutMs = 30_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("aria2 resumes a disconnected HTTP range download", async (t) => {
  try {
    const version = await run("aria2c", ["--version"], 5_000);
    if (version.code !== 0) {
      t.skip("aria2c is not installed");
      return;
    }
  } catch {
    t.skip("aria2c is not installed");
    return;
  }

  const runtime = await createTestDir("aria2-range");
  const payload = crypto.randomBytes(4 * 1024 * 1024);
  let firstRequest = true;
  const ranges: string[] = [];
  const requestedPaths: string[] = [];
  const server = http.createServer((req, res) => {
    requestedPaths.push(String(req.url || ""));
    const range = String(req.headers.range || "");
    if (range) ranges.push(range);
    const start = Number(/^bytes=(\d+)-/.exec(range)?.[1] || 0);
    if (start > 0) {
      res.statusCode = 206;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", `bytes ${start}-${payload.length - 1}/${payload.length}`);
      res.setHeader("Content-Length", payload.length - start);
      res.end(payload.subarray(start));
      return;
    }
    res.statusCode = 200;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", payload.length);
    if (firstRequest) {
      firstRequest = false;
      res.write(payload.subarray(0, payload.length / 2));
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/video.bin?generation=old`;
  const args = [
    ...ARIA2_DOWNLOAD_ARGS,
    "--auto-save-interval=1",
    "--max-tries=1",
    "--console-log-level=warn",
    "--dir", runtime,
    "--out", "video.bin",
    url,
  ];
  try {
    await run("aria2c", args);
    const refreshedArgs = [...args];
    refreshedArgs[refreshedArgs.length - 1] = `http://127.0.0.1:${address.port}/video.bin?generation=refreshed`;
    const second = await run("aria2c", refreshedArgs);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    assert.deepEqual(await fs.promises.readFile(path.join(runtime, "video.bin")), payload);
    assert.equal(ranges.some((value) => /^bytes=[1-9]\d*-/.test(value)), true);
    assert.equal(requestedPaths.some((value) => value.includes("generation=refreshed")), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTestDir(runtime);
  }
});

test('HTTP media downloads never follow torrent or Metalink responses as new jobs', async t => {
  try {
    if ((await run('aria2c', ['--version'], 5000)).code !== 0) { t.skip('aria2c is not installed'); return; }
  } catch { t.skip('aria2c is not installed'); return; }
  const runtime = await createTestDir('aria2-http-only');
  const requested: string[] = [];
  const torrent = Buffer.from('d4:infod6:lengthi1e4:name4:seed12:piece lengthi0e6:pieces20:aaaaaaaaaaaaaaaaaaaaee');
  let metalink = '';
  const server = http.createServer((req, res) => {
    requested.push(req.url!);
    res.setHeader('Content-Type', req.url === '/data.torrent' ? 'application/x-bittorrent' : 'application/metalink4+xml');
    res.end(req.url === '/data.torrent' ? torrent : metalink);
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  metalink = `<?xml version="1.0"?><metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="unexpected.bin"><url>${origin}/must-not-follow</url></file></metalink>`;
  try {
    for (const [name, payload] of [['data.torrent', torrent], ['data.meta4', Buffer.from(metalink)]] as const) {
      const result = await run('aria2c', [...ARIA2_DOWNLOAD_ARGS, '--console-log-level=warn', '--dir', runtime, '--out', name, `${origin}/${name}`]);
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(await fs.promises.readFile(path.join(runtime, name)), payload);
    }
    assert.deepEqual(requested, ['/data.torrent', '/data.meta4']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeTestDir(runtime);
  }
});

test('media TLS accepts a trusted hostname and rejects untrusted certificates and mismatched hostnames', async t => {
  try {
    for (const command of ['aria2c', 'openssl']) {
      const result = await run(command, command === 'aria2c' ? ['--version'] : ['version'], 5000);
      if (result.code !== 0) { t.skip(`${command} is not installed`); return; }
    }
  } catch { t.skip('aria2c and openssl are required'); return; }
  const runtime = await createTestDir('aria2-tls');
  const key = path.join(runtime, 'fixture.key'), cert = path.join(runtime, 'fixture.pem');
  let server: https.Server | undefined;
  try {
    const generated = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
    assert.equal(generated.code, 0, generated.stderr);
    let requests = 0;
    server = https.createServer({key: await fs.promises.readFile(key), cert: await fs.promises.readFile(cert), minVersion: 'TLSv1.2'}, (_req, res) => {
      requests++; res.end('isolated media fixture');
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const args = [...ARIA2_DOWNLOAD_ARGS, '--max-tries=1', '--console-log-level=warn', '--disable-ipv6=true', '--dir', runtime];
    const untrusted = await run('aria2c', [...args, '--out', 'untrusted.bin', `https://localhost:${address.port}/file`]);
    assert.notEqual(untrusted.code, 0);
    const mismatch = await run('aria2c', [...args, '--ca-certificate', cert, '--out', 'mismatch.bin', `https://127.0.0.1:${address.port}/file`]);
    assert.notEqual(mismatch.code, 0);
    const trusted = await run('aria2c', [...args, '--ca-certificate', cert, '--out', 'trusted.bin', `https://localhost:${address.port}/file`]);
    assert.equal(trusted.code, 0, trusted.stderr || trusted.stdout);
    assert.equal(await fs.promises.readFile(path.join(runtime, 'trusted.bin'), 'utf8'), 'isolated media fixture');
    assert.equal(requests, 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await removeTestDir(runtime);
  }
});
