import { createLogFeed, type LogEntry, type LogConnection } from './log-feed.js';

export type LogMode = 'queue' | 'simple' | 'raw' | 'debug';
export function createLogController(root:HTMLElement, checkSession: (signal: AbortSignal) => Promise<unknown>) {
  let mode:LogMode = 'queue';
  function append(entry:LogEntry) {
    if (mode === 'queue') return;
    if (mode === 'simple' && !entry.simpleVisible) return;
    if (mode === 'debug' && !entry.debugVisible && entry.level !== 'error' && entry.level !== 'warn') return;
    const div = root.ownerDocument.createElement('div');
    div.className = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN') : '';
    div.textContent = time + ' ' + (mode === 'simple' ? entry.summary || entry.raw : entry.raw || entry.summary);
    root.appendChild(div);
    while (root.children.length > 200 && root.firstChild) root.removeChild(root.firstChild);
    root.scrollTop = root.scrollHeight;
  }
  const feed = createLogFeed({connect:() => {
    const source = new EventSource('/api/logs/stream');
    const connection: LogConnection = {onmessage:null,onerror:null,close:() => {
      source.onmessage = null; source.onerror = null; source.close();
    }};
    source.onmessage = event => connection.onmessage?.({data:String(event.data)});
    source.onerror = () => connection.onerror?.();
    return connection;
  },receive:append,checkSession});
  return {
    init:feed.start,
    destroy:feed.stop,
    setMode(next:LogMode) { mode = next; if (mode !== 'queue') { root.replaceChildren(); feed.recent().forEach(append); } },
  };
}
