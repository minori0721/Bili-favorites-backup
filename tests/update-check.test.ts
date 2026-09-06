import test from "node:test";
import assert from "node:assert/strict";
import { UpdateCheckService, compareReleaseVersions } from "../src/update-check.js";
import { buildAppInfo } from "../src/app-info.js";

const release = { tag_name: "v2.10.0", draft: false, prerelease: false, published_at: "2026-09-06T00:00:00Z", body: "<script>alert(1)</script>" };
const stable = buildAppInfo({ BFB_BUILD_REF: "v2.9.0" }, { version: "2.9.0" });
test("release comparison is numeric and refuses prerelease and malformed tags", () => {
  assert.equal(compareReleaseVersions("v2.10.0", "2.9.0"), 1);
  assert.equal(compareReleaseVersions("2.9.0", "v2.9.0"), 0);
  for (const tag of ["2.9.0-dev", "bad", "02.1.0"]) assert.throws(() => compareReleaseVersions(tag, "1.0.0"));
});
test("update checks coalesce, cache, throttle refresh and keep safe release URLs", async () => {
  let calls = 0, now = 100000;
  const service = new UpdateCheckService((async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.github.com/repos/minori0721/Bili-favorites-backup/releases/latest");
    assert.equal(options?.redirect, "error");
    return Response.json({ ...release, html_url: "javascript:alert(1)" });
  }) as typeof fetch, () => now, stable);
  const results = await Promise.all([service.check(), service.check(true)]);
  assert.equal(calls, 1);
  assert.equal(results[0].comparison, "update_available");
  assert.equal(results[0].release?.url, "https://github.com/minori0721/Bili-favorites-backup/releases/tag/v2.10.0");
  await service.check(true); assert.equal(calls, 1);
  now += 61000; await service.check(); assert.equal(calls, 1);
  await service.check(true); assert.equal(calls, 2);
  now += 6 * 3600000; await service.check(); assert.equal(calls, 3);
});
test("failure keeps last successful data and respects rate limiting", async () => {
  let now = 100000, calls = 0;
  const service = new UpdateCheckService((async () => ++calls === 1 ? Response.json(release)
    : new Response("secret upstream body", { status: 429, headers: { "Retry-After": "600" } })) as typeof fetch, () => now, stable);
  const good = await service.check(); now += 61000;
  const bad = await service.check(true);
  assert.ok(bad.error); assert.deepEqual(bad.release, good.release);
  assert.equal(bad.checkedAt, good.checkedAt);
  assert.ok(!JSON.stringify(bad).includes("secret"));
  now += 61000; await service.check(true); assert.equal(calls, 2);
});
test("dev and local builds are reference only; empty releases and bad responses never imply latest", async () => {
  for (const ref of ["dev", "local"]) {
    const service = new UpdateCheckService((async () => Response.json(release)) as typeof fetch, Date.now,
      buildAppInfo({ BFB_BUILD_REF: ref }, { version: "2.0.0" }));
    assert.equal((await service.check()).comparison, "reference");
  }
  for (const response of [Response.json({ ...release, draft: true }), Response.json({ ...release, prerelease: true }),
    new Response("bad json"), new Response("x".repeat(513 * 1024)), new Response("", { status: 500 })]) {
    const result = await new UpdateCheckService((async () => response) as typeof fetch).check();
    assert.ok(result.error); assert.equal(result.release, null);
  }
  const missing = await new UpdateCheckService((async () => new Response(null, { status: 404 })) as typeof fetch).check();
  assert.equal(missing.release, null); assert.equal(missing.error, null);
  const offline = await new UpdateCheckService((async () => { throw new Error("network secret"); }) as typeof fetch).check();
  assert.ok(offline.error); assert.ok(!JSON.stringify(offline).includes("secret"));
});
