import type { TaskQueue } from '../queue.js';
import type { UploadVerificationTask, DownloadTask, QualityUpgradeDownloadTask, UploadTask, QualityUpgradeUploadReplaceTask, QualityUpgradeReplaceTask, QualityUpgradeCleanupTask } from '../tasks.js';
import type { EventSource } from './queue-events.js';

type DownloadTaskEvent = DownloadTask | QualityUpgradeDownloadTask;
type QualityUploadTaskEvent = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;
type UploadTaskEvent = UploadTask | QualityUploadTaskEvent;
type Register = <Arguments extends unknown[]>(source: EventSource<Arguments>, event: string, handler: (...args: Arguments) => void) => void;

export interface TaskEventHandlers {
  downloadStart(task: DownloadTaskEvent): void;
  uploadStart(task: UploadTaskEvent): void;
  uploadSettled(): void;
  downloadSettled(): void;
  verificationStart(task: UploadVerificationTask): void;
  verificationCompleted(task: UploadVerificationTask): void;
  verificationError(task: UploadVerificationTask, error: unknown): void;
  verificationSettled(): void;
}

/** Keeps queue subscription wiring separate from task failure and completion policy. */
export function bindTaskLifecycleEvents(
  register: Register,
  queues: { download: TaskQueue; upload: TaskQueue; verification: TaskQueue },
  handlers: TaskEventHandlers,
) {
  register(queues.download, 'taskStart', handlers.downloadStart);
  register(queues.upload, 'taskStart', handlers.uploadStart);
  register(queues.upload, 'taskSettled', handlers.uploadSettled);
  register(queues.download, 'taskSettled', handlers.downloadSettled);
  register(queues.verification, 'taskStart', handlers.verificationStart);
  register(queues.verification, 'taskCompleted', handlers.verificationCompleted);
  register(queues.verification, 'taskError', handlers.verificationError);
  register(queues.verification, 'taskSettled', handlers.verificationSettled);
}
