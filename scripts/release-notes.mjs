import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function buildReleaseNotes(changelog, tag, version) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || tag !== 'v' + version) throw new Error('Release tag must match package version');
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const matching = lines.map((line, index) => line.startsWith('## [' + version + '] - ') ? index : -1).filter(index => index >= 0);
  if (matching.length !== 1) throw new Error('Expected one matching CHANGELOG section');
  const start = matching[0] + 1;
  let end = lines.findIndex((line, index) => index >= start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end).join('\n').trim();
  if (!body || body === '暂无。') throw new Error('Release notes cannot be empty');
  return body + '\n\n### 镜像与完整记录\n\n' +
    '- Docker：`minori0721/bili-favorites-backup:' + tag + '`\n' +
    '- [对应版本 CHANGELOG](https://github.com/minori0721/Bili-favorites-backup/blob/' + tag + '/CHANGELOG.md)\n' +
    '- [部署与升级文档](https://minori0721.github.io/Bili-favorites-backup/guide/docker)\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  process.stdout.write(buildReleaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), process.argv[2] || '', pkg.version));
}
