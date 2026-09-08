import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only an identical, fully successful dev push can replace main's test run.
// Missing evidence (including API failures) always falls back to running tests.
export async function findDevTestEvidence({ ref, event, sha, repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (ref !== 'refs/heads/main' || event !== 'push') return null;
  try {
    const url = new URL(`/repos/${repository}/actions/workflows/docker-publish.yml/runs`, apiUrl);
    url.search = new URLSearchParams({ branch: 'dev', event: 'push', head_sha: sha, per_page: '100' }).toString();
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!Array.isArray(body?.workflow_runs)) return null;
    return body.workflow_runs.find(run =>
      run?.head_sha === sha && run.head_branch === 'dev' && run.event === 'push' &&
      run.status === 'completed' && run.conclusion === 'success' &&
      run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
      Number.isSafeInteger(run.id) && run.id > 0
    )?.id ?? null;
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = await findDevTestEvidence({
    ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME,
    sha: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL,
  });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${runId !== null}\n`);
  const message = runId === null
    ? 'No matching successful dev evidence; running the full test suite.'
    : `Reusing successful dev tests for ${process.env.GITHUB_SHA}: run ${runId}. Image build and smoke checks still run.`;
  console.log(message);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
