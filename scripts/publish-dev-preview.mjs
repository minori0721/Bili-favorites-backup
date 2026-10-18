import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildDevPreviewNotes } from './release-notes.mjs';

const tag = 'dev-preview';
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function github(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function inspect(reference) {
  const manifest = JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', reference], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 5 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (!digestPattern.test(manifest?.digest ?? '')) throw new Error('Registry returned an invalid image digest');
  return manifest.digest;
}

function validateBuild({ repository, revision, ref }) {
  if (ref !== 'refs/heads/dev') throw new Error('Development previews can only be published from dev');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('Invalid build revision');
}

export function isCurrentDevBuild(build, gh = github) {
  validateBuild(build);
  const response = JSON.parse(gh(['api', `repos/${build.repository}/git/ref/heads/dev`]));
  if (response?.ref !== 'refs/heads/dev' || response.object?.type !== 'commit'
    || !/^[0-9a-f]{40}$/.test(response.object.sha ?? '')) throw new Error('GitHub returned an invalid dev branch ref');
  return response.object.sha === build.revision;
}

export function publishDevPreview(build, changelog, version, notesFile, operations = { gh: github, inspect }) {
  validateBuild(build);
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(build.image ?? '') || !build.image.startsWith('docker.io/')) throw new Error('Invalid development image');
  if (!digestPattern.test(build.digest ?? '')) throw new Error('Invalid development image digest');
  if (!/^[1-9]\d*$/.test(build.runId ?? '') || !/^[1-9]\d*$/.test(build.runAttempt ?? '')) throw new Error('Invalid workflow run identity');
  if (typeof build.updatedAt !== 'string' || !Number.isFinite(Date.parse(build.updatedAt))) throw new Error('Invalid preview update time');
  const changes = buildDevPreviewNotes(changelog, version);
  const { gh } = operations;
  // This runs inside the dev image job's concurrency lock, after promotion. A new branch
  // commit may already exist; the preview must describe the image actually available now.
  if (operations.inspect(`${build.image}:dev`) !== build.digest) return 'Skipped: dev image has changed';
  if (operations.inspect(`${build.image}:revision-${build.revision}`) !== build.digest) throw new Error('Revision image does not match the verified dev image');

  const base = `repos/${build.repository}`;
  const pages = JSON.parse(gh(['api', `${base}/releases?per_page=100`, '--paginate', '--slurp']));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Invalid GitHub release list');
  const existing = pages.flat().filter(release => release?.tag_name === tag);
  if (existing.length > 1 || existing.some(release => release.prerelease !== true || release.draft !== false || release.immutable !== false)) {
    throw new Error('Existing dev preview is not a mutable, published prerelease; review it before updating');
  }
  const refs = JSON.parse(gh(['api', `${base}/git/matching-refs/tags/${tag}`]));
  if (!Array.isArray(refs)) throw new Error('Invalid GitHub preview ref list');
  const matching = refs.filter(ref => ref?.ref === `refs/tags/${tag}`);
  if (matching.length > 1 || matching.some(ref => ref.object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(ref.object.sha ?? ''))) {
    throw new Error('Existing preview tag is not a commit ref');
  }

  const url = `https://github.com/${build.repository}`;
  const runUrl = `${url}/actions/runs/${build.runId}/attempts/${build.runAttempt}`;
  const title = `BFB 开发预览 · ${version} · ${build.revision.slice(0, 7)}`;
  const metadata = `<!-- bfb-build:${JSON.stringify({ version, revision: build.revision })} -->\n`;
  const body = metadata + `这是持续更新的开发预览，供愿意测试新改动的用户使用；正式部署请选择正式版本。\n\n` +
    `### 当前构建\n\n- 程序版本：\`${version}\`\n- 更新时间：${build.updatedAt}\n` +
    `- 对应提交：[\`${build.revision}\`](${url}/commit/${build.revision})\n\n${changes}\n\n` +
    `### 镜像与验收\n\n- [本次构建与验收记录](${runUrl})\n` +
    `- 滚动镜像：\`${build.image}:dev\`\n- 本次固定镜像：\`${build.image}@${build.digest}\`\n\n` +
    `### 完整记录\n\n- [本次 CHANGELOG](${url}/blob/${build.revision}/CHANGELOG.md)\n` +
    `- [部署与升级文档](https://minori0721.github.io/Bili-favorites-backup/guide/docker)\n\n` +
    '此页面与 dev-preview 标签会随成功发布的开发镜像更新；旧构建请通过具体提交和镜像摘要定位。\n';
  fs.writeFileSync(notesFile, body);

  if (!matching.length) {
    gh(['api', '--method', 'POST', `${base}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${build.revision}`]);
  } else if (matching[0].object.sha !== build.revision) {
    gh(['api', '--method', 'PATCH', `${base}/git/refs/tags/${tag}`, '-f', `sha=${build.revision}`, '-F', 'force=true']);
  }
  gh(['release', existing.length ? 'edit' : 'create', tag, '--repo', build.repository, '--title', title,
    '--prerelease', '--latest=false', '--notes-file', notesFile, ...(!existing.length ? ['--verify-tag'] : [])]);

  const published = JSON.parse(gh(['api', `${base}/releases/tags/${tag}`]));
  const publishedRef = JSON.parse(gh(['api', `${base}/git/ref/tags/${tag}`]));
  if (published?.tag_name !== tag || published.prerelease !== true || published.draft !== false || published.immutable !== false
    || published.name !== title || published.body !== body || publishedRef?.ref !== `refs/tags/${tag}`
    || publishedRef.object?.type !== 'commit' || publishedRef.object.sha !== build.revision) {
    throw new Error('Published development preview does not match this build');
  }
  return `Verified development preview: ${url}/releases/tag/${tag}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const build = { ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA };
  const mode = process.argv[2];
  let message;
  if (process.argv.length === 3 && mode === 'check') {
    const current = isCurrentDevBuild(build);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
    message = current ? 'Current dev build may publish its verified image and preview.' : 'Skipped outdated dev build: deployment tags and preview remain unchanged.';
  } else if (process.argv.length === 3 && mode === 'publish') {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package and root lock versions must match');
    message = publishDevPreview({ ...build, image: `docker.io/${process.env.IMAGE_NAME}`, digest: process.env.IMAGE_DIGEST,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, updatedAt: new Date().toISOString(),
    }, fs.readFileSync('CHANGELOG.md', 'utf8'), pkg.version, path.join(process.env.RUNNER_TEMP, 'bfb-dev-preview-notes.md'));
  } else throw new Error('Usage: node scripts/publish-dev-preview.mjs check | publish');
  console.log(message);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
