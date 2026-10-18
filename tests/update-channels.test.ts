import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateCheckService } from '../src/update-check.js';
import { buildAppInfo } from '../src/app-info.js';
import { parseRelease, releaseNotes } from '../src/update-release.js';
import { decodeUpdatesResponse } from '../src/shared/api/updates.js';
import { updatesFixture } from './fixtures/updates.js';

const currentRevision = 'a'.repeat(40), nextRevision = 'b'.repeat(40);
const info = buildAppInfo({ BFB_BUILD_REF: 'dev', BFB_BUILD_REVISION: currentRevision }, { version: '2.7.0-dev' });
const date = '2026-10-19T00:00:00Z';
const stable = (version = '2.6.5') => ({ tag_name: 'v' + version, draft: false, prerelease: false, published_at: date, body: '### 正式说明\n正式内容' });
const dev = (revision = nextRevision) => ({ tag_name: 'dev-preview', draft: false, prerelease: true, updated_at: date,
  body: `<!-- bfb-build:${JSON.stringify({ version: '2.7.0-dev', revision })} -->\n### 开发说明\n新版内容` });

test('development uses the published preview and commit ancestry, with stable independently available', async () => {
  const calls: string[] = [];
  const service = new UpdateCheckService(async url => {
    calls.push(String(url));
    return Response.json(String(url).includes('/compare/') ? { status: 'ahead' } : String(url).endsWith('/dev-preview') ? dev() : stable('2.7.0'));
  }, Date.now, info);
  const data = await service.check();
  assert.equal(data.channel, 'dev');
  assert.equal(data.channels.dev?.comparison, 'update_available');
  assert.equal(data.channels.stable.comparison, 'update_available');
  assert.equal(data.notification?.id, 'dev:' + nextRevision);
  assert.equal(data.notification?.channel, 'dev');
  assert.ok(calls.some(url => url.endsWith(`/compare/${currentRevision}...${nextRevision}`)));
  assert.doesNotMatch(data.release?.notes || '', /bfb-build/);
  assert.deepEqual(decodeUpdatesResponse(data), data);
});

test('identical and older dev commits do not trigger an update and divergent histories remain unknown', async () => {
  for (const [revision, state, comparison] of [[currentRevision, 'identical', 'up_to_date'], [nextRevision, 'behind', 'ahead'], [nextRevision, 'diverged', 'unknown']] as const) {
    let comparisons = 0;
    const service = new UpdateCheckService(async url => {
      if (String(url).includes('/compare/')) { comparisons++; return Response.json({ status: state }); }
      return Response.json(String(url).endsWith('/dev-preview') ? dev(revision) : stable());
    }, Date.now, info);
    const data = await service.check();
    assert.equal(data.channels.dev?.comparison, comparison);
    assert.equal(data.notification, null);
    assert.equal(comparisons, revision === currentRevision ? 0 : 1);
    if (state === 'diverged') assert.equal(data.channels.dev?.errorCode, 'diverged');
  }
});

test('a formal release is a channel switch for dev, never a downgrade prompt', async () => {
  for (const version of ['2.6.5', '2.7.0', '2.7.1']) {
    const service = new UpdateCheckService(async url => Response.json(String(url).endsWith('/dev-preview') ? dev(currentRevision) : stable(version)), Date.now, info);
    const data = await service.check();
    assert.equal(data.notification?.kind ?? null, version === '2.6.5' ? null : 'stable_available');
    if (data.notification) assert.match(data.notification.label, /正式版已发布/);
  }
});

test('stable and local builds never request preview or commit comparison endpoints', async () => {
  for (const buildRef of ['main', 'v2.6.5', 'local']) {
    const calls: string[] = [];
    const service = new UpdateCheckService(async url => { calls.push(String(url)); return Response.json(stable('2.7.0')); }, Date.now,
      buildAppInfo({ BFB_BUILD_REF: buildRef }, { version: '2.6.5' }));
    const data = await service.check();
    assert.equal(data.channels.dev, null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/releases/latest'));
    assert.equal(data.notification?.channel ?? null, buildRef === 'local' ? null : 'stable');
  }
});

test('dev and stable caches have separate lifetimes, coalesce requests and throttle manual refresh', async () => {
  let now = 1_000_000, devCalls = 0, stableCalls = 0;
  const service = new UpdateCheckService(async url => {
    if (String(url).endsWith('/dev-preview')) { devCalls++; return Response.json(dev(currentRevision)); }
    stableCalls++; return Response.json(stable());
  }, () => now, info);
  await Promise.all([service.check(), service.check(true), service.check()]);
  assert.deepEqual([devCalls, stableCalls], [1, 1]);
  await service.check(true);
  assert.deepEqual([devCalls, stableCalls], [1, 1]);
  now += 30 * 60000;
  await service.check();
  assert.deepEqual([devCalls, stableCalls], [2, 1]);
  now += 61000;
  await service.check(true);
  assert.deepEqual([devCalls, stableCalls], [3, 2]);
});

test('one failed channel keeps its old notes without suppressing a healthy channel update', async () => {
  let now = 1_000_000, fail = false;
  const service = new UpdateCheckService(async url => {
    if (String(url).endsWith('/dev-preview')) return fail ? new Response(null, { status: 503 }) : Response.json(dev(currentRevision));
    return Response.json(stable('2.7.0'));
  }, () => now, info);
  const first = await service.check();
  now += 61000; fail = true;
  const next = await service.check(true);
  assert.deepEqual(next.channels.dev?.release, first.channels.dev?.release);
  assert.equal(next.channels.dev?.comparison, 'unknown');
  assert.equal(next.notification?.kind, 'stable_available');
  assert.equal(next.channels.dev?.checkedAt, first.channels.dev?.checkedAt);
});

test('refresh failures retain the last confirmed update until a successful check supersedes it', async () => {
  let now = 1_000_000, phase = 0;
  const service = new UpdateCheckService(async url => {
    if (String(url).endsWith('/dev-preview')) return phase === 1 ? new Response(null, { status: 503 }) : Response.json(dev(phase === 2 ? currentRevision : nextRevision));
    return Response.json(String(url).includes('/compare/') ? { status: 'ahead' } : stable());
  }, () => now, info);
  const first = await service.check();
  assert.equal(first.notification?.id, 'dev:' + nextRevision);
  now += 61000; phase = 1;
  const failed = await service.check(true);
  assert.deepEqual(failed.notification, first.notification);
  assert.equal(failed.channels.dev?.comparison, 'unknown');
  assert.ok(failed.channels.dev?.error);
  now += 61000; phase = 2;
  assert.equal((await service.check(true)).notification, null);
});

test('invalid dev metadata and commit comparison never claim an update; the first preview remains compatible', async () => {
  const legacy = { ...dev(), body: `- 程序版本：\`2.7.0-dev\`\n- 对应提交：[\`${nextRevision}\`](https://github.com/example)\n旧发布格式` };
  assert.equal(parseRelease(legacy, 'dev')?.revision, nextRevision);
  for (const body of ['<!-- bfb-build:bad -->', '<!-- bfb-build:{"version":"2.7.0-dev","revision":"bad"} -->', dev().body + dev().body]) {
    assert.throws(() => parseRelease({ ...dev(), body }, 'dev'));
  }
  const malformed = new UpdateCheckService(async url => Response.json(String(url).includes('/compare/') ? { status: 'not-a-status' } : String(url).endsWith('/dev-preview') ? dev() : stable()), Date.now, info);
  assert.equal((await malformed.check()).channels.dev?.errorCode, 'invalid_response');
});

test('current notes stay fixed while rolling preview notes change; the browser rejects malformed DTOs', async () => {
  const embedded = releaseNotes('dev', 'v2.7.0-dev', currentRevision, '', '旧构建自己的说明');
  const service = new UpdateCheckService(async url => Response.json(String(url).includes('/compare/') ? { status: 'ahead' } : String(url).endsWith('/dev-preview') ? dev() : stable()), Date.now, info, embedded);
  const data = await service.check();
  assert.match(data.currentRelease?.notes || '', /旧构建/);
  assert.match(data.channels.dev?.release?.notes || '', /新版内容/);
  const good = updatesFixture('dev-update');
  assert.deepEqual(decodeUpdatesResponse(good), good);
  for (const broken of [{}, { ...good, notification: { id: 12 } }, { ...good, channels: { stable: {} } },
    { ...good, currentRelease: { ...good.currentRelease, url: 'javascript:alert(1)' } }]) assert.throws(() => decodeUpdatesResponse(broken));
});
