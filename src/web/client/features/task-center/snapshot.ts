import type { ApiClient } from '../../shared/api.js';
import { parseQueueSnapshot, parseQueueIssueUpdate, type QueueSnapshot } from '../../../../shared/api/queue-snapshot.js';

interface Consumer {
  resolve(value:QueueSnapshot):void;
  reject(reason:unknown):void;
  detach():void;
}
interface Flight {controller:AbortController; consumers:Set<Consumer>}
const aborted = () => new DOMException('The operation was aborted','AbortError');

/** Board and issue panel share one request; closing either releases only its own subscription. */
export function createQueueSnapshotResource(dependencies:{api:ApiClient; receive(snapshot:QueueSnapshot):void}) {
  let active:Flight | null = null;
  let snapshot:QueueSnapshot | null = null;
  async function execute(flight:Flight) {
    try {
      const next = parseQueueSnapshot(await dependencies.api.silent('/api/queue/state',{signal:flight.controller.signal}));
      if (active !== flight || flight.controller.signal.aborted) return;
      snapshot = next;
      dependencies.receive(next);
      for (const consumer of flight.consumers) { consumer.detach(); consumer.resolve(next); }
    } catch (error) {
      if (active !== flight) return;
      for (const consumer of flight.consumers) { consumer.detach(); consumer.reject(error); }
    } finally {
      flight.consumers.clear();
      if (active === flight) active = null;
    }
  }
  function cancel() {
    if (!active) return;
    const flight = active;
    active = null;
    flight.controller.abort();
    for (const consumer of flight.consumers) { consumer.detach(); consumer.reject(aborted()); }
    flight.consumers.clear();
  }
  return {
    get current() { return snapshot; },
    request(signal?:AbortSignal):Promise<QueueSnapshot> {
      if (signal?.aborted) return Promise.reject(aborted());
      let start = false;
      if (!active) { active = {controller:new AbortController(),consumers:new Set()}; start = true; }
      const flight = active;
      const result = new Promise<QueueSnapshot>((resolve,reject) => {
        const consumer:Consumer = {resolve,reject,detach:() => signal?.removeEventListener('abort',onAbort)};
        const onAbort = () => {
          consumer.detach();
          flight.consumers.delete(consumer);
          reject(aborted());
          if (flight.consumers.size === 0) {
            flight.controller.abort();
            if (active === flight) active = null;
          }
        };
        flight.consumers.add(consumer);
        signal?.addEventListener('abort',onAbort,{once:true});
      });
      if (start) void execute(flight);
      return result;
    },
    cancel,
    applyIssueUpdate(value:unknown) {
      const update = parseQueueIssueUpdate(value);
      if (!snapshot) throw new Error('任务中心尚未加载，请刷新后查看处理结果');
      // A GET started before this mutation completed may still describe the old issue list.
      cancel();
      snapshot = {...snapshot, issues:update.issues, issueSummary:update.issueSummary};
      dependencies.receive(snapshot);
    },
    reset() { cancel(); snapshot = null; },
  };
}
