import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findTestEvidence } from '../scripts/dev-test-evidence.mjs';
import { createTestDir, removeTestDir } from './helpers.js';

const repository = 'owner/repo';
const sha = 'a'.repeat(40);
const run = { id: 42, run_attempt: 1, path: '.github/workflows/docker-publish.yml', head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed' as const, conclusion: 'success', repository: { full_name: repository }, head_repository: { full_name: repository } };
const options = { ref: 'refs/heads/main', event: 'push', sha, workflowSha: sha, repository, token: 'test', report: () => {} };
const tagOptions = { ...options, ref: 'refs/tags/v2.7.2' };
const mainRun = { ...run, id: 43, head_branch: 'main' };
const evidenceSources = [
  { options, run }, { options: tagOptions, run: mainRun }, { options: tagOptions, run },
];
const step = {name: 'Test application', status: 'completed' as const, conclusion: 'success', started_at: '2026-09-13T00:00:00Z', completed_at: '2026-09-13T00:01:00Z'};
const job = {head_sha: sha, status: 'completed' as const, conclusion: 'success', steps: [step]};
const respond = (workflow_runs: unknown[], jobs: unknown[] = [job]) => async (url: URL) => new Response(JSON.stringify(url.pathname.endsWith('/jobs') ? {jobs} : { workflow_runs }));

test('main reuses only a successful dev push for the identical commit', async () => {
  let calls = 0;
  const result = await findTestEvidence({ ...options, fetchImpl: async (url: URL) => {
    calls++;
    if (url.pathname.endsWith('/jobs')) {
      assert.equal(url.pathname, '/repos/owner/repo/actions/runs/42/attempts/1/jobs');
      return new Response(JSON.stringify({jobs: [job]}));
    }
    assert.equal(url.pathname, '/repos/owner/repo/actions/workflows/docker-publish.yml/runs');
    assert.equal(url.searchParams.get('head_sha'), sha);
    assert.equal(url.searchParams.get('branch'), 'dev');
    assert.equal(url.searchParams.get('event'), 'push');
    return new Response(JSON.stringify({ workflow_runs: [run] }));
  } });
  assert.equal(result, 42);
  assert.equal(calls, 2);
});

test('release tags prefer directly executed main tests without querying dev', async () => {
  const branches: (string | null)[] = [];
  assert.equal(await findTestEvidence({ ...tagOptions, fetchImpl: async (url: URL) => {
    if (url.pathname.endsWith('/jobs')) {
      assert.equal(url.pathname, '/repos/owner/repo/actions/runs/43/attempts/1/jobs');
      return new Response(JSON.stringify({ jobs: [job] }));
    }
    branches.push(url.searchParams.get('branch'));
    assert.equal(url.searchParams.get('head_sha'), sha);
    assert.equal(url.searchParams.get('event'), 'push');
    return new Response(JSON.stringify({ workflow_runs: [mainRun] }));
  } }), 43);
  assert.deepEqual(branches, ['main']);
});

test('release tags find executed dev tests when main has none or reused its tests', async () => {
  for (const mainRuns of [[], [mainRun]]) {
    const branches: (string | null)[] = [];
    const attempts: string[] = [];
    assert.equal(await findTestEvidence({ ...tagOptions, fetchImpl: async (url: URL) => {
      if (url.pathname.endsWith('/jobs')) {
        attempts.push(url.pathname);
        return new Response(JSON.stringify({ jobs: [url.pathname.includes('/43/')
          ? { ...job, steps: [{ ...step, conclusion: 'skipped' }] } : job] }));
      }
      const branch = url.searchParams.get('branch');
      branches.push(branch);
      return new Response(JSON.stringify({ workflow_runs: branch === 'main' ? mainRuns : [run] }));
    } }), 42);
    assert.deepEqual(branches, ['main', 'dev']);
    assert.deepEqual(attempts, [...(mainRuns.length ? ['/repos/owner/repo/actions/runs/43/attempts/1/jobs'] : []),
      '/repos/owner/repo/actions/runs/42/attempts/1/jobs']);
  }
});

test('main still requires dev evidence rather than reusing its own earlier push', async () => {
  assert.equal(await findTestEvidence({ ...options, fetchImpl: respond([mainRun]) }), null);
});

test('changed code, incomplete or failed runs and foreign repositories require tests on main and release tags', async () => {
  for (const source of evidenceSources) for (const change of [
    { head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'workflow_dispatch' },
    { status: 'in_progress' as const }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/repo' } }, { id: undefined },
    {path: '.github/workflows/other.yml'}, {run_attempt: undefined},
  ]) {
    assert.equal(await findTestEvidence({ ...source.options, fetchImpl: respond([{ ...source.run, ...change }]) }), null);
  }
});

test('green runs with missing or skipped tests are not evidence; workflow revision must match', async () => {
  for (const source of evidenceSources) {
    for (const change of [{conclusion: 'skipped'}, {conclusion: 'failure'}, {status: 'in_progress' as const},
      {started_at: undefined}, {completed_at: undefined}, {name: 'Build application'}]) {
      assert.equal(await findTestEvidence({...source.options, fetchImpl: respond([source.run], [{...job, steps: [{...step, ...change}]}])}), null);
    }
    for (const jobs of [[], [{...job, head_sha: 'b'.repeat(40)}], [{...job, conclusion: 'failure'}]]) {
      assert.equal(await findTestEvidence({...source.options, fetchImpl: respond([source.run], jobs)}), null);
    }
    for (const workflowSha of ['b'.repeat(40), undefined]) {
      let calls = 0;
      assert.equal(await findTestEvidence({...source.options, workflowSha, fetchImpl: () => { calls++; throw new Error('must not query'); }}), null);
      assert.equal(calls, 0);
    }
  }
});

test('dev, non-release refs and all manual runs always test without querying evidence', async () => {
  for (const change of [
    { ref: 'refs/heads/dev' }, { ref: 'refs/heads/feature' }, { ref: 'refs/pull/1/merge' },
    ...['dev-preview', 'v2.7.2-dev', 'v2.7.2-rc.1', 'v02.7.2', 'v2.7', '2.7.2'].map(tag => ({ ref: `refs/tags/${tag}` })),
    { event: 'workflow_dispatch' }, { ref: 'refs/heads/dev', event: 'workflow_dispatch' },
    { ref: 'refs/tags/v2.7.2', event: 'workflow_dispatch' },
  ]) {
    let calls = 0;
    assert.equal(await findTestEvidence({ ...options, ...change, fetchImpl: () => { calls++; throw new Error('must not query'); } }), null);
    assert.equal(calls, 0);
  }
});

test('missing, malformed, forbidden or unavailable evidence falls back to full tests', async () => {
  for (const target of [options, tagOptions]) for (const fetchImpl of [respond([]), async () => new Response('{}'), async () => new Response('bad JSON'),
    async () => new Response('', { status: 403 }), async () => { throw new Error('timeout'); }]) {
    assert.equal(await findTestEvidence({ ...target, fetchImpl }), null);
  }
});

test('release tags without either branch evidence run the full suite', async () => {
  const branches: (string | null)[] = [];
  assert.equal(await findTestEvidence({ ...tagOptions, fetchImpl: async (url: URL) => {
    branches.push(url.searchParams.get('branch'));
    return new Response(JSON.stringify({ workflow_runs: [] }));
  } }), null);
  assert.deepEqual(branches, ['main', 'dev']);
});

test('only the selected successful run attempt supplies test evidence', async () => {
  for (const source of evidenceSources) {
    const selectedRun = { ...source.run, run_attempt: 2 };
    assert.equal(await findTestEvidence({ ...source.options, fetchImpl: async (url: URL) => {
      if (url.pathname.endsWith('/jobs')) {
        assert.equal(url.pathname, `/repos/owner/repo/actions/runs/${selectedRun.id}/attempts/2/jobs`);
        return new Response(JSON.stringify({ jobs: [job] }));
      }
      return new Response(JSON.stringify({ workflow_runs: [selectedRun] }));
    } }), selectedRun.id);
  }
});

test('jobs API failures never turn a successful workflow summary into test evidence', async () => {
  for (const source of evidenceSources) for (const body of [new Response('', { status: 403 }), new Response('invalid JSON'), new Response('{}')]) {
    assert.equal(await findTestEvidence({ ...source.options, fetchImpl: async (url: URL) => {
      return url.pathname.endsWith('/jobs') ? body : new Response(JSON.stringify({ workflow_runs: [source.run] }));
    } }), null);
  }
});

test('the workflow CLI emits the reuse decision and links to the actual test run', async () => {
  const directory = await createTestDir('test-evidence-cli');
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(url.pathname.endsWith('/jobs') ? { jobs: [job] }
      : { workflow_runs: [url.searchParams.get('branch') === 'main' ? mainRun : run] }));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const [ref, expectedRun] of [['refs/heads/main', 42], ['refs/tags/v2.7.2', 43]] as const) {
      const output = path.join(directory, 'output');
      const summary = path.join(directory, 'summary');
      await fs.writeFile(output, '');
      await fs.writeFile(summary, '');
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/dev-test-evidence.mjs', import.meta.url))], {
        windowsHide: true, timeout: 10_000,
        env: { ...process.env, GITHUB_REF: ref, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
          GITHUB_REPOSITORY: repository, GH_TOKEN: 'test', GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      });
      assert.equal(await fs.readFile(output, 'utf8'), `reuse=true\nrun_id=${expectedRun}\n`);
      assert.ok((await fs.readFile(summary, 'utf8')).includes(`https://github.com/${repository}/actions/runs/${expectedRun}`));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await removeTestDir(directory);
  }
});
