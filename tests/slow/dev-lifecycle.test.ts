import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createTestDir, removeTestDir } from '../helpers.js';

async function until(check:() => boolean | Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Development lifecycle check timed out');
    await new Promise(resolve => setTimeout(resolve,100));
  }
}

test('isolated dev lifecycle builds first, rebuilds browser resources, restarts server and closes both watchers', {timeout:60000}, async () => {
  const directory = await createTestDir('dev-lifecycle');
  const root = process.cwd();
  const portProbe = net.createServer().listen(0,'127.0.0.1');
  await once(portProbe,'listening');
  const address = portProbe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  for (const name of ['src','scripts']) await fs.cp(path.join(root,name),path.join(directory,name),{recursive:true});
  for (const name of ['package.json','tsconfig.json','tsconfig.web.json']) await fs.copyFile(path.join(root,name),path.join(directory,name));
  await fs.symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'),'junction');
  const child = fork(path.join(directory,'scripts/dev.mjs'),[],{cwd:directory,execArgv:[],silent:true,
    env:{...process.env,NODE_ENV:'development',PORT:String(address.port),ADMIN_PASS:'isolated-dev-test',BFB_TEST_APP_ROOT:''}});
  let output = '';
  child.stdout?.on('data',chunk => { output += String(chunk); });
  child.stderr?.on('data',chunk => { output += String(chunk); });
  const exited = once(child,'exit');
  const manifestPath = path.join(directory,'dist/web/assets/manifest.json');
  try {
    await until(() => output.includes('Server listening'));
    const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
    assert.ok(manifest.script.file && manifest.style.file);
    const url = `http://127.0.0.1:${address.port}/login`;
    assert.equal((await fetch(url)).status,200);
    await fs.appendFile(path.join(directory,'src/web/client/app.css'),'\n.dev-lifecycle-check { color: rgb(1,2,3); }\n');
    await until(async () => JSON.parse(await fs.readFile(manifestPath,'utf8')).style.file !== manifest.style.file);
    assert.equal((output.match(/Server listening/g) || []).length,1);
    await fs.appendFile(path.join(directory,'src/web.ts'),'\n// isolated server restart check\n');
    await until(() => (output.match(/Server listening/g) || []).length >= 2);
    assert.equal((await fetch(url)).status,200);
    child.send({type:'bfb:dev-shutdown'});
    const [code] = await exited;
    assert.equal(code,0,output);
    await assert.rejects(fetch(url));
  } catch (error) {
    throw new Error(String(error) + '\n' + output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({type:'bfb:dev-shutdown'});
      else child.kill();
      await exited;
    }
    await removeTestDir(directory);
  }
});
