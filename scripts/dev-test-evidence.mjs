import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only an identical, fully successful dev push can replace main's test run.
// Missing evidence (including API failures) always falls back to running tests.
export async function findDevTestEvidence({ ref, event, sha, workflowSha, repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, report = console.warn }) {
  if (ref !== 'refs/heads/main' || event !== 'push') return null;
  if (!sha || !workflowSha || workflowSha !== sha) { report('Workflow revision is missing or differs from the tested commit; running tests.'); return null; }
  try {
    const url = new URL(`/repos/${repository}/actions/workflows/docker-publish.yml/runs`, apiUrl);
    url.search = new URLSearchParams({ branch: 'dev', event: 'push', head_sha: sha, per_page: '100' }).toString();
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`evidence API returned ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.workflow_runs)) return null;
    const candidates = body.workflow_runs.filter(run =>
      run?.head_sha === sha && run.head_branch === 'dev' && run.event === 'push' &&
      run.status === 'completed' && run.conclusion === 'success' &&
      run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
      Number.isSafeInteger(run.id) && run.id > 0 &&
      run.path === '.github/workflows/docker-publish.yml' &&
      Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    );
    for (const run of candidates) {
      const jobsResponse = await fetchImpl(new URL(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, apiUrl), {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15000),
      });
      if (!jobsResponse.ok) throw new Error(`jobs API returned ${jobsResponse.status}`);
      const jobs = await jobsResponse.json();
      // An overall green run can contain skipped tests. Require the actual step in this attempt.
      if (Array.isArray(jobs.jobs) && jobs.jobs.some(job => job.head_sha === sha && job.status === 'completed' && job.conclusion === 'success'
        && Array.isArray(job.steps) && job.steps.some(step => step.name === 'Test application' && step.status === 'completed'
          && step.conclusion === 'success' && typeof step.started_at === 'string' && typeof step.completed_at === 'string'))) return run.id;
    }
    return null;
  } catch {
    // Evidence is optional; fail closed without exposing API headers or credentials.
    report('Dev test evidence could not be verified; running the full test suite.');
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = await findDevTestEvidence({
    ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME,
    sha: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL,
  });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${runId !== null}\nrun_id=${runId ?? ''}\n`);
  const message = runId === null
    ? 'No matching successful dev evidence; running the full test suite.'
    : `Reusing executed dev tests for commit/workflow ${process.env.GITHUB_SHA}: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}. Image build, architecture and smoke checks still run.`;
  console.log(message);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
