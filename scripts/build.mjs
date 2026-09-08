import { spawnSync } from 'node:child_process';
import { buildWeb } from './build-web.mjs';
import './check-architecture.mjs';

if (process.exitCode) process.exit(process.exitCode);

function tsc(args) {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', ...args], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
tsc(['-p','tsconfig.json','--noEmit']);
tsc(['-p','tsconfig.web.json','--noEmit']);
await buildWeb();
tsc(['-p','tsconfig.json']);
const { readAssetManifest } = await import('../dist/web/server/assets.js');
readAssetManifest();
