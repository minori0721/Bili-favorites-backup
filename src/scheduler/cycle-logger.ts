import type { LogEntry } from '../logger.js';
import type { SyncCycleStats } from './sync-runtime.js';

export function createCycleLogger(dependencies: {
  now(): number;
  push(entry: LogEntry): void;
}) {
  function log(stats: SyncCycleStats) {
    const isNoNew = stats.newItems === 0 && !stats.error;
    const modeLabel = stats.trigger === 'reconcile'
      ? 'reconcile'
      : (stats.trigger === 'remote_reconcile' ? 'remote_reconcile' : (stats.trigger === 'manual' ? 'manual' : 'auto'));
    const durationMs = Math.max(0, dependencies.now() - Date.parse(stats.startedAt));
    const durationSec = (durationMs / 1000).toFixed(1);

    if (stats.trigger === 'reconcile' || stats.trigger === 'remote_reconcile') {
      const level = stats.error ? 'error' : 'info';
      dependencies.push({
        timestamp: new Date(dependencies.now()).toISOString(),
        type: 'system',
        level,
        summary: stats.error
          ? `${modeLabel} failed: ${stats.error}`
          : `${modeLabel} done: new ${stats.newItems}, queued ${stats.queuedItems}, remote ${stats.remoteChecked}/${stats.remoteEligible}, missing ${stats.remoteMissingDetected}, requeued ${stats.requeuedFromRemoteMissing}, ${durationSec}s`,
        raw: `[Scheduler] ${modeLabel} done. remoteChecked=${stats.remoteChecked}/${stats.remoteEligible}, remoteOk=${stats.remoteOk}, missing=${stats.remoteMissingDetected}, missingUnavailable=${stats.remoteMissingUnavailable}, requeued=${stats.requeuedFromRemoteMissing}, remoteErrors=${stats.remoteErrors}, durationSec=${durationSec}${stats.error ? `, error=${stats.error}` : ''}`,
        simpleVisible: true,
      });
      return;
    }

    if (isNoNew) {
      dependencies.push({
        timestamp: new Date(dependencies.now()).toISOString(),
        type: 'system',
        level: 'info',
        summary: `${modeLabel} done: no new videos, remote ${stats.remoteChecked}/${stats.remoteEligible}, missing ${stats.remoteMissingDetected}, ${durationSec}s`,
        raw: `[Scheduler] no new videos this cycle. mode=${modeLabel}, remoteChecked=${stats.remoteChecked}/${stats.remoteEligible}, missing=${stats.remoteMissingDetected}, missingUnavailable=${stats.remoteMissingUnavailable}, requeued=${stats.requeuedFromRemoteMissing}, remoteErrors=${stats.remoteErrors}, durationSec=${durationSec}`,
        simpleVisible: true,
      });
      return;
    }

    dependencies.push({
      timestamp: new Date(dependencies.now()).toISOString(),
      type: 'system',
      level: stats.error ? 'error' : 'info',
      summary: stats.error
        ? `${modeLabel} failed: ${stats.error}`
        : `${modeLabel} done: new ${stats.newItems}, queued ${stats.queuedItems}, requeued ${stats.requeuedFromRemoteMissing}, ${durationSec}s`,
      raw: `[Scheduler] cycle done. mode=${modeLabel}, new=${stats.newItems}, queued=${stats.queuedItems}, remoteChecked=${stats.remoteChecked}/${stats.remoteEligible}, remoteOk=${stats.remoteOk}, missing=${stats.remoteMissingDetected}, missingUnavailable=${stats.remoteMissingUnavailable}, requeued=${stats.requeuedFromRemoteMissing}, remoteErrors=${stats.remoteErrors}, durationSec=${durationSec}${stats.error ? `, error=${stats.error}` : ''}`,
      simpleVisible: true,
    });
  }

  return { log };
}
