import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteImage, promotionTags } from '../scripts/promote-image.mjs';

const image = 'docker.io/owner/app';
const digest = `sha256:${'a'.repeat(64)}`;

test('promotion orders deployment tags last and rejects unexpected tags', () => {
  assert.deepEqual(promotionTags(image, `${image}:dev\n${image}:revision-${'b'.repeat(40)}\n${image}:sha-1234567`), [
    `${image}:revision-${'b'.repeat(40)}`, `${image}:sha-1234567`, `${image}:dev`,
  ]);
  assert.throws(() => promotionTags(image, `${image}:dev\n${image}:dev`), /duplicate/);
  assert.throws(() => promotionTags(image, 'docker.io/other/app:dev'), /Unexpected/);
});

test('promotion never updates the deployment tag when an earlier tag fails', async () => {
  const tags = promotionTags(image, `${image}:dev\n${image}:revision-abc`);
  const published = new Map([[`${image}@${digest}`, digest]]);
  const created: string[] = [];
  await assert.rejects(promoteImage(image, digest, tags, {
    create(tag) {created.push(tag); throw new Error('registry rejected tag');},
    inspect(reference) {return published.get(reference) ?? '';},
    async wait() {},
  }), /registry rejected tag/);
  assert.deepEqual(created, [`${image}:revision-abc`]);
});

test('promotion stops before deployment when the registry returns a different digest', async () => {
  const tags = promotionTags(image, `${image}:dev\n${image}:revision-abc`);
  const published = new Map([[`${image}@${digest}`, digest]]);
  const created: string[] = [];
  await assert.rejects(promoteImage(image, digest, tags, {
    create(tag) {created.push(tag); published.set(tag, `sha256:${'b'.repeat(64)}`);},
    inspect(reference) {return published.get(reference) ?? '';},
    async wait() {},
  }), /different digest/);
  assert.deepEqual(created, [`${image}:revision-abc`]);
});

test('promotion verifies each tag points at the tested digest', async () => {
  const tags = promotionTags(image, `${image}:latest\n${image}:revision-abc`);
  const published = new Map([[`${image}@${digest}`, digest]]);
  const created: string[] = [];
  await promoteImage(image, digest, tags, {
    create(tag) {created.push(tag); published.set(tag, digest);},
    inspect(reference) {return published.get(reference) ?? '';},
    async wait() {},
  });
  assert.deepEqual(created, [`${image}:revision-abc`, `${image}:latest`]);
  assert.equal(published.get(`${image}:latest`), digest);
});

test('promotion accepts a lost create response only after the registry confirms the digest', async () => {
  const tag = `${image}:dev`;
  let inspections = 0;
  await promoteImage(image, digest, [tag], {
    create() {throw new Error('response lost');},
    inspect(reference) {
      if (reference !== tag) return digest;
      inspections++;
      if (inspections === 1) throw new Error('tag not visible yet');
      return digest;
    },
    async wait() {},
  });
  assert.equal(inspections, 2);
});

test('a conflicting fixed version is rejected before changing any alias', async () => {
  const tags = promotionTags(image, `${image}:sha-aaaaaaa\n${image}:v2.8.0\n${image}:latest`);
  const created: string[] = [];
  await assert.rejects(promoteImage(image, digest, tags, {
    create(tag) {created.push(tag);},
    inspect(reference) {return reference === `${image}:v2.8.0` ? `sha256:${'c'.repeat(64)}` : digest;},
    async wait() {},
  }), /must not be overwritten/);
  assert.deepEqual(created, []);
});

test('fixed version publication distinguishes missing tags, identical retries and registry failures', async () => {
  const fixed = `${image}:v2.8.0`;
  for (const exists of [true, false]) {
    const published = new Map([[`${image}@${digest}`, digest], ...(exists ? [[fixed, digest] as [string, string]] : [])]);
    const created: string[] = [];
    await promoteImage(image, digest, promotionTags(image, `${image}:latest\n${fixed}`), {
      create(tag) {created.push(tag); published.set(tag, digest);},
      inspect(reference) {return published.get(reference) ?? null;}, async wait() {},
    });
    assert.deepEqual(created, [...(exists ? [] : [fixed]), `${image}:latest`]);
  }
  await assert.rejects(promoteImage(image, digest, [fixed], {
    create() {assert.fail('unavailable registry must not authorize a fixed tag write');},
    inspect(reference) {if (reference === fixed) throw new Error('registry authentication failed'); return digest;},
    async wait() {},
  }), /registry authentication failed/);
});
