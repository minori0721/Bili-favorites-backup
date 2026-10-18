import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const developmentVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev$/;

function unreleasedSection(changelog) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const matching = lines.flatMap((line, index) => line === '## [Unreleased]' ? [index] : []);
  if (matching.length !== 1 || matching[0] !== lines.findIndex(line => line.startsWith('## '))) {
    throw new Error('Expected one Unreleased section before all released versions');
  }
  const start = matching[0] + 1;
  const end = lines.findIndex((line, index) => index >= start && line.startsWith('## '));
  return { lines, body: lines.slice(start, end < 0 ? lines.length : end).join('\n').trim() };
}

export function buildImageNotes(changelog, version, ref) {
  const branch = ref.startsWith('refs/heads/');
  if (!branch && !ref.startsWith('refs/tags/')) {
    throw new Error('Image publication requires a branch or an application release tag');
  }
  const development = developmentVersion.exec(version);
  if (branch && ref !== 'refs/heads/main' && development) {
    const { lines, body } = unreleasedSection(changelog);
    const target = development.slice(1).map(BigInt);
    for (const line of lines) {
      const release = /^## \[(\d+\.\d+\.\d+)\] - /.exec(line);
      if (!release || !stableVersion.test(release[1])) continue;
      const published = release[1].split('.').map(BigInt);
      const difference = target.findIndex((part, index) => part !== published[index]);
      if (difference < 0 || target[difference] < published[difference]) {
        throw new Error('Development target must be newer than every released CHANGELOG version');
      }
    }
    return `## 开发版 ${version}\n\n${developmentPreviewBody(body, previousRelease(lines, version.replace(/-dev$/, '')))}\n`;
  }
  if (!stableVersion.test(version)) {
    throw new Error('Main and application release tags require a stable package version; dev supports only X.Y.Z-dev');
  }
  const { body } = unreleasedSection(changelog);
  const changes = body.split('\n').some(line => {
    const text = line.trim();
    return text && !text.startsWith('### ') && text !== '暂无。' && text !== '- 暂无。';
  });
  if (changes) throw new Error('Move Unreleased changes into the versioned CHANGELOG before release preparation');
  const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : `v${version}`;
  return buildReleaseNotes(changelog, tag, version);
}

export function buildReleaseNotes(changelog, tag, version) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || tag !== 'v' + version) throw new Error('Release tag must match package version');
  return releasedBody(changelog, version) + '\n\n### 镜像与完整记录\n\n' +
    '- Docker：`minori0721/bili-favorites-backup:' + tag + '`\n' +
    '- [对应版本 CHANGELOG](https://github.com/minori0721/Bili-favorites-backup/blob/' + tag + '/CHANGELOG.md)\n' +
    '- [部署与升级文档](https://minori0721.github.io/Bili-favorites-backup/guide/docker)\n';
}

function extractSection(lines, heading) {
  const matches = lines.flatMap((line, index) => line === heading ? [index] : []);
  if (matches.length !== 1) throw new Error('Expected one ' + heading + ' section');
  const begin = matches[0] + 1;
  let finish = lines.findIndex((line, index) => index >= begin && /^#{1,3} /.test(line));
  if (finish < 0) finish = lines.length;
  const content = lines.slice(begin, finish).join('\n').trim();
  if (!content || content === '暂无。') throw new Error('Release summary sections cannot be empty');
  return heading + '\n\n' + content;
}

function releasedSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const matching = lines.map((line, index) => line.startsWith('## [' + version + '] - ') ? index : -1).filter(index => index >= 0);
  if (matching.length !== 1) throw new Error('Expected one matching CHANGELOG section');
  const start = matching[0] + 1;
  let end = lines.findIndex((line, index) => index >= start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

function releasedBody(changelog, version) {
  const section = releasedSection(changelog, version);
  let body = section.join('\n').trim();
  const summaryHeading = '### 发布摘要';
  const upgradeHeading = '### 升级与回滚';
  if (section.includes(summaryHeading)) {
    body = extractSection(section, summaryHeading) + '\n\n' + extractSection(section, upgradeHeading);
  }
  if (!body || body === '暂无。') throw new Error('Release notes cannot be empty');
  return body;
}

export function buildDevPreviewNotes(changelog, version) {
  // Use the same validation as the image build, including stable release preparation on dev.
  buildImageNotes(changelog, version, 'refs/heads/dev');
  const { lines, body } = unreleasedSection(changelog);
  const base = previousRelease(lines, version.replace(/-dev$/, ''));
  if (stableVersion.test(version)) {
    return '当前为正式发布准备构建，尚不代表该版本已经正式发布。\n\n'
      + developmentPreviewBody(releasedSection(changelog, version).join('\n').trim(), base);
  }
  return developmentPreviewBody(body, base);
}

// The same Git commit may be built on dev, main and a formal tag. Embedded
// filesystem content must remain identical across those refs.
export function buildCurrentReleaseNotes(changelog, version) {
  return developmentVersion.test(version) ? buildDevPreviewNotes(changelog, version) : releasedBody(changelog, version);
}

function previousRelease(lines, target) {
  const compare = (left, right) => {
    const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
    const index = a.findIndex((part, i) => part !== b[i]);
    return index < 0 ? 0 : a[index] > b[index] ? 1 : -1;
  };
  let previous;
  for (const line of lines) {
    const version = /^## \[([^\]]+)\] - /.exec(line)?.[1];
    if (version && stableVersion.test(version) && compare(version, target) < 0
      && (!previous || compare(version, previous) > 0)) previous = version;
  }
  return previous;
}

function developmentPreviewBody(body, base) {
  const lines = body.split('\n');
  const range = base ? `**累计范围：v${base} → 当前开发版**` : '**当前开发周期累计更新**';
  if (!lines.some(line => {
    const text = line.trim();
    return text && !text.startsWith('### ') && text !== '暂无。' && text !== '- 暂无。';
  })) return range + '\n\n暂无未发布变更。';
  // Keep summary validation, but preserve every cumulative change section.
  for (const heading of ['### 发布摘要', '### 升级提醒']) {
    if (lines.includes(heading)) extractSection(lines, heading);
  }
  return range + '\n\n' + body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json and both root package-lock.json versions must match');
  }
  const args = process.argv.slice(2);
  let ref;
  if (args.length === 2 && args[0] === '--ref') ref = args[1];
  else if (args.length === 1 && args[0].startsWith('v')) ref = `refs/tags/${args[0]}`;
  else throw new Error('Usage: node scripts/release-notes.mjs <release-tag> | --ref <git-ref>');
  process.stdout.write(buildImageNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), pkg.version, ref));
}
