import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function sqlitePrebuildPlan(lock, runtime) {
  const version = lock.packages?.['node_modules/better-sqlite3']?.version;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) {
    throw new Error('package-lock.json must specify the better-sqlite3 version');
  }
  const suffix = runtime.platform === 'linux' && runtime.libc === 'musl' ? 'musl' : '';
  const asset = `better-sqlite3-v${version}-node-v${runtime.abi}-${runtime.platform}${suffix}-${runtime.arch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${asset}`;
  // Match prebuild-install's official-URL cache name; no dependency installation is needed to plan it.
  const prefix = crypto.createHash('sha512').update(url).digest('hex').slice(0, 6);
  return {
    version, asset,
    key: `bfb-sqlite-prebuilt-v1-${runtime.platform}-${runtime.arch}-${runtime.libc}-abi${runtime.abi}-${version}`,
    filename: `${prefix}-${asset.replace(/[^a-zA-Z0-9.]+/g, '-')}`,
  };
}

const githubSource = {
  release: version => JSON.parse(execFileSync('gh', ['api', `repos/WiseLibs/better-sqlite3/releases/tags/v${version}`], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })),
  download: (id, destination) => {
    const fd = fs.openSync(destination, 'wx');
    try {
      execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/WiseLibs/better-sqlite3/releases/assets/${id}`], {
        timeout: 20_000, stdio: ['ignore', fd, 'pipe'],
      });
    } finally {fs.closeSync(fd);}
  },
};

export function prepareSqlitePrebuilt(plan, archive, source = githubSource) {
  if (fs.existsSync(archive)) return {source: 'cache'};
  let release;
  try {release = source.release(plan.version);} catch {return {source: 'npm', reason: 'release-api-unavailable'};}
  const asset = Array.isArray(release?.assets) ? release.assets.find(item => item?.name === plan.asset) : undefined;
  if (!Number.isSafeInteger(asset?.id) || asset.id <= 0 || !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '')) {
    return {source: 'npm', reason: 'verified-asset-unavailable'};
  }
  fs.mkdirSync(path.dirname(archive), {recursive: true});
  const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
  try {
    try {source.download(asset.id, temporary);} catch {return {source: 'npm', reason: 'asset-api-unavailable'};}
    const actual = crypto.createHash('sha256').update(fs.readFileSync(temporary)).digest('hex');
    if (`sha256:${actual}` !== asset.digest) return {source: 'npm', reason: 'asset-checksum-mismatch'};
    fs.renameSync(temporary, archive);
    return {source: 'github-api'};
  } finally {fs.rmSync(temporary, {force: true});}
}

export function sqliteInstallReport(log, timers, succeeded, archiveExists) {
  const prebuilt = /^prebuild-install info install Successfully installed prebuilt binary!/m.test(log);
  const method = prebuilt
    ? /^prebuild-install info found cached prebuild/m.test(log) ? 'cache' : 'download'
    : /gyp info using node-gyp@/.test(log) ? 'compiled' : 'unknown';
  return {
    method,
    save: succeeded && prebuilt && archiveExists,
    totalMs: timers.npm ?? timers['command:ci'] ?? null,
    sqliteMs: timers['build:run:install:node_modules/better-sqlite3'] ?? null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, logPath, timingDirectory] = process.argv.slice(2);
  if (!(['plan', 'prepare'].includes(command) && process.argv.length === 3)
    && !(command === 'record' && logPath && timingDirectory && process.argv.length === 5)) {
    throw new Error('Usage: ci-sqlite-cache.mjs plan|prepare | record INSTALL_LOG TIMING_DIRECTORY');
  }
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  const plan = sqlitePrebuildPlan(JSON.parse(fs.readFileSync('package-lock.json', 'utf8')), {
    platform: process.platform, arch: process.arch, abi: process.versions.modules,
    libc: process.platform === 'linux' ? glibc ? `glibc-${glibc}` : 'musl' : 'native',
  });
  const archive = path.join(process.env.npm_config_cache || path.join(os.homedir(), '.npm'), '_prebuilds', plan.filename);
  if (command === 'plan') {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `key=${plan.key}\narchive=${archive}\n`);
  } else if (command === 'prepare') {
    const result = prepareSqlitePrebuilt(plan, archive);
    console.log(result.source === 'npm'
      ? `[SQLite] Official API preparation unavailable (${result.reason}); npm keeps its normal download and source-build fallback. / 官方 API 准备未完成，继续使用 npm 下载及编译回退。`
      : `[SQLite] Prebuilt prepared from ${result.source}. / 现成组件已就绪，来源：${result.source}。`);
  } else {
    const files = fs.existsSync(timingDirectory)
      ? fs.readdirSync(timingDirectory).filter(name => name.endsWith('-timing.json')).sort() : [];
    const timers = files.length
      ? JSON.parse(fs.readFileSync(path.join(timingDirectory, files.at(-1)), 'utf8')).timers ?? {} : {};
    const report = sqliteInstallReport(fs.readFileSync(logPath, 'utf8'), timers,
      process.env.NPM_INSTALL_OUTCOME === 'success', fs.existsSync(archive));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `save=${report.save}\n`);
    const methods = {cache: 'cached prebuilt / 使用缓存', download: 'downloaded prebuilt / 下载现成组件',
      compiled: 'compiled from source / 从源码编译', unknown: 'not recorded / 未记录'};
    const seconds = ms => ms === null ? 'not recorded / 未记录' : `${(ms / 1000).toFixed(2)} s`;
    const summary = `### Dependency installation / 依赖安装

| Item / 项目 | Result / 结果 |
| --- | --- |
| Installation / 安装结果 | ${process.env.NPM_INSTALL_OUTCOME} |
| npm install / 依赖安装耗时 | ${seconds(report.totalMs)} |
| SQLite install / SQLite 安装耗时 | ${seconds(report.sqliteMs)} |
| SQLite method / SQLite 安装方式 | ${methods[report.method]} |
`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
