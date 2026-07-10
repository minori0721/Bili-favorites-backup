import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createTestDir, removeTestDir } from "./helpers.js";

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
    "--continue=true",
    "--always-resume=true",
    "--max-resume-failure-tries=0",
    "--auto-save-interval=1",
    "--auto-file-renaming=false",
    "--allow-overwrite=true",
    "--file-allocation=none",
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
