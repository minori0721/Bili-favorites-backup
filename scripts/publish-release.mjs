import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

export function publishRelease(tag, notesFile, gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 })) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Not an application release tag');
  const pages = JSON.parse(gh(['api', 'repos/{owner}/{repo}/releases?per_page=100', '--paginate', '--slurp']));
  const releases = pages.flat();
  const existing = releases.find(release => release.tag_name === tag);
  if (existing) {
    if (existing.draft || existing.prerelease) throw new Error('Existing release needs manual review');
    return 'Existing release preserved';
  }
  gh(['release', 'create', tag, '--verify-tag', '--title', 'BFB ' + tag, '--notes-file', notesFile,
    '--latest=' + shouldMakeLatest(tag, releases)]);
  return 'Release created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(publishRelease(process.argv[2] || '', process.argv[3] || ''));
}
