import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { availableParallelism } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const scopeFiles = {
  release: [
    'tests/build-version.test.ts',
    'tests/release-notes.test.ts',
    'tests/dev-preview.test.ts',
    'tests/dev-test-evidence.test.ts',
    'tests/promote-image.test.ts',
    'tests/image-layer-report.test.ts',
    'tests/image-rebuild.test.ts',
    'tests/update-check.test.ts',
    'tests/update-channels.test.ts',
  ],
  quick: [
    'tests/domain-decoders.test.ts',
    'tests/failure-boundaries.test.ts',
    'tests/http-request-boundary.test.ts',
    'tests/remote-path.test.ts',
  ],
  decoder: ['tests/domain-decoders.test.ts'],
  upload: [
    'tests/uploader.test.ts',
    'tests/upload-health.test.ts',
    'tests/upload-verification-scheduler.test.ts',
    'tests/scheduler/upload-work.test.ts',
  ],
  scheduler: [
    'tests/scheduler/scheduling-runtime.test.ts',
    'tests/scheduler/runtime-timers.test.ts',
    'tests/scheduler/sync-workflow.test.ts',
    'tests/scheduler/access-probes.test.ts',
    'tests/scheduler/recovery-work.test.ts',
  ],
};

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(name) : entry.isFile() && entry.name.endsWith('.test.ts') ? [name] : [];
  }));
  return files.flat().sort();
}

function resolveTestFile(file) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Test file must stay inside the repository: ${file}`);
  }
  if (!relative.endsWith('.test.ts')) throw new Error(`Test file must end with .test.ts: ${file}`);
  return absolute;
}

const args = process.argv.slice(2);
let scope;
let requestedFiles;
let list = false;
let concurrency;
const runnerArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--files') {
    requestedFiles = args.slice(index + 1);
    if (!requestedFiles.length) throw new Error('--files requires at least one test file');
    break;
  }
  if (arg === '--scope') {
    if (scope) throw new Error('--scope may only be specified once');
    scope = args[++index];
    if (!scope) throw new Error('--scope requires a name');
  } else if (arg === '--list') {
    list = true;
  } else if (arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')) {
    if (concurrency !== undefined) throw new Error('--test-concurrency may only be specified once');
    const value = arg === '--test-concurrency' ? args[++index] : arg.slice('--test-concurrency='.length);
    if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('--test-concurrency requires a positive integer');
    concurrency = Number(value);
  } else runnerArgs.push(arg);
}
if (scope && requestedFiles) throw new Error('--scope and --files cannot be used together');
if (scope && !['core', 'slow', ...Object.keys(scopeFiles)].includes(scope)) {
  throw new Error(`Unknown test scope "${scope}". Available scopes: core, slow, ${Object.keys(scopeFiles).join(', ')}`);
}
concurrency ??= Math.min(2, availableParallelism());

const isSlow = file => path.relative(root, file).split(path.sep).slice(0, 2).join('/') === 'tests/slow';
const files = requestedFiles
  ? [...new Set(requestedFiles.map(resolveTestFile))]
  : scope && Object.hasOwn(scopeFiles, scope)
    ? scopeFiles[scope].map(resolveTestFile)
    : (await collect(path.join(root, 'tests'))).filter(file => scope === 'core' ? !isSlow(file) : scope === 'slow' ? isSlow(file) : true);
if (!files.length) throw new Error('No unit tests found');
if (list) {
  console.log(JSON.stringify({ scope: scope ?? 'full', concurrency, files: files.map(file => path.relative(root, file).split(path.sep).join('/')) }, null, 2));
  process.exit(0);
}
console.log(`Running ${files.length} test files (scope=${scope ?? 'full'}, concurrency=${concurrency}).`);
const child = spawn(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...runnerArgs, ...files], {
  cwd: root, stdio: 'inherit', env: process.env,
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
