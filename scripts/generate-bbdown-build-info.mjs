import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

const release = option('--release');
const commit = option('--commit');
const sha256 = option('--sha256');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0
  ? path.resolve(root, option('--output'))
  : path.join(root, 'src/generated/bbdown-build-info.ts');
if (!/^bfb-[0-9A-Za-z._+-]+$/.test(release)) throw new Error(`Invalid BBDown release: ${release}`);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid BBDown commit: ${commit}`);
if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid BBDown SHA256: ${sha256}`);

const contents = `// Generated during the container build; do not edit the current version here.\n`
  + `export const BBDOWN_BUILD_INFO = ${JSON.stringify({ release, commit, sha256 }, null, 2)} as const;\n`;
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, contents, 'utf8');
