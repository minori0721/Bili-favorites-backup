import { fork } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from './build-web.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const context = await buildWeb({watch:true});
let child = null;
let stopping = false;
let restarting = false;
let restartRequested = false;
let debounce = null;
let watcher;

async function stopServer() {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise((resolve,reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error('Development server shutdown timed out; terminating its process.');
      current.kill();
    },90_000);
    current.once('exit',code => {
      clearTimeout(timeout);
      if (timedOut || code !== 0) reject(new Error('Development server did not shut down cleanly; automatic restart stopped.'));
      else resolve();
    });
    if (current.connected) current.send({type:'bfb:dev-shutdown'},error => { if (error) current.kill(); });
    else current.kill();
  });
  if (child === current) child = null;
}

function startServer() {
  if (stopping) return;
  const current = fork(path.join(root,'src/index.ts'),[],{
    cwd:root,execArgv:['--import','tsx'],stdio:['inherit','inherit','inherit','ipc'],
    env:{...process.env,BFB_DEV_SERVER:'1'},
  });
  child = current;
  current.on('error',error => { console.error('Development server failed:',error.message); });
  current.on('exit',(code,signal) => {
    if (!stopping && !restarting) console.error(`Development server exited (${code ?? signal}); edit server code to restart.`);
    if (child === current) child = null;
  });
}

async function restart() {
  if (stopping) return;
  restartRequested = true;
  if (restarting) return;
  restarting = true;
  try {
    while (restartRequested && !stopping) {
      restartRequested = false;
      await stopServer();
      startServer();
    }
  } catch (error) { console.error(error.message); await stop(1); }
  finally { restarting = false; }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (debounce) clearTimeout(debounce);
  watcher?.close();
  try { await context.dispose(); await stopServer(); process.exitCode = code; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}

try {
  watcher = watch(path.join(root,'src'),{recursive:true},(_event,name) => {
    const relative = String(name || '').replaceAll('\\','/');
    if (!relative.endsWith('.ts') || relative.startsWith('web/client/')) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void restart(); },150);
  });
  watcher.on('error',error => { console.error(error.message); void stop(1); });
  startServer();
} catch (error) { console.error(error); await stop(1); }
process.once('SIGINT',() => { void stop(); });
process.once('SIGTERM',() => { void stop(); });
if (process.send) {
  process.on('message',message => { if (message?.type === 'bfb:dev-shutdown') void stop(); });
  process.once('disconnect',() => { void stop(); });
}
