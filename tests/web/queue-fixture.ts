import { parseQueueSnapshot } from '../../src/shared/api/queue-snapshot.js';
export function queueResponse(value: unknown = {}) {
  return {scheduler: {status: 'idle' as const, queuedActions: []}, recovery: {}, downloadPending: [], downloadRunning: [], uploadPending: [], uploadRunning: [], actionRequiredIssues: [], intentionalConfirmations: [], ...(value as object)};
}
export function parseQueueFixture(value: unknown = {}) { return parseQueueSnapshot(queueResponse(value)); }
