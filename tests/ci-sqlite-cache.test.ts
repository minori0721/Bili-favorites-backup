import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sqlitePrebuildPlan, sqliteInstallReport} from '../scripts/ci-sqlite-cache.mjs';
import {createTestDir, removeTestDir} from './helpers.js';

const lock = {version: '2.7.4-dev', packages: {
  '': {version: '2.7.4-dev'}, 'node_modules/better-sqlite3': {version: '12.11.1'},
}};
const runtime = {platform: 'linux', arch: 'x64', abi: '137', libc: 'glibc-2.39'};
const cached = 'prebuild-install info found cached prebuild\nprebuild-install info install Successfully installed prebuilt binary!\n';
const downloaded = 'prebuild-install http 200 https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/file\n'
  + 'prebuild-install info install Successfully installed prebuilt binary!\n';
const compiled = 'prebuild-install warn install No prebuilt binaries found\ngyp info using node-gyp@12.4.0\ngyp info ok\n';
const timers = {npm: 85290, 'command:ci': 84094, 'build:run:install:node_modules/better-sqlite3': 82255};

test('SQLite cache survives application version bumps and unrelated dependency changes', () => {
  const changed = {...lock, version: '2.7.5-dev', packages: {...lock.packages,
    '': {version: '2.7.5-dev'}, 'node_modules/express': {version: '4.22.2'}}};
  assert.deepEqual(sqlitePrebuildPlan(changed, runtime), sqlitePrebuildPlan(lock, runtime));
});

test('SQLite and runtime compatibility changes select separate caches without broad fallback keys', () => {
  const original = sqlitePrebuildPlan(lock, runtime);
  const upgraded = sqlitePrebuildPlan({packages: {'node_modules/better-sqlite3': {version: '12.11.2'}}}, runtime);
  assert.notEqual(upgraded.key, original.key);
  assert.notEqual(upgraded.filename, original.filename);
  for (const changed of [{abi: '138'}, {arch: 'arm64'}, {platform: 'darwin', libc: 'native'},
    {libc: 'glibc-2.40'}, {libc: 'musl'}]) {
    assert.notEqual(sqlitePrebuildPlan(lock, {...runtime, ...changed}).key, original.key);
  }
  assert.match(sqlitePrebuildPlan(lock, {...runtime, libc: 'musl'}).filename, /linuxmusl/);
  for (const version of [undefined, '', '../12.11.1', '12.11.1\nextra=true']) {
    assert.throws(() => sqlitePrebuildPlan({packages: {'node_modules/better-sqlite3': {version}}}, runtime), /specify/);
  }
});

test('cache archive name matches the actual prebuild-install consumer', () => {
  const require = createRequire(import.meta.url);
  const installer: {getDownloadUrl(options: object): string; cachedPrebuild(url: string): string} = require('prebuild-install/util.js');
  const url = installer.getDownloadUrl({pkg: {name: 'better-sqlite3', version: '12.11.1',
    repository: 'https://github.com/WiseLibs/better-sqlite3'}, ...runtime, libc: '', 'tag-prefix': 'v'});
  assert.equal(sqlitePrebuildPlan(lock, runtime).filename, path.basename(installer.cachedPrebuild(url)));
});

test('only a successful prebuilt install with a retained archive can populate the cache', () => {
  assert.deepEqual(sqliteInstallReport(cached, timers, true, true), {
    method: 'cache', save: true, totalMs: 85290, sqliteMs: 82255,
  });
  assert.equal(sqliteInstallReport(downloaded, {}, true, true).method, 'download');
  assert.equal(sqliteInstallReport(downloaded, {}, true, true).save, true);
  assert.equal(sqliteInstallReport(cached, {}, false, true).save, false, 'a later npm failure prevents saving');
  assert.equal(sqliteInstallReport(cached, {}, true, false).save, false, 'missing archives are never saved');
  assert.deepEqual(sqliteInstallReport(compiled, timers, true, true), {
    method: 'compiled', save: false, totalMs: 85290, sqliteMs: 82255,
  }, 'a rejected prebuilt left on disk must not be cached after source compilation');
  assert.deepEqual(sqliteInstallReport('', {}, false, false), {
    method: 'unknown', save: false, totalMs: null, sqliteMs: null,
  }, 'an early installation failure is not reported as a zero-second success');
});

test('the workflow CLI uses the locked version and writes cache decisions and bilingual timing on failure too', async () => {
  const dir = await createTestDir('ci-sqlite-cache');
  const script = fileURLToPath(new URL('../scripts/ci-sqlite-cache.mjs', import.meta.url));
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary.md');
  const log = path.join(dir, 'install.log');
  const timingDir = path.join(dir, 'timings');
  const run = (outcome: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: {...process.env, npm_config_cache: path.join(dir, 'npm-cache'), GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary, NPM_INSTALL_OUTCOME: outcome},
  });
  try {
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    const plan = run('success', 'plan');
    assert.equal(plan.status, 0, plan.stderr);
    const planned = await fs.readFile(output, 'utf8');
    assert.match(planned, /key=bfb-sqlite-prebuilt-v1-.*-12\.11\.1\n/);
    const archive = planned.split('archive=')[1].trim();
    assert.ok(archive.startsWith(path.join(dir, 'npm-cache', '_prebuilds') + path.sep));
    await fs.mkdir(path.dirname(archive), {recursive: true});
    await fs.writeFile(archive, 'isolated cache fixture');
    await fs.mkdir(timingDir);
    await fs.writeFile(path.join(timingDir, 'install-timing.json'), JSON.stringify({timers}));
    await fs.writeFile(log, downloaded);
    assert.equal(run('success', 'record', log, timingDir).status, 0);
    assert.match(await fs.readFile(output, 'utf8'), /save=true\n$/);
    await fs.writeFile(log, compiled);
    assert.equal(run('failure', 'record', log, timingDir).status, 0);
    assert.match(await fs.readFile(output, 'utf8'), /save=false\n$/);
    const reported = await fs.readFile(summary, 'utf8');
    assert.match(reported, /85\.29 s/);
    assert.match(reported, /82\.25 s/);
    assert.match(reported, /compiled from source \/ 从源码编译/);
    assert.match(reported, /Installation \/ 安装结果 \| failure/);
    assert.notEqual(run('success', 'plan', 'unexpected').status, 0);
  } finally {await removeTestDir(dir);}
});

test('production wiring restores an exact archive before npm and saves only confirmed prebuilt success', async () => {
  const workflow = (await fs.readFile(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const job = workflow.split('\n  test:\n')[1].split('\n  image:\n')[0];
  assert.ok(job.indexOf('actions/cache/restore@v5') < job.indexOf('npm ci --foreground-scripts'));
  assert.match(job, /path: \$\{\{ steps.sqlite-plan.outputs.archive \}\}/);
  assert.match(job, /key: \$\{\{ steps.sqlite-plan.outputs.key \}\}/);
  assert.doesNotMatch(job, /restore-keys:|--ignore-scripts/);
  assert.match(job, /!cancelled\(\) && steps.npm-install.outcome != 'skipped'/);
  assert.match(job, /if: steps.sqlite-cache.outputs.cache-hit != 'true' && steps.sqlite-install.outputs.save == 'true'/);
  assert.match(job, /NPM_INSTALL_OUTCOME: \$\{\{ steps.npm-install.outcome \}\}/);
  assert.match(job, /2>&1 \| tee "\$RUNNER_TEMP\/bfb-npm-install.log"/);
  assert.ok(job.indexOf('actions/cache/save@v5') < job.indexOf('npm audit'));
});

test('the actual Bash install step preserves npm failure through the log pipeline', {
  skip: process.platform !== 'linux' ? 'requires Linux Bash' : false,
}, async () => {
  const dir = await createTestDir('ci-sqlite-install-failure');
  try {
    const source = (await fs.readFile(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    const step = source.split('      - name: Install application dependencies\n')[1].split('\n      - name: ')[0];
    assert.match(step, /\n        shell: bash\n/, 'GitHub must use Bash with pipefail, as exercised below');
    const body = step.split('        run: |\n')[1].trimEnd().split('\n').map(line => line.slice(10)).join('\n');
    const script = path.join(dir, 'install.sh');
    const mocks = path.join(dir, 'mocks.sh');
    await fs.writeFile(script, body);
    await fs.writeFile(mocks, "npm() { printf 'npm ERR! isolated installation failure\\n'; return 42; }\n");
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      encoding: 'utf8', timeout: 10_000, env: {...process.env, BASH_ENV: mocks, RUNNER_TEMP: dir},
    });
    assert.equal(result.status, 42, result.stderr);
    assert.match(await fs.readFile(path.join(dir, 'bfb-npm-install.log'), 'utf8'), /isolated installation failure/);
  } finally {await removeTestDir(dir);}
});
