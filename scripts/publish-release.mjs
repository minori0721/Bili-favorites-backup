import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { registryDigest } from './promote-image.mjs';
import { imageRebuildPlan } from './image-rebuild.mjs';

function github(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'] });
}

function releases(repository, gh) {
  const base = repository ? `repos/${repository}` : 'repos/{owner}/{repo}';
  const pages = JSON.parse(gh(['api', `${base}/releases?per_page=100`, '--paginate', '--slurp']));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Invalid release list');
  return pages.flat();
}

export function shouldMakeLatest(tag, releases) {
  const parse = value => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value || '') ? value.slice(1).split('.').map(BigInt) : null;
  const current = parse(tag);
  if (!current) throw new Error('Not an application release tag');
  return !releases.some(release => {
    const version = parse(release.tag_name);
    if (!version || release.draft || release.prerelease) return false;
    for (let i = 0; i < 3; i++) if (version[i] !== current[i]) return version[i] > current[i];
    return false;
  });
}

export function publishRelease(tag, notesFile, gh = github, repository) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Not an application release tag');
  const published = releases(repository, gh);
  const existing = published.find(release => release.tag_name === tag);
  if (existing) {
    if (existing.draft || existing.prerelease) throw new Error('Existing release needs manual review');
    return 'Existing release preserved';
  }
  gh(['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', notesFile,
    ...(repository ? ['--repo', repository] : []), '--latest=' + shouldMakeLatest(tag, published)]);
  return 'Release created';
}

function validateStableBuild(build) {
  if (build.ref !== 'refs/heads/main') throw new Error('Stable publication requires main');
  if (!/^[\w.-]+\/[\w.-]+$/.test(build.repository ?? '')) throw new Error('Invalid release repository');
  if (!/^[0-9a-f]{40}$/.test(build.revision ?? '')) throw new Error('Invalid release revision');
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(build.tag ?? '')) throw new Error('Invalid release tag');
}

function tagRevision(build, gh) {
  const base = `repos/${build.repository}`;
  const refs = JSON.parse(gh(['api', `${base}/git/matching-refs/tags/${build.tag}`]));
  if (!Array.isArray(refs)) throw new Error('Invalid release tag list');
  const matching = refs.filter(ref => ref?.ref === `refs/tags/${build.tag}`);
  if (matching.length > 1) throw new Error('Duplicate release tag');
  if (!matching.length) return null;
  let target = matching[0].object;
  if (target?.type === 'tag' && /^[0-9a-f]{40}$/.test(target.sha ?? '')) {
    target = JSON.parse(gh(['api', `${base}/git/tags/${target.sha}`])).object;
  }
  if (target?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(target.sha ?? '')) throw new Error('Invalid release tag target');
  return target.sha;
}

export function checkStablePublication(build, gh = github) {
  validateStableBuild(build);
  const current = JSON.parse(gh(['api', `repos/${build.repository}/git/ref/heads/main`]));
  if (current?.ref !== build.ref || current.object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(current.object.sha ?? '')) {
    throw new Error('Invalid main branch response');
  }
  if (current.object.sha !== build.revision) return false;
  const published = releases(build.repository, gh);
  if (!shouldMakeLatest(build.tag, published)) throw new Error('Release version is older than a published stable version');
  const release = published.find(release => release.tag_name === build.tag);
  if (release && (release.draft !== false || release.prerelease !== false)) throw new Error('Existing release needs manual review');
  const existing = tagRevision(build, gh);
  if (existing !== null && existing !== build.revision) throw new Error('Existing release tag belongs to a different commit');
  if (release && existing === null) throw new Error('Existing release has no matching Git tag');
  return true;
}

export function publishStableRelease(build, notesFile, operations = {gh: github, inspect: registryDigest}) {
  validateStableBuild(build);
  if (!/^docker\.io\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(build.image ?? '')) throw new Error('Invalid release image');
  if (!/^sha256:[0-9a-f]{64}$/.test(build.digest ?? '')) throw new Error('Invalid release image digest');
  const expectedNotes = fs.readFileSync(notesFile, 'utf8').replaceAll('\r\n', '\n').trim();
  if (!expectedNotes) throw new Error('Release notes are empty');
  const {gh} = operations;
  if (!checkStablePublication(build, gh)) throw new Error('Main advanced before release publication');
  for (const tag of [build.tag, 'latest']) {
    if (operations.inspect(`${build.image}:${tag}`) !== build.digest) throw new Error(`Release image does not match the verified candidate: ${tag}`);
  }
  if (tagRevision(build, gh) === null) {
    let createError;
    try { gh(['api', '--method', 'POST', `repos/${build.repository}/git/refs`, '-f', `ref=refs/tags/${build.tag}`, '-f', `sha=${build.revision}`]); }
    catch (error) { createError = error; }
    if (tagRevision(build, gh) !== build.revision) throw createError ?? new Error('Release tag creation did not reach the expected commit');
  }
  publishRelease(build.tag, notesFile, gh, build.repository);
  const published = JSON.parse(gh(['api', `repos/${build.repository}/releases/tags/${build.tag}`]));
  if (published?.tag_name !== build.tag || published.draft !== false || published.prerelease !== false
    || published.name !== build.tag || typeof published.body !== 'string'
    || published.body.replaceAll('\r\n', '\n').trim() !== expectedNotes || tagRevision(build, gh) !== build.revision) {
    throw new Error('Published release does not match the verified build and notes');
  }
  return `Verified release: https://github.com/${build.repository}/releases/tag/${build.tag}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (imageRebuildPlan().rebuildOnly) throw new Error('Image-only rebuilds do not publish application releases');
  const [command, tag, notesFile] = process.argv.slice(2);
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  if (tag !== `v${version}`) throw new Error('Release tag must match package version');
  const build = {ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY,
    revision: process.env.GITHUB_SHA, tag, image: `docker.io/${process.env.IMAGE_NAME}`, digest: process.env.IMAGE_DIGEST};
  let message;
  if (command === 'check' && process.argv.length === 4) {
    const current = checkStablePublication(build);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
    message = current ? 'Main is current; the verified image may be published. / main 提交仍有效，可以发布已验收镜像。'
      : 'Skipped obsolete main build; release and deployment tags stay unchanged. / main 已有新提交，跳过本次发布。';
  } else if (command === 'publish' && process.argv.length === 5) {
    message = publishStableRelease(build, notesFile);
    message += '\n\n已核对正式标签、发布说明及同一份镜像的固定版本和 latest 标签。';
  } else throw new Error('Usage: node scripts/publish-release.mjs check <tag> | publish <tag> <notes-file>');
  console.log(message);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
