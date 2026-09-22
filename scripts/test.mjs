import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const scopeFiles = {
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
const scopeIndex = args.indexOf('--scope');
const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : undefined;
if (scopeIndex >= 0 && !scope) throw new Error('--scope requires a name');
if (scope && !Object.hasOwn(scopeFiles, scope)) {
  throw new Error(`Unknown test scope "${scope}". Available scopes: ${Object.keys(scopeFiles).join(', ')}`);
}
const filesIndex = args.indexOf('--files');
const excludedArgIndexes = new Set();
if (scopeIndex >= 0) {
  excludedArgIndexes.add(scopeIndex);
  excludedArgIndexes.add(scopeIndex + 1);
}
if (filesIndex >= 0) {
  for (let index = filesIndex; index < args.length; index += 1) excludedArgIndexes.add(index);
}
const runnerArgs = args.filter((arg, index) => !excludedArgIndexes.has(index));
const requestedFiles = filesIndex >= 0 ? args.slice(filesIndex + 1) : undefined;
if (filesIndex >= 0 && !requestedFiles?.length) throw new Error('--files requires at least one test file');
if (scope && requestedFiles) throw new Error('--scope and --files cannot be used together');

const files = requestedFiles
  ? [...new Set(requestedFiles.map(resolveTestFile))]
  : scope
    ? scopeFiles[scope].map(resolveTestFile)
    : await collect(path.join(root, 'tests'));
if (!files.length) throw new Error('No unit tests found');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...runnerArgs, ...files], {
  cwd: root, stdio: 'inherit', env: process.env,
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
