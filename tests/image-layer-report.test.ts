import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheDestinations, compareLayers, platformLayers, sameCommitLayerCheck } from '../scripts/image-layer-report.mjs';
import { imageRebuildPlan } from '../scripts/image-rebuild.mjs';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const oldLayers = [{digest: digest('a'), size: 10}, {digest: digest('b'), size: 20}];

test('selects only the linux/amd64 manifest and validates its layers', () => {
  const calls: string[] = [];
  const layers = platformLayers({manifests: [
    {digest: digest('c'), platform: {os: 'unknown', architecture: 'unknown'}},
    {digest: digest('d'), platform: {os: 'linux', architecture: 'arm64'}},
    {digest: digest('e'), platform: {os: 'linux', architecture: 'amd64'}},
  ]}, 'docker.io/owner/app', reference => {
    calls.push(reference);
    return {layers: oldLayers};
  });
  assert.deepEqual(calls, [`docker.io/owner/app@${digest('e')}`]);
  assert.deepEqual(layers, oldLayers);
  assert.deepEqual(platformLayers({layers: oldLayers}, 'docker.io/owner/app', () => {
    throw new Error('must not inspect a child manifest');
  }), oldLayers);
});

test('rejects ambiguous platforms and invalid layer descriptors', () => {
  const amd64 = {digest: digest('c'), platform: {os: 'linux', architecture: 'amd64'}};
  assert.throws(() => platformLayers({manifests: [amd64, amd64]}, 'docker.io/owner/app', () => ({layers: oldLayers})), /one linux\/amd64/);
  assert.throws(() => platformLayers({layers: [{digest: digest('a'), size: -1}]}, 'docker.io/owner/app', () => null), /Invalid filesystem layer/);
  assert.throws(() => platformLayers({layers: [{digest: 'wrong', size: 1}]}, 'docker.io/owner/app', () => null), /Invalid filesystem layer/);
});

test('counts exact digest reuse and separates it from matching size', () => {
  const current = [{digest: digest('a'), size: 10}, {digest: digest('c'), size: 20}];
  assert.deepEqual(compareLayers(oldLayers, current), {
    reused: 1, total: 2, downloadBytes: 20, changedPositions: [2], identical: false,
  });
  assert.deepEqual(compareLayers(oldLayers, oldLayers), {
    reused: 2, total: 2, downloadBytes: 0, changedPositions: [], identical: true,
  });
  assert.deepEqual(compareLayers(oldLayers, [...current, current[1]]), {
    reused: 1, total: 3, downloadBytes: 20, changedPositions: [2, 3], identical: false,
  });
});

test('branches write separate registry caches while tag builds cannot replace them', () => {
  const image = 'docker.io/owner/app';
  assert.deepEqual(cacheDestinations('refs/heads/dev', image), [
    'type=gha,mode=max', `type=registry,ref=${image}:buildcache-dev,mode=max`,
  ]);
  assert.deepEqual(cacheDestinations('refs/heads/main', image), [
    'type=gha,mode=max', `type=registry,ref=${image}:buildcache-main,mode=max`,
  ]);
  assert.deepEqual(cacheDestinations('refs/tags/v2.6.4', image), ['type=gha,mode=max']);
});

test('same-commit layer drift stays an error unless a validated manual image-only rebuild permits it', () => {
  const current = [{digest: digest('c'), size: 10}, oldLayers[1]];
  assert.equal(sameCommitLayerCheck(oldLayers, current, false).failed, true);
  assert.equal(sameCommitLayerCheck(oldLayers, oldLayers, false).failed, false);
  assert.equal(sameCommitLayerCheck(null, current, false).failed, false);
  const plan = imageRebuildPlan({INPUT_REBUILD_ONLY: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/dev', GITHUB_SHA: 'a'.repeat(40), IMAGE_NAME: 'owner/app',
    GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1'});
  const allowed = sameCommitLayerCheck(oldLayers, current, plan.rebuildOnly);
  assert.equal(allowed.failed, false);
  assert.match(allowed.message, /Explicit manual image-only rebuild/);
  assert.match(allowed.message, /original revision and version image tags remain unchanged/);
});
