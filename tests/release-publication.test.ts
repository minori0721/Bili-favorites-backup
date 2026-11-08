import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {imagePublicationPlan} from '../scripts/image-rebuild.mjs';
import {checkStablePublication, publishStableRelease} from '../scripts/publish-release.mjs';
import {createTestDir, removeTestDir} from './helpers.js';

const revision = 'a'.repeat(40);
const otherRevision = 'c'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const image = 'docker.io/owner/app';
const build = {ref: 'refs/heads/main', repository: 'owner/app', revision, tag: 'v2.8.0', image, digest};
const env = {GITHUB_REF: build.ref, GITHUB_SHA: revision, IMAGE_NAME: 'owner/app',
  GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1'};

interface Release {
  tag_name: string; name: string; body: string; draft: boolean; prerelease: boolean;
}
interface FakeOptions {
  main?: string;
  target?: {type: string; sha: string} | null;
  annotated?: {type: string; sha: string};
  published?: Release | null;
  newer?: boolean;
  tagFailure?: 'before' | 'after';
  releaseFailures?: number;
}
function fakePublication(notes: string, options: FakeOptions = {}) {
  const state = {main: options.main ?? revision, target: options.target ?? null,
    published: options.published ?? null, releaseFailures: options.releaseFailures ?? 0};
  const calls: string[][] = [];
  const images = new Map([[`${image}:${build.tag}`, digest], [`${image}:latest`, digest]]);
  const gh = (args: string[]) => {
    calls.push(args);
    const endpoint = args[0] === 'api' ? args.find(arg => arg.startsWith('repos/')) : '';
    if (endpoint?.endsWith('/git/ref/heads/main')) return JSON.stringify({ref: build.ref, object: {type: 'commit', sha: state.main}});
    if (endpoint?.includes('/releases?')) return JSON.stringify([[...(state.published ? [state.published] : []),
      ...(options.newer ? [{tag_name: 'v2.9.0', draft: false, prerelease: false}] : [])]]);
    if (endpoint?.includes('/git/matching-refs/')) return JSON.stringify([
      {ref: `refs/tags/${build.tag}0`, object: {type: 'commit', sha: otherRevision}},
      ...(state.target ? [{ref: `refs/tags/${build.tag}`, object: state.target}] : []),
    ]);
    if (endpoint?.includes('/git/tags/')) return JSON.stringify({object: options.annotated});
    if (endpoint?.endsWith('/git/refs') && args.includes('POST')) {
      if (options.tagFailure === 'before') throw new Error('tag request unavailable');
      state.target = {type: 'commit', sha: revision};
      if (options.tagFailure === 'after') throw new Error('tag response lost');
      return '{}';
    }
    if (args[0] === 'release' && args[1] === 'create') {
      if (state.releaseFailures-- > 0) throw new Error('release API unavailable');
      assert.ok(args.includes('--verify-tag'));
      assert.equal(args[args.indexOf('--repo') + 1], build.repository);
      state.published = {tag_name: build.tag, name: build.tag, body: notes, draft: false, prerelease: false};
      return '{}';
    }
    if (endpoint?.endsWith(`/releases/tags/${build.tag}`)) return JSON.stringify(state.published);
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  return {state, calls, images, gh, inspect: (reference: string) => images.get(reference) ?? null,
    writes: () => calls.filter(args => args.includes('POST') || args[0] === 'release')};
}

test('one main image supplies both stable tags; dev and image-only rebuilds keep separate publication plans', () => {
  const stable = imagePublicationPlan('2.8.0', env);
  assert.deepEqual(stable, {rebuildOnly: false, version: '2.8.0', releaseTag: 'v2.8.0', buildRef: 'v2.8.0',
    tags: [`${image}:sha-aaaaaaa`, `${image}:revision-${revision}`, `${image}:v2.8.0`, `${image}:latest`]});
  const dev = imagePublicationPlan('2.8.1-dev', {...env, GITHUB_REF: 'refs/heads/dev'});
  assert.equal(dev.buildRef, 'dev');
  assert.equal(dev.releaseTag, '');
  assert.deepEqual(dev.tags, [`${image}:sha-aaaaaaa`, `${image}:revision-${revision}`, `${image}:dev`]);
  for (const [branch, channel] of [['main', 'latest'], ['dev', 'dev']]) {
    const plan = imagePublicationPlan(branch === 'main' ? '2.8.0' : '2.8.1-dev', {...env,
      GITHUB_REF: `refs/heads/${branch}`, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REBUILD_ONLY: 'true'});
    assert.equal(plan.releaseTag, '');
    assert.equal(plan.buildRef, branch);
    assert.deepEqual(plan.tags, [`${image}:rebuild-${revision}-123-1`, `${image}:${channel}`]);
  }
});

test('publication plans reject unsupported refs, development versions on main and invalid image identities', () => {
  for (const version of ['2.8.0-dev', '2.8.0-rc.1', '02.8.0', 'bad']) assert.throws(() => imagePublicationPlan(version, env));
  for (const change of [{GITHUB_REF: 'refs/tags/v2.8.0'}, {GITHUB_REF: 'refs/heads/feature'},
    {GITHUB_SHA: 'bad'}, {IMAGE_NAME: 'owner/app\nother/image'}]) {
    assert.throws(() => imagePublicationPlan('2.8.0', {...env, ...change}));
  }
});

test('the production plan CLI reads package and lock metadata without emitting a second summary guide', async () => {
  const dir = await createTestDir('publication-plan');
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  const script = fileURLToPath(new URL('../scripts/image-rebuild.mjs', import.meta.url));
  try {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({version: '2.8.0'}));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({version: '2.8.0', packages: {'': {version: '2.8.0'}}}));
    await fs.writeFile(summary, 'existing guide\n');
    const result = spawnSync(process.execPath, [script, 'plan'], {cwd: dir, encoding: 'utf8', windowsHide: true,
      timeout: 10_000, env: {...process.env, ...env, INPUT_REBUILD_ONLY: 'false', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary}});
    assert.equal(result.status, 0, result.stderr);
    const content = await fs.readFile(output, 'utf8');
    assert.match(content, /build_ref=v2\.8\.0\nrelease_tag=v2\.8\.0/);
    assert.ok(content.includes(`${image}:v2.8.0\n${image}:latest`));
    assert.equal(await fs.readFile(summary, 'utf8'), 'existing guide\n');
    const releaseScript = fileURLToPath(new URL('../scripts/publish-release.mjs', import.meta.url));
    const rebuild = spawnSync(process.execPath, [releaseScript, 'publish', 'v2.8.0', 'unused.md'], {
      cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: {...process.env, ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REBUILD_ONLY: 'true'},
    });
    assert.notEqual(rebuild.status, 0);
    assert.match(rebuild.stderr, /Image-only rebuilds do not publish application releases/);
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({version: '2.8.1', packages: {'': {version: '2.8.0'}}}));
    const invalid = spawnSync(process.execPath, [script, 'plan'], {cwd: dir, encoding: 'utf8', windowsHide: true,
      timeout: 10_000, env: {...process.env, ...env, GITHUB_OUTPUT: output}});
    assert.notEqual(invalid.status, 0);
    assert.equal(await fs.readFile(output, 'utf8'), content, 'invalid plans do not append outputs');
  } finally { await removeTestDir(dir); }
});

test('checks accept current main and matching lightweight or annotated tags, without writing', () => {
  for (const options of [{}, {target: {type: 'commit', sha: revision}},
    {target: {type: 'tag', sha: otherRevision}, annotated: {type: 'commit', sha: revision}}]) {
    const fake = fakePublication('', options);
    assert.equal(checkStablePublication(build, fake.gh), true);
    assert.deepEqual(fake.writes(), []);
  }
});

test('obsolete main, older releases and conflicting or malformed fixed tags never authorize publication', () => {
  const obsolete = fakePublication('', {main: otherRevision});
  assert.equal(checkStablePublication(build, obsolete.gh), false);
  assert.deepEqual(obsolete.writes(), []);
  for (const options of [{newer: true}, {target: {type: 'commit', sha: otherRevision}},
    {target: {type: 'tree', sha: revision}}, {target: {type: 'tag', sha: otherRevision}, annotated: {type: 'tree', sha: revision}}]) {
    const fake = fakePublication('', options);
    assert.throws(() => checkStablePublication(build, fake.gh));
    assert.deepEqual(fake.writes(), []);
  }
  assert.throws(() => checkStablePublication(build, () => {throw new Error('API unavailable');}), /API unavailable/);
  for (const body of ['{}', '{bad', JSON.stringify({ref: build.ref, object: {type: 'commit', sha: 'bad'}})]) {
    assert.throws(() => checkStablePublication(build, () => body));
  }
  assert.throws(() => checkStablePublication({...build, ref: 'refs/heads/dev'}), /requires main/);
  for (const fields of [{draft: true}, {prerelease: true}, {}]) {
    const fake = fakePublication('', {published: {tag_name: build.tag, name: build.tag, body: '', draft: false, prerelease: false, ...fields}});
    assert.throws(() => checkStablePublication(build, fake.gh));
    assert.deepEqual(fake.writes(), []);
  }
});

test('the same verified image is required before creating any tag or release', async () => {
  const dir = await createTestDir('stable-image-proof');
  const notesFile = path.join(dir, 'notes.md');
  const notes = '### 发布摘要\n- Example\n';
  await fs.writeFile(notesFile, notes);
  try {
    for (const tag of [build.tag, 'latest']) for (const wrong of [null, `sha256:${'d'.repeat(64)}`]) {
      const fake = fakePublication(notes);
      if (wrong) fake.images.set(`${image}:${tag}`, wrong); else fake.images.delete(`${image}:${tag}`);
      assert.throws(() => publishStableRelease(build, notesFile, fake), /does not match/);
      assert.deepEqual(fake.writes(), []);
    }
    const stale = fakePublication(notes, {main: otherRevision});
    assert.throws(() => publishStableRelease(build, notesFile, stale), /Main advanced/);
    assert.deepEqual(stale.writes(), []);
  } finally { await removeTestDir(dir); }
});

test('stable publication creates the exact tag and release once and verifies the published result', async () => {
  const dir = await createTestDir('stable-publication');
  const notesFile = path.join(dir, 'notes.md');
  const notes = '### 发布摘要\n- Example\n';
  await fs.writeFile(notesFile, notes);
  try {
    const fake = fakePublication(notes);
    assert.match(publishStableRelease(build, notesFile, fake), /Verified release: https:\/\/github\.com\/owner\/app\/releases\/tag\/v2\.8\.0/);
    assert.deepEqual(fake.state.target, {type: 'commit', sha: revision});
    assert.equal(fake.state.published?.prerelease, false);
    assert.equal(fake.writes().length, 2);
    assert.equal(fake.calls.findIndex(args => args[0] === 'release') > fake.calls.findIndex(args => args.includes('POST')), true);
    publishStableRelease(build, notesFile, fake);
    assert.equal(fake.writes().length, 2, 'retries preserve the existing tag and release');
  } finally { await removeTestDir(dir); }
});

test('lost tag responses are recovered only by reading the exact target; unsuccessful creation stops release', async () => {
  const dir = await createTestDir('stable-tag-response');
  const notesFile = path.join(dir, 'notes.md');
  const notes = '### 发布摘要\n- Example\n';
  await fs.writeFile(notesFile, notes);
  try {
    const accepted = fakePublication(notes, {tagFailure: 'after'});
    publishStableRelease(build, notesFile, accepted);
    assert.ok(accepted.state.published);
    const rejected = fakePublication(notes, {tagFailure: 'before'});
    assert.throws(() => publishStableRelease(build, notesFile, rejected), /tag request unavailable/);
    assert.equal(rejected.state.published, null);
    assert.equal(rejected.calls.filter(args => args[0] === 'release').length, 0);
  } finally { await removeTestDir(dir); }
});

test('a failed release request can be retried with the same image and tag; changed release content is never reported as success', async () => {
  const dir = await createTestDir('stable-release-retry');
  const notesFile = path.join(dir, 'notes.md');
  const notes = '### 发布摘要\n- Example\n';
  await fs.writeFile(notesFile, notes);
  try {
    const fake = fakePublication(notes, {releaseFailures: 1});
    assert.throws(() => publishStableRelease(build, notesFile, fake), /release API unavailable/);
    assert.deepEqual(fake.state.target, {type: 'commit', sha: revision});
    publishStableRelease(build, notesFile, fake);
    assert.equal(fake.calls.filter(args => args.includes('POST')).length, 1);
    fake.state.published!.body = 'unexpected notes';
    const previousWrites = fake.writes().length;
    assert.throws(() => publishStableRelease(build, notesFile, fake), /does not match/);
    assert.equal(fake.writes().length, previousWrites);
  } finally { await removeTestDir(dir); }
});

test('the real workflow gates publication on separate successful jobs and carries the immutable image digest', async () => {
  const source = (await fs.readFile(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const testJob = source.split('\n  test:\n')[1]?.split('\n  image:\n')[0];
  const imageJob = source.split('\n  image:\n')[1]?.split('\n  publish:\n')[0];
  const publishJob = source.split('\n  publish:\n')[1];
  assert.ok(testJob && imageJob && publishJob);
  assert.match(source, /^concurrency:\n  group: bfb-image-\$\{\{ github.ref \}\}\n  cancel-in-progress: false/m);
  assert.doesNotMatch(source.split('\njobs:\n')[0], /\n    tags:/);
  assert.match(testJob, /name: Test application\n        run: npm test/);
  assert.match(testJob, /npm ci --foreground-scripts --timing --loglevel=info/);
  assert.match(testJob, /run: npm audit --omit=dev --audit-level=high/);
  assert.match(imageJob, /^    needs: test/m);
  assert.match(imageJob, /digest: \$\{\{ steps.image.outputs.digest \}\}/);
  for (const name of ['Build and push candidate by digest', 'Smoke test the candidate image in isolation',
    'Record all candidate image vulnerabilities', 'Reject fixable critical and high image vulnerabilities', 'Report and verify image layer reuse']) {
    assert.ok(imageJob.includes(`name: ${name}`));
  }
  assert.doesNotMatch(imageJob, /run: npm (?:ci|test|audit)|scripts\/promote-image\.mjs/);
  assert.match(imageJob, /BFB_BUILD_REF=\$\{\{ steps.publication.outputs.build_ref \}\}/);
  assert.match(publishJob, /^    needs: image/m);
  assert.match(publishJob, /IMAGE_DIGEST: \$\{\{ needs.image.outputs.digest \}\}/);
  assert.match(publishJob, /steps.promote.outcome == 'success' && steps.publication.outputs.release_tag != ''/);
  assert.match(publishJob, /node scripts\/publish-release\.mjs publish/);
  assert.doesNotMatch(publishJob, /build-push-action|npm ci|npm test|if:.*always\(/);
  assert.doesNotMatch(source, /continue-on-error/);
  assert.equal(source.split('npm ci --foreground-scripts').length - 1, 1);
  assert.equal(source.split('run: node scripts/image-rebuild.mjs configure').length - 1, 1);
});
