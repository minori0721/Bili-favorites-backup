import { isRecord } from '../../shared/api.js';
import { ApiError } from '../../shared/api.js';
import { SessionExpiredError } from '../../shared/session.js';

export interface LogEntry {level:string; timestamp:string; summary:string; raw:string; simpleVisible:boolean; debugVisible:boolean}
export interface LogConnection {
  onopen?: (() => void) | null;
  onmessage: ((event: {data:string}) => void) | null;
  onerror: (() => void) | null;
  close():void;
}
export function parseLogEntry(value:unknown):LogEntry | null {
  if (!isRecord(value)) return null;
  const text = (key:string) => typeof value[key] === 'string' ? value[key] : '';
  return {level:text('level'),timestamp:text('timestamp'),summary:text('summary'),raw:text('raw'),
    simpleVisible:value.simpleVisible !== false,debugVisible:value.debugVisible === true};
}

export function createLogFeed(dependencies: {
  connect():LogConnection;
  receive(entry:LogEntry):void;
  schedule?(callback:() => void, ms:number):number;
  cancel?(handle:number):void;
  checkSession?(signal: AbortSignal): Promise<unknown>;
  random?(): number;
}) {
  const schedule = dependencies.schedule || ((callback,ms) => window.setTimeout(callback,ms));
  const cancel = dependencies.cancel || (handle => window.clearTimeout(handle));
  let running = false;
  let connection: LogConnection | null = null;
  let reconnect: number | null = null;
  let checking: AbortController | null = null;
  let checkTimeout: number | null = null;
  let retryAttempt = 0;
  const entries: LogEntry[] = [];
  function scheduleReconnect() {
    if (!running || reconnect !== null) return;
    const base = Math.min(3000 * 2 ** Math.min(retryAttempt++, 4), 30_000);
    const wait = Math.min(30_000, Math.round(base * (0.9 + (dependencies.random ?? Math.random)() * 0.2)));
    reconnect = schedule(() => { reconnect = null; connect(); }, wait);
  }
  function connect() {
    if (!running || connection) return;
    const source = dependencies.connect();
    connection = source;
    source.onopen = () => { if (running && connection === source) retryAttempt = 0; };
    source.onmessage = event => {
      if (!running || connection !== source) return;
      retryAttempt = 0;
      let value:unknown;
      try { value = JSON.parse(event.data); } catch { return; }
      const entry = parseLogEntry(value);
      if (!entry) return;
      entries.push(entry);
      if (entries.length > 500) entries.splice(0,entries.length - 500);
      dependencies.receive(entry);
    };
    source.onerror = () => {
      if (!running || connection !== source) return;
      source.onmessage = null;
      source.onerror = null;
      source.onopen = null;
      source.close();
      connection = null;
      if (!dependencies.checkSession) {
        scheduleReconnect();
        return;
      }
      const check = new AbortController();
      checking = check;
      const timeout = new Promise<never>((_resolve, reject) => {
        checkTimeout = schedule(() => {
          const error = new DOMException('Session check timed out', 'TimeoutError');
          check.abort(error);
          reject(error);
        }, 10_000);
      });
      const request = Promise.resolve().then(() => {
        if (!check.signal.aborted) return dependencies.checkSession?.(check.signal);
      });
      void Promise.race([request, timeout]).catch(error => {
        if (checking !== check || !running) return;
        if (error instanceof SessionExpiredError || (error instanceof ApiError && error.status === 401)) running = false;
      }).finally(() => {
        if (checking !== check) return;
        if (checkTimeout !== null) cancel(checkTimeout);
        checkTimeout = null;
        checking = null;
        scheduleReconnect();
      });
    };
  }
  return {
    start() { if (running) return; retryAttempt = 0; running = true; connect(); },
    stop() {
      running = false;
      checking?.abort(); checking = null;
      if (checkTimeout !== null) cancel(checkTimeout);
      checkTimeout = null;
      if (reconnect !== null) cancel(reconnect);
      reconnect = null;
      if (connection) { connection.onmessage = null; connection.onerror = null; connection.onopen = null; connection.close(); }
      connection = null;
    },
    recent() { return entries.slice(-200); },
  };
}
