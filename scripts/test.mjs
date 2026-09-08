import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(name) : entry.isFile() && entry.name.endsWith('.test.ts') ? [name] : [];
  }));
  return files.flat().sort();
}
const files = await collect(path.join(root, 'tests'));
if (!files.length) throw new Error('No unit tests found');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], {
  cwd: root, stdio: 'inherit', env: process.env,
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
