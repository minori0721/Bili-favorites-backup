import test from 'node:test';
import assert from 'node:assert/strict';
import { findDevTestEvidence } from '../scripts/dev-test-evidence.mjs';

const repository = 'owner/repo';
const sha = 'a'.repeat(40);
const run = { id: 42, run_attempt: 1, path: '.github/workflows/docker-publish.yml', head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: repository }, head_repository: { full_name: repository } };
const options = { ref: 'refs/heads/main', event: 'push', sha, workflowSha: sha, repository, token: 'test', report: () => {} };
const step = {name: 'Test application', status: 'completed', conclusion: 'success', started_at: '2026-09-13T00:00:00Z', completed_at: '2026-09-13T00:01:00Z'};
const job = {head_sha: sha, status: 'completed', conclusion: 'success', steps: [step]};
const respond = (workflow_runs: unknown[], jobs: unknown[] = [job]) => async (url: URL) => new Response(JSON.stringify(url.pathname.endsWith('/jobs') ? {jobs} : { workflow_runs }));

test('main reuses only a successful dev push for the identical commit', async () => {
  let calls = 0;
  const result = await findDevTestEvidence({ ...options, fetchImpl: async (url: URL) => {
    calls++;
    if (url.pathname.endsWith('/jobs')) {
      assert.equal(url.pathname, '/repos/owner/repo/actions/runs/42/attempts/1/jobs');
      return new Response(JSON.stringify({jobs: [job]}));
    }
    assert.equal(url.pathname, '/repos/owner/repo/actions/workflows/docker-publish.yml/runs');
    assert.equal(url.searchParams.get('head_sha'), sha);
    assert.equal(url.searchParams.get('branch'), 'dev');
    return new Response(JSON.stringify({ workflow_runs: [run] }));
  } });
  assert.equal(result, 42);
  assert.equal(calls, 2);
});

test('changed code, incomplete or failed runs and foreign repositories require tests', async () => {
  for (const change of [
    { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'workflow_dispatch' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/repo' } }, { id: undefined },
    {path: '.github/workflows/other.yml'}, {run_attempt: undefined},
  ]) {
    assert.equal(await findDevTestEvidence({ ...options, fetchImpl: respond([{ ...run, ...change }]) }), null);
  }
});

test('green runs with missing or skipped tests are not evidence; workflow revision must match', async () => {
  for (const change of [{conclusion: 'skipped'}, {status: 'in_progress'}, {started_at: undefined}, {name: 'Build application'}]) {
    assert.equal(await findDevTestEvidence({...options, fetchImpl: respond([run], [{...job, steps: [{...step, ...change}]}])}), null);
  }
  assert.equal(await findDevTestEvidence({...options, fetchImpl: respond([run], [])}), null);
  assert.equal(await findDevTestEvidence({...options, workflowSha: 'b'.repeat(40), fetchImpl: respond([run])}), null);
  assert.equal(await findDevTestEvidence({...options, workflowSha: undefined, fetchImpl: respond([run])}), null);
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
