import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { imageRebuildPlan, isCurrentImageRebuild, minimumNodeVersion, verifyNodeRuntime } from '../scripts/image-rebuild.mjs';
import { promoteImage, promotionTags } from '../scripts/promote-image.mjs';
import { createTestDir, removeTestDir } from './helpers.js';

const revision = 'a'.repeat(40);
const env = {
  INPUT_REBUILD_ONLY: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev',
  GITHUB_SHA: revision, GITHUB_REPOSITORY: 'owner/app', IMAGE_NAME: 'owner/app',
  GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1',
};
const script = fileURLToPath(new URL('../scripts/image-rebuild.mjs', import.meta.url));

test('ordinary runs retain the existing publication path; only an explicit manual branch rebuild is allowed', () => {
  for (const input of [undefined, '', 'false']) {
    assert.deepEqual(imageRebuildPlan({...env, INPUT_REBUILD_ONLY: input}), {rebuildOnly: false, tags: []});
  }
  for (const change of [
    {INPUT_REBUILD_ONLY: 'yes'}, {GITHUB_EVENT_NAME: 'push'}, {GITHUB_EVENT_NAME: 'pull_request'},
    {GITHUB_REF: 'refs/tags/v2.7.0'}, {GITHUB_REF: 'refs/heads/other'},
    {GITHUB_SHA: 'bad'}, {IMAGE_NAME: 'owner/app\nother/image'}, {GITHUB_RUN_ID: '0'}, {GITHUB_RUN_ATTEMPT: 'bad'},
  ]) assert.throws(() => imageRebuildPlan({...env, ...change}));
});

test('rebuild promotion updates only its selected channel and a unique run tag, preserving release and revision tags', async () => {
  const image = 'docker.io/owner/app';
  const digest = `sha256:${'b'.repeat(64)}`;
  for (const [ref, channel] of [['refs/heads/dev', 'dev'], ['refs/heads/main', 'latest']]) {
    const plan = imageRebuildPlan({...env, GITHUB_REF: ref});
    const fixed = `${image}:rebuild-${revision}-1234-1`;
    assert.deepEqual(plan, {rebuildOnly: true, tags: [fixed, `${image}:${channel}`]});
    const created: string[] = [];
    await promoteImage(image, digest, promotionTags(image, plan.tags.join('\n')), {
      create: tag => { created.push(tag); }, inspect: () => digest, wait: async () => {},
    });
    assert.deepEqual(created, [fixed, `${image}:${channel}`]);
    assert.ok(created.every(tag => !/:v\d|:sha-|:revision-/.test(tag)));
    const retry = imageRebuildPlan({...env, GITHUB_REF: ref, GITHUB_RUN_ATTEMPT: '2'});
    assert.notEqual(retry.tags[0], fixed, 'a rerun retains an independent fixed image reference');
  }
});

test('stale main and dev rebuilds cannot claim to be current; malformed GitHub responses fail closed', () => {
  for (const branch of ['dev', 'main']) {
    const currentEnv = {...env, GITHUB_REF: `refs/heads/${branch}`};
    const read = (sha: string) => (args: string[]) => {
      assert.deepEqual(args, ['api', `repos/owner/app/git/ref/heads/${branch}`]);
      return JSON.stringify({ref: currentEnv.GITHUB_REF, object: {type: 'commit', sha}});
    };
    assert.equal(isCurrentImageRebuild(currentEnv, read(revision)), true);
    assert.equal(isCurrentImageRebuild(currentEnv, read('c'.repeat(40))), false);
    for (const body of ['{}', '{bad', JSON.stringify({ref: 'refs/tags/dev', object: {type: 'commit', sha: revision}})]) {
      assert.throws(() => isCurrentImageRebuild(currentEnv, () => body));
    }
    assert.throws(() => isCurrentImageRebuild(currentEnv, () => { throw new Error('API unavailable'); }), /API unavailable/);
  }
  assert.throws(() => isCurrentImageRebuild({...env, INPUT_REBUILD_ONLY: 'false'}), /requires an image-only/);
});

test('the candidate runtime must include the Node 24 security patch, without accepting another major or a prerelease', () => {
  assert.equal(minimumNodeVersion, '24.22.1');
  for (const version of ['v24.22.1', '24.22.2', 'v24.23.0']) assert.equal(verifyNodeRuntime(version), version);
  for (const version of [undefined, '', 'v24.22.0', 'v24.21.9', 'v22.23.4', 'v26.12.1', 'v24.22.1-rc.1', 'v24.022.1']) {
    assert.throws(() => verifyNodeRuntime(version), /Candidate image must use Node/);
  }
});

test('the real workflow CLI isolates its outputs and bilingual summary and checks the supplied candidate runtime', async () => {
  const dir = await createTestDir('image-rebuild-cli');
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary.md');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    env: {...process.env, ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary},
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  try {
    const configured = run('configure');
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), `rebuild_only=true\ntags<<BFB_REBUILD_TAGS\ndocker.io/owner/app:rebuild-${revision}-1234-1\ndocker.io/owner/app:dev\nBFB_REBUILD_TAGS\n`);
    const guide = fs.readFileSync(summary, 'utf8');
    assert.equal(guide.split('### Summary guide / 摘要阅读说明').length - 1, 1);
    assert.ok(guide.includes('The full vulnerability report includes all known findings.'));
    assert.ok(guide.includes('完整漏洞报告列出所有已知告警'));
    assert.equal(run('verify-node', 'v24.22.1').status, 0);
    assert.notEqual(run('verify-node', 'v24.22.0').status, 0);
    assert.notEqual(run('configure', 'unexpected').status, 0);
    assert.equal(fs.readFileSync(summary, 'utf8'), guide, 'other CLI commands must not append the guide');
  } finally { await removeTestDir(dir); }
});
