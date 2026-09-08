import { isRecord } from '../../shared/api.js';

export interface LogEntry {level:string; timestamp:string; summary:string; raw:string; simpleVisible:boolean; debugVisible:boolean}
export interface LogConnection {
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
}) {
  const schedule = dependencies.schedule || ((callback,ms) => window.setTimeout(callback,ms));
  const cancel = dependencies.cancel || (handle => window.clearTimeout(handle));
  let running = false;
  let connection: LogConnection | null = null;
  let reconnect: number | null = null;
  let checking: AbortController | null = null;
  const entries: LogEntry[] = [];
  function connect() {
    if (!running || connection) return;
    const source = dependencies.connect();
    connection = source;
    source.onmessage = event => {
      if (!running || connection !== source) return;
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
      source.close();
      connection = null;
      if (!dependencies.checkSession) {
        if (reconnect === null) reconnect = schedule(() => { reconnect = null; connect(); },3000);
        return;
      }
      const check = new AbortController();
      checking = check;
      void Promise.resolve().then(() => {
        if (!check.signal.aborted) return dependencies.checkSession?.(check.signal);
      }).catch(() => { /* Authentication expiry stops this feed through application disposal. */ }).finally(() => {
        if (checking !== check) return;
        checking = null;
        if (running && !check.signal.aborted && reconnect === null) reconnect = schedule(() => { reconnect = null; connect(); },3000);
      });
    };
  }
  return {
    start() { if (running) return; running = true; connect(); },
    stop() {
      running = false;
      checking?.abort(); checking = null;
      if (reconnect !== null) cancel(reconnect);
      reconnect = null;
      if (connection) { connection.onmessage = null; connection.onerror = null; connection.close(); }
      connection = null;
    },
    recent() { return entries.slice(-200); },
  };
}
