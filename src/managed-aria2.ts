import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ARIA2_DOWNLOAD_ARGS } from './aria2-options.js';

export interface DownloadTransport {
  configPath: string;
  progressBytes(): Promise<number>;
  minimumProgressRate(): number;
  progressWindowMs(): number;
  release(): Promise<void>;
}

interface Engine {
  child: ChildProcess;
  exited: Promise<void>;
  directory: string;
  endpoint: string;
  secret: string;
  failed: boolean;
  controlAgent: http.Agent;
}

interface TransferRow { gid: string; completedLength: number; status: string }

function rows(value: unknown): TransferRow[] {
  if (!Array.isArray(value)) throw new Error('Invalid aria2 transfer list');
  return value.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || !('gid' in row) || typeof row.gid !== 'string'
      || !/^[a-f\d]{16}$/i.test(row.gid) || !('completedLength' in row) || typeof row.completedLength !== 'string'
      || !/^\d+$/.test(row.completedLength) || !Number.isSafeInteger(Number(row.completedLength))
      || !('status' in row) || typeof row.status !== 'string'
      || !['active', 'waiting', 'paused', 'error', 'complete', 'removed'].includes(row.status)) throw new Error('Invalid aria2 transfer fields');
    return { gid: row.gid, completedLength: Number(row.completedLength), status: row.status };
  });
}

async function vacantPort() {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Cannot reserve aria2 control port');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

/** Infrastructure owned by the application. BBDown receives only its task's private config. */
export class ManagedAria2 {
  private engine: Promise<Engine> | undefined;
  private rate = 0;
  private stopped = false;
  private owners = new Set<string>();
  private updates = Promise.resolve();

  constructor(private readonly options: { command?: string; commandArgs?: string[]; temporaryRoot?: string } = {}) {}

  setBytesPerSecond(rate: number) {
    if (!Number.isSafeInteger(rate) || rate < 0) throw new Error('Invalid download byte rate');
    this.rate = rate;
    if (!this.engine) return;
    const current = this.engine;
    this.updates = this.updates.then(async () => {
      const engine = await current;
      if (this.engine !== current || engine.failed) return;
      try { await this.call(engine, 'changeGlobalOption', [{ 'max-overall-download-limit': String(this.rate) }]); }
      catch {
        // A lower cap must never be acknowledged while silently running at the old rate.
        engine.failed = true;
        engine.child.kill('SIGKILL');
        await engine.exited;
        console.warn('[Bandwidth] 下载限速应用失败，已停止下载引擎，任务将按恢复流程重试');
      }
    }).catch(() => { console.warn('[Bandwidth] 下载引擎未能就绪，当前任务将报告启动失败'); });
  }

  private async call(engine: Engine, method: string, params: unknown[]): Promise<unknown> {
    if (engine.failed) throw new Error('Download engine is no longer available');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'bfb', method: `aria2.${method}`, params: [`token:${engine.secret}`, ...params] });
    // Private loopback control must bypass environment proxies and global fetch dispatchers.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(engine.endpoint, {
        method: 'POST', agent: engine.controlAgent, signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.once('error', reject);
      request.end(body);
    });
    const value: unknown = JSON.parse(response.body);
    if (response.status !== 200 || typeof value !== 'object' || value === null || 'error' in value || !('result' in value)) {
      throw new Error('Download engine control request failed');
    }
    return value.result;
  }

  private async start(): Promise<Engine> {
    const directory = await fs.mkdtemp(path.join(this.options.temporaryRoot ?? os.tmpdir(), 'bfb-aria2-'));
    await fs.chmod(directory, 0o700);
    const port = await vacantPort();
    const secret = randomBytes(32).toString('hex');
    const endpoint = `http://127.0.0.1:${port}/jsonrpc`;
    const config = path.join(directory, 'aria2.conf');
    try { await fs.writeFile(config, [
      'enable-rpc=true', 'rpc-listen-all=false', `rpc-listen-port=${port}`, `rpc-secret=${secret}`,
      `stop-with-process=${process.pid}`, `max-overall-download-limit=${this.rate}`,
      'max-concurrent-downloads=64', 'max-download-result=10000', 'keep-unfinished-download-result=true',
      'file-allocation=none', 'auto-save-interval=5', 'console-log-level=error', 'summary-interval=0',
      'download-result=hide', 'follow-torrent=false', 'follow-metalink=false',
    ].join('\n') + '\n', { mode: 0o600 }); }
    catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
    const child = spawn(this.options.command ?? process.env.ARIA2_PATH ?? 'aria2c',
      [...(this.options.commandArgs ?? []), '--conf-path', config], { windowsHide: true, stdio: 'ignore' });
    let exited = false;
    const controlAgent = new http.Agent({ keepAlive: true, maxSockets: 4, proxyEnv: {} });
    const engine: Engine = { child, directory, endpoint, secret, controlAgent, failed: false, exited: new Promise<void>(resolve => {
      const done = () => { exited = true; engine.failed = true; controlAgent.destroy(); resolve(); };
      child.once('error', done);
      child.once('exit', done);
    }) };
    try {
      const deadline = Date.now() + 8000;
      while (!exited && Date.now() < deadline && !this.stopped) {
        try {
          await this.call(engine, 'getVersion', []);
          // Configuration can change while the process is starting.
          await this.call(engine, 'changeGlobalOption', [{ 'max-overall-download-limit': String(this.rate) }]);
          return engine;
        } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      throw new Error('Cannot start the private aria2 download engine');
    } catch (error) {
      child.kill();
      await engine.exited;
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async transfers(engine: Engine) {
    const keys = ['gid', 'completedLength', 'status'];
    const values = await Promise.all([
      this.call(engine, 'tellActive', [keys]),
      this.call(engine, 'tellWaiting', [0, 10000, keys]),
      this.call(engine, 'tellStopped', [0, 10000, keys]),
    ]);
    return values.flatMap(rows);
  }

  async acquire(): Promise<DownloadTransport> {
    if (this.stopped) throw new Error('Download engine is stopping');
    const pending = this.engine ??= this.start();
    let engine: Engine;
    try { engine = await pending; }
    catch (error) { if (this.engine === pending) this.engine = undefined; throw error; }
    while (true) {
      const updates = this.updates;
      await updates;
      if (updates === this.updates) break;
    }
    if (engine.failed) {
      // Existing owners retain the failed generation until they finish unwinding.
      if (this.owners.size === 0 && this.engine === pending) {
        await this.dispose(engine);
        if (this.engine === pending) this.engine = undefined;
      }
      throw new Error('Download engine stopped; retrying this task will resume its local files');
    }
    if (this.stopped) throw new Error('Download engine is stopping');
    let prefix = randomBytes(6).toString('hex');
    while (this.owners.has(prefix)) prefix = randomBytes(6).toString('hex');
    this.owners.add(prefix);
    const configPath = path.join(engine.directory, `${prefix}.json`);
    try {
      const options = Object.fromEntries(ARIA2_DOWNLOAD_ARGS.map(argument => {
        const separator = argument.indexOf('=');
        return [argument.slice(2, separator), argument.slice(separator + 1)];
      }));
      Object.assign(options, { 'max-connection-per-server': '16', split: '16', 'min-split-size': '5M' });
      await fs.writeFile(configPath, JSON.stringify({ endpoint: engine.endpoint, secret: engine.secret, gidPrefix: prefix, options }), { mode: 0o600 });
    } catch (error) { this.owners.delete(prefix); throw error; }
    let released = false;
    let releasePromise: Promise<void> | undefined;
    return {
      configPath,
      minimumProgressRate: () => this.rate > 0 ? Number.MIN_VALUE : 10 * 1024,
      // At tiny caps a socket-sized read can legitimately take longer than
      // the normal window; do not mistake waiting for that allowance for a stall.
      progressWindowMs: () => this.rate > 0
        ? Math.max(600_000, Math.ceil(2 * 64 * 1024 * Math.max(1, this.owners.size) / this.rate * 1000))
        : 600_000,
      progressBytes: async () => {
        if (released) throw new Error('Download transport has been released');
        return (await this.transfers(engine)).filter(row => row.gid.startsWith(prefix))
          .reduce((sum, row) => sum + row.completedLength, 0);
      },
      release: () => releasePromise ??= (async () => {
        released = true;
        try {
          if (!engine.failed) {
            const owned = (await this.transfers(engine)).filter(row => row.gid.startsWith(prefix));
            for (const row of owned) {
              if (['active', 'waiting', 'paused'].includes(row.status)) {
                await this.call(engine, 'forceRemove', [row.gid]);
                const deadline = Date.now() + 3000;
                while (true) {
                  const state = rows([await this.call(engine, 'tellStatus', [row.gid, ['gid', 'completedLength', 'status']])])[0];
                  if (!['active', 'waiting', 'paused'].includes(state.status)) break;
                  if (Date.now() >= deadline) throw new Error('Download cancellation timed out');
                  await new Promise(resolve => setTimeout(resolve, 25));
                }
              }
              await this.call(engine, 'removeDownloadResult', [row.gid]);
            }
          }
        } catch {
          // A failed cancellation must not leave an orphan transfer writing after its owner exits.
          engine.failed = true;
          engine.child.kill('SIGKILL');
          await engine.exited;
          throw new Error('Download transport cleanup failed; shared engine stopped');
        } finally {
          this.owners.delete(prefix);
          await fs.rm(configPath, { force: true });
          if (engine.failed && this.owners.size === 0 && this.engine === pending) {
            await this.dispose(engine);
            if (this.engine === pending) this.engine = undefined;
          }
        }
      })(),
    };
  }

  private async dispose(engine: Engine) {
    await engine.exited;
    await fs.rm(engine.directory, { recursive: true, force: true });
  }

  async close(timeoutMs = 10000) {
    this.stopped = true;
    const pending = this.engine;
    if (!pending) return;
    const engine = await pending;
    if (!engine.failed) {
      try { await this.call(engine, 'shutdown', []); } catch { engine.child.kill(); }
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([engine.exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      if (!stopped) { engine.child.kill('SIGKILL'); throw new Error('Download engine did not stop before the deadline'); }
      await this.dispose(engine);
      this.engine = undefined;
    } finally { clearTimeout(timer); }
  }
}
