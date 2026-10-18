import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildAppInfo } from '../src/app-info.js';
import { buildImageNotes, buildReleaseNotes, buildCurrentReleaseNotes } from '../scripts/release-notes.mjs';
import { readCurrentRelease } from '../src/current-release.js';
import { createTestDir, removeTestDir } from './helpers.js';

const developing = '# 更新日志\n\n## [Unreleased]\n\n### 新增\n- 新订阅功能\n\n## [2.6.5] - 2026-10-05\n\n- 旧版内容\n';
const prepared = '# 更新日志\n\n## [Unreleased]\n\n## [2.7.0] - 2026-10-18\n\n### 发布摘要\n- 新订阅功能\n### 升级与回滚\n- 升级前备份数据\n';

test('embedded notes are deterministic across refs and remain bound to the exact build', async () => {
  const dir = await createTestDir('embedded-release-');
  const file = path.join(dir, 'build-release.json');
  const revision = 'a'.repeat(40);
  const notes = buildCurrentReleaseNotes(prepared, '2.7.0');
  assert.doesNotMatch(notes, /正式发布准备构建|镜像与完整记录|bili-favorites-backup:v/);
  assert.match(buildCurrentReleaseNotes(developing, '2.7.0-dev'), /新订阅功能/);
  try {
    await fs.writeFile(file, JSON.stringify({ version: '2.7.0', revision, notes }));
    for (const buildRef of ['dev', 'main', 'v2.7.0']) {
      const info = buildAppInfo({ BFB_BUILD_REF: buildRef, BFB_BUILD_REVISION: revision }, { version: '2.7.0' });
      assert.equal(readCurrentRelease(info, file)?.notes, notes);
    }
    const info = buildAppInfo({ BFB_BUILD_REF: 'dev', BFB_BUILD_REVISION: 'b'.repeat(40) }, { version: '2.7.0' });
    assert.equal(readCurrentRelease(info, file), null);
    await fs.writeFile(file, '{bad json');
    assert.equal(readCurrentRelease(info, file), null);
    await fs.unlink(file);
    assert.equal(readCurrentRelease(info, file), null);
  } finally { await removeTestDir(dir); }
});

test('development image validation selects only Unreleased and accepts an empty new cycle', () => {
  const notes = buildImageNotes(developing, '2.7.0-dev', 'refs/heads/dev');
  assert.match(notes, /开发版 2\.7\.0-dev/);
  assert.match(notes, /新订阅功能/);
  assert.doesNotMatch(notes, /旧版内容|bili-favorites-backup:v/);
  assert.equal(buildImageNotes(developing, '2.7.0-dev', 'refs/heads/feature'), notes);
  const empty = buildImageNotes(developing.replace('### 新增\n- 新订阅功能', ''), '2.6.6-dev', 'refs/heads/dev');
  assert.match(empty, /暂无未发布变更/);
});

test('a development target must advance published versions using numeric ordering', () => {
  for (const version of ['2.6.5-dev', '2.6.4-dev', '1.99.0-dev', '02.7.0-dev', '2.7.0-beta']) {
    assert.throws(() => buildImageNotes(developing, version, 'refs/heads/dev'));
  }
  assert.match(buildImageNotes(developing.replace('[2.6.5]', '[2.9.0]'), '2.10.0-dev', 'refs/heads/dev'), /2\.10\.0-dev/);
  assert.throws(() => buildImageNotes(developing + '\n## [2.8.0] - 2026-11-01\n- Later release', '2.7.0-dev', 'refs/heads/dev'));
});

test('development notes require a unique Unreleased section before release history', () => {
  for (const changelog of [
    developing.replace('## [Unreleased]', '## [Pending]'),
    developing + '\n## [Unreleased]\n- Duplicate',
    '## [2.6.4] - 2026-09-25\n- Old release\n' + developing,
  ]) assert.throws(() => buildImageNotes(changelog, '2.7.0-dev', 'refs/heads/dev'));
});

test('release preparation on dev produces the same validated notes as main and the final tag', () => {
  const expected = buildReleaseNotes(prepared, 'v2.7.0', '2.7.0');
  for (const ref of ['refs/heads/dev', 'refs/heads/main', 'refs/tags/v2.7.0']) {
    assert.equal(buildImageNotes(prepared, '2.7.0', ref), expected);
  }
  assert.equal(buildImageNotes(prepared.replace('## [Unreleased]\n', '## [Unreleased]\n### 新增\n暂无。\n'), '2.7.0', 'refs/heads/main'), expected);
});

test('publication rejects development main builds, mismatched tags and unfinished release notes', () => {
  for (const ref of ['refs/heads/main', 'refs/tags/v2.7.0-dev', 'refs/tags/v2.7.0']) {
    assert.throws(() => buildImageNotes(developing, '2.7.0-dev', ref));
  }
  assert.throws(() => buildImageNotes(prepared, '2.7.0', 'refs/tags/v2.6.5'));
  assert.equal(buildImageNotes(prepared, '2.7.0', 'refs/heads/feature'), buildReleaseNotes(prepared, 'v2.7.0', '2.7.0'));
  assert.throws(() => buildImageNotes(prepared, '2.7.0', 'refs/pull/1/merge'));
  assert.throws(() => buildImageNotes(prepared.replace('## [Unreleased]\n', '## [Unreleased]\n- 未归档的发布内容\n'), '2.7.0', 'refs/heads/dev'));
  assert.throws(() => buildImageNotes(prepared.replace('### 发布摘要', '### 修复'), '2.7.1', 'refs/heads/main'));
});

test('development labels show the target and revision once while release-preparation labels retain dev', () => {
  const revision = '7f0e71689d68e3a061e8609da3152561964cb509';
  const info = buildAppInfo({ BFB_BUILD_REF: 'dev', BFB_BUILD_REVISION: revision }, { version: '2.7.0-dev' });
  assert.equal(info.version, '2.7.0-dev');
  assert.equal(info.versionLabel, 'v2.7.0-dev · 7f0e716');
  assert.equal(info.buildRef, 'dev');
  assert.equal(info.revision, revision);
  assert.ok(info.versionUrl.endsWith('/commit/' + revision));
  assert.equal(buildAppInfo({ BFB_BUILD_REF: 'dev' }, { version: '2.7.0-dev' }).versionLabel, 'v2.7.0-dev');
  assert.equal(buildAppInfo({}, { version: '2.7.0-dev' }).versionLabel, 'v2.7.0-dev · local');
  assert.equal(buildAppInfo({ BFB_BUILD_REF: 'dev', BFB_BUILD_REVISION: revision }, { version: '2.7.0' }).versionLabel, 'v2.7.0 · dev@7f0e716');
});

test('the image-validation CLI uses the build ref and rejects either mismatched root lock version', async () => {
  const directory = await createTestDir('build-version');
  const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  const writeVersions = async (version: string, lockVersion = version, rootVersion = version) => {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: lockVersion, packages: { '': { version: rootVersion } } }));
  };
  try {
    await writeVersions('2.7.0-dev');
    await fs.writeFile(path.join(directory, 'CHANGELOG.md'), developing);
    const dev = run('--ref', 'refs/heads/dev');
    assert.equal(dev.status, 0, dev.stderr);
    assert.match(dev.stdout, /新订阅功能/);
    assert.doesNotMatch(dev.stdout, /旧版内容/);
    assert.notEqual(run('--ref', 'refs/heads/main').status, 0);
    assert.notEqual(run('v2.7.0-dev').status, 0);
    for (const versions of [['2.6.5', '2.7.0-dev'], ['2.7.0-dev', '2.6.5']]) {
      await writeVersions('2.7.0-dev', versions[0], versions[1]);
      const result = run('--ref', 'refs/heads/dev');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /both root package-lock.json versions must match/);
    }
    await writeVersions('2.7.0');
    await fs.writeFile(path.join(directory, 'CHANGELOG.md'), prepared);
    for (const args of [['--ref', 'refs/heads/dev'], ['--ref', 'refs/heads/main'], ['v2.7.0']]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /bili-favorites-backup:v2\.7\.0/);
    }
    assert.notEqual(run('--ref', 'refs/heads/dev', 'extra').status, 0);
  } finally {
    await removeTestDir(directory);
  }
});
