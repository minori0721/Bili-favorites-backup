import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Supported major lines deliberately match the application lockfile. A major
// migration must review this acceptance check along with its dependency change.
export function verifySecurityDependencyVersions(versions) {
  for (const [name, minimum] of Object.entries({
    'body-parser': [1, 20, 9], 'follow-redirects': [1, 16, 1], 'markdown-it': [15, 0, 3], 'qs': [6, 16, 1],
  })) {
    const version = versions[name];
    assert.equal(typeof version, 'string', `Missing runtime dependency: ${name}`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `Invalid runtime version: ${name}`);
    const parts = version.split('.').map(Number);
    assert.ok(parts.every(Number.isSafeInteger) && parts[0] === minimum[0]
      && (parts[1] > minimum[1] || (parts[1] === minimum[1] && parts[2] >= minimum[2])),
    `Runtime dependency below security floor or unsupported major: ${name} ${version}`);
  }
}

function observe(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024});
  if (result.error) throw result.error;
  return {status: result.status, signal: result.signal, stdout: result.stdout.trim(), stderr: result.stderr.trim()};
}

export function collectImageSecurityInventory(root) {
  assert.equal(process.platform, 'linux', 'Runtime inventory requires the actual Linux candidate');
  const require = createRequire(path.join(root, 'package.json'));
  const dependencyVersions = Object.fromEntries(['body-parser', 'follow-redirects', 'markdown-it', 'qs']
    .map(name => [name, require(`${name}/package.json`).version]));
  verifySecurityDependencyVersions(dependencyVersions);
  const database = new (require('better-sqlite3'))(':memory:');
  let sqlite;
  try {
    sqlite = database.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get();
  } finally { database.close(); }
  const packages = observe('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${source:Package}\t${db:Status-Status}\n']);
  assert.equal(packages.status, 0, 'Cannot inventory Debian packages');
  const binaries = [
    '/usr/local/bin/node', '/usr/bin/aria2c', '/usr/local/bin/ffmpeg', '/usr/local/bin/ffprobe', '/usr/local/bin/BBDown',
    '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/nsenter', '/usr/bin/chfn', '/usr/bin/chsh', '/usr/bin/su',
    '/usr/bin/perl', '/usr/bin/pod2text', '/usr/bin/systemd', '/usr/bin/journalctl',
    '/usr/bin/xmlcatalog', '/usr/bin/xmllint', '/usr/bin/gpg', '/usr/bin/gpgv', '/usr/bin/nm', '/usr/bin/diff3',
  ].map(file => ({file, present: fs.existsSync(file)}));
  const nativeFiles = [process.execPath, '/usr/bin/aria2c', '/usr/local/bin/ffmpeg', '/usr/local/bin/ffprobe',
    '/usr/local/bin/BBDown', require.resolve('better-sqlite3/build/Release/better_sqlite3.node')];
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  return {
    build: {revision: process.env.BFB_BUILD_REVISION, ref: process.env.BFB_BUILD_REF,
      bbdownRelease: process.env.BBDOWN_RELEASE, bbdownCommit: process.env.BBDOWN_COMMIT, ffmpegVersion: process.env.FFMPEG_VERSION},
    node: {version: process.version, arch: process.arch, components: process.versions}, dependencyVersions, sqlite,
    packages: packages.stdout.split('\n').map(line => line.split('\t')).filter(row => row[3] === 'installed')
      .map(([binary, version, source]) => ({binary, version, source})),
    binaries,
    linkage: nativeFiles.map(file => ({file, ...observe('ldd', [file])})),
    aria2: observe('/usr/bin/aria2c', ['--version']),
    ffmpeg: observe('/usr/local/bin/ffmpeg', ['-version']),
    perlPodText: fs.existsSync('/usr/bin/perl') ? observe('/usr/bin/perl', ['-MPod::Text', '-e', 'print $Pod::Text::VERSION']) : {status: 'not-installed'},
    restrictions: {
      effectiveCapabilities: /^CapEff:\s*(\S+)/m.exec(status)?.[1],
      noNewPrivileges: /^NoNewPrivs:\s*(\S+)/m.exec(status)?.[1],
      protectedHardlinks: fs.readFileSync('/proc/sys/fs/protected_hardlinks', 'utf8').trim(),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(collectImageSecurityInventory(process.cwd()), null, 2));
}
