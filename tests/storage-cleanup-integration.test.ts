import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {createTestDir,removeTestDir} from './helpers.js';

test('full cleanup covers UP data and actual local files without touching the remote sentinel',async()=>{
  const root=await createTestDir('full-cleanup');
  try {
    const result=spawnSync(process.execPath,['--import','tsx',path.resolve('tests/fixtures/full-cleanup-child.ts')],{
      env:{...process.env,NODE_ENV:'test',BFB_TEST_APP_ROOT:root},encoding:'utf8',timeout:30_000,windowsHide:true,
    });
    assert.equal(result.error,undefined,result.error?.message);
    assert.equal(result.status,0,result.stderr || result.stdout);
    assert.match(result.stdout,/full cleanup: real SQLite, managed files and restart checks passed/);
  }finally{await removeTestDir(root);}
});
