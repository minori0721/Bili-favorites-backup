import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteContentReader } from '../src/remote-content-inspection.js';
import { testConfig } from './helpers.js';

const data = { name: 'v.mp4', size: 12, is_dir: false, hash_info: { md5: 'A'.repeat(32) } };
const json = (value: unknown) => new Response(JSON.stringify(value));

for (const httpAuth of [false, true]) test(`OpenList content lookup authenticates once and preserves the deployment prefix: HTTP auth=${httpAuth}`, async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input, options) => {
    const url = String(input); calls.push(url);
    assert.equal(options?.redirect, 'error');
    if (url.endsWith('/api/auth/login')) {
      assert.deepEqual(JSON.parse(String(options?.body)), { username: 'test', password: 'test' });
      return json({ code: 200, data: { token: 'fixture-token' } });
    }
    assert.equal(url, 'https://storage.example/prefix/api/fs/get');
    assert.deepEqual(JSON.parse(String(options?.body)), { path: '/backup/v.mp4', password: '' });
    if (new Headers(options?.headers).get('Authorization') !== 'fixture-token') return httpAuth ? new Response('', { status: 401 }) : json({ code: 401 });
    return json({ code: 200, data });
  };
  const reader = createRemoteContentReader(testConfig({ alistUrl: 'https://storage.example/prefix/dav/' }), request);
  for (let i = 0; i < 2; i++) assert.deepEqual(await reader('/backup/v.mp4'), { size: 12, md5: 'a'.repeat(32) });
  assert.equal(calls.filter(url => url.endsWith('login')).length, 1);
});

test('unsupported hashes stay unknown while malformed supplied metadata fails explicitly', async () => {
  for (const hash_info of [null, {}, { md5: '' }]) {
    const reader = createRemoteContentReader(testConfig(), async () => json({ code: 200, data: { ...data, hash_info } }));
    assert.equal(await reader('/backup/v.mp4'), null);
  }
  for (const patch of [{ size: '12' }, { name: 'other.mp4' }, { is_dir: true }, { hash_info: { md5: 12 } }, { hash_info: '{' }]) {
    const reader = createRemoteContentReader(testConfig(), async () => json({ code: 200, data: { ...data, ...patch } }));
    await assert.rejects(reader('/backup/v.mp4'), /存储文件内容校验查询失败/);
  }
  const reader = createRemoteContentReader(testConfig(), async () => json({ code: 200, data: { ...data, hash_info: JSON.stringify(data.hash_info) } }));
  assert.equal((await reader('/backup/v.mp4'))?.md5, 'a'.repeat(32));
});

test('unsupported endpoints do not grant proof and transport errors do not expose secrets', async () => {
  const unsupported = createRemoteContentReader(testConfig(), async () => new Response('', { status: 404 }));
  assert.equal(await unsupported('/backup/v.mp4'), null);
  const failed = createRemoteContentReader(testConfig(), async () => { throw new Error('secret-cookie private-path'); });
  await assert.rejects(failed('/backup/v.mp4'), error => error instanceof Error && !/secret|private-path/.test(error.message) && /校验查询失败/.test(error.message));
});
