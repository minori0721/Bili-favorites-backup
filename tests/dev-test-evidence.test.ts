import test from 'node:test';
import assert from 'node:assert/strict';
import { findDevTestEvidence } from '../scripts/dev-test-evidence.mjs';

const repository = 'owner/repo';
const sha = 'a'.repeat(40);
const run = { id: 42, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: repository }, head_repository: { full_name: repository } };
const options = { ref: 'refs/heads/main', event: 'push', sha, repository, token: 'test' };
const respond = (workflow_runs: unknown[]) => async () => new Response(JSON.stringify({ workflow_runs }));

test('main reuses only a successful dev push for the identical commit', async () => {
  let calls = 0;
  const result = await findDevTestEvidence({ ...options, fetchImpl: async (url: URL) => {
    calls++;
    assert.equal(url.pathname, '/repos/owner/repo/actions/workflows/docker-publish.yml/runs');
    assert.equal(url.searchParams.get('head_sha'), sha);
    assert.equal(url.searchParams.get('branch'), 'dev');
    return new Response(JSON.stringify({ workflow_runs: [run] }));
  } });
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test('changed code, incomplete or failed runs and foreign repositories require tests', async () => {
  for (const change of [
    { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'workflow_dispatch' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/repo' } }, { id: undefined },
  ]) {
    assert.equal(await findDevTestEvidence({ ...options, fetchImpl: respond([{ ...run, ...change }]) }), null);
  }
});

test('dev, tags and manual runs always test without querying evidence', async () => {
  for (const change of [{ ref: 'refs/heads/dev' }, { ref: 'refs/tags/v2.6.0' }, { event: 'workflow_dispatch' }]) {
    let calls = 0;
    assert.equal(await findDevTestEvidence({ ...options, ...change, fetchImpl: () => { calls++; throw new Error('must not query'); } }), null);
    assert.equal(calls, 0);
  }
});

test('missing, malformed, forbidden or unavailable evidence falls back to full tests', async () => {
  for (const fetchImpl of [respond([]), async () => new Response('{}'), async () => new Response('bad JSON'),
    async () => new Response('', { status: 403 }), async () => { throw new Error('timeout'); }]) {
    assert.equal(await findDevTestEvidence({ ...options, fetchImpl }), null);
  }
});
