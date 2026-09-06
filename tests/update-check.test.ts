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
  const missing = await new UpdateCheckService((async (url) => String(url).endsWith('/latest') ? new Response(null, { status: 404 }) : Response.json([])) as typeof fetch).check();
  assert.equal(missing.release, null); assert.equal(missing.error, null);
  const offline = await new UpdateCheckService((async () => { throw new Error("network secret"); }) as typeof fetch).check();
  assert.ok(offline.error); assert.ok(!JSON.stringify(offline).includes("secret"));
});

test('tool latest falls back to application releases, including across pages in numeric order', async () => {
  const urls: string[] = [];
  const service = new UpdateCheckService((async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return Response.json({ ...release, tag_name: 'ffmpeg-bfb-8.1.2-20260711.1' });
    if (urls.length === 2) return Response.json([{ ...release, tag_name: 'v2.9.0' }, { ...release, tag_name: 'v99.0.0', prerelease: true }], { headers: { Link: '<https://evil.invalid/>; rel="next"' } });
    return Response.json([release, { ...release, tag_name: '2.99.0' }, { ...release, tag_name: 'v3.0.0', draft: true }]);
  }) as typeof fetch, Date.now, stable);
  const result = await service.check();
  assert.equal(result.release?.version, 'v2.10.0');
  assert.equal(result.comparison, 'update_available');
  assert.equal(urls.length, 3);
  assert.ok(urls.every(url => url.startsWith('https://api.github.com/repos/minori0721/Bili-favorites-backup/releases')));
  assert.ok(urls[2].endsWith('page=2'));
});

test('incomplete or failed pagination never publishes a partial latest claim', async () => {
  for (const failure of ['incomplete', 'invalid', 'network']) {
    let calls = 0;
    const service = new UpdateCheckService((async () => {
      calls++;
      if (calls === 1) return Response.json({ ...release, tag_name: 'ffmpeg-test' });
      if (failure === 'invalid') return Response.json({ wrong: [] });
      if (failure === 'network') throw new Error('network');
      return Response.json([release], { headers: { Link: '<next>; rel="next"' } });
    }) as typeof fetch, Date.now, stable);
    const result = await service.check();
    assert.ok(result.error);
    assert.equal(result.release, null);
    assert.equal(result.comparison, 'unknown');
    assert.ok(calls <= 4);
  }
});

test('empty and truncated notes are explicit, and main images count as stable', async () => {
  for (const body of ['', 'a'.repeat(24001)]) {
    const service = new UpdateCheckService((async () => Response.json({ ...release, body })) as typeof fetch, Date.now,
      buildAppInfo({ BFB_BUILD_REF: 'main' }, { version: '2.9.0' }));
    const result = await service.check();
    assert.equal(result.comparison, 'update_available');
    assert.equal(result.release?.truncated, body.length > 24000);
    assert.equal(result.release?.notes.length, Math.min(body.length, 24000));
    assert.ok(result.release?.changelogUrl.endsWith('/v2.10.0/CHANGELOG.md'));
  }
});

test('format errors do not inherit GitHub rate reset when quota is still available', async () => {
  const now = 100000;
  const service = new UpdateCheckService((async () => Response.json({ bad: true }, { headers: {
    'x-ratelimit-remaining': '57', 'x-ratelimit-reset': String((now + 3600000) / 1000),
  } })) as typeof fetch, () => now, stable);
  const result = await service.check();
  assert.equal(result.errorCode, 'invalid_response');
  assert.equal(Date.parse(result.nextRefreshAt), now + 60000);
});
