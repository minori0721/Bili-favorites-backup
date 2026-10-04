import type { QueueBoardItem, QueueBoardStage, QueueBoardPhase } from './shared/api/queue-item.js';
export type { QueueBoardItem, QueueBoardStage, QueueBoardPhase, QueueBoardAction } from './shared/api/queue-item.js';
import { EventEmitter } from "node:events";
import { safeErrorSummary, sanitizeDiagnosticText } from "./diagnostics.js";

export abstract class Task {
  id: string;
  name: string;
  maxRetries: number;
  retryDelaySeconds: number;
  retries: number = 0;
  status: "pending" | "running" | "retry_wait" | "completed" | "error" = "pending";
  error?: Error;
  queuedAt?: number;
  startedAt?: number;
  retryAt?: number;
  sequence?: number;
  persistentJobId?: string;
  persistentJob?: import('./database.js').PersistentJobRecord;
  runtimeGeneration?: number;
  bvid?: string;
  userId?: string;
  mediaId?: number;
  videoTitle?: string;
  title?: string;
  upperName?: string;
  cover?: string;
  coverLocalPath?: string;
  folderTitle?: string;
  remotePath?: string;
  private taskDetail?: string;
  get detail(): string | undefined { return this.taskDetail; }
  set detail(value: string | undefined) { this.taskDetail = value; }
  target?: {userId: string; mediaId: number; folderTitle: string; remotePath: string};
  targets?: Array<{userId: string; mediaId: number; folderTitle: string; remotePath: string}>;

  constructor(
    name: string,
    options?: { maxRetries?: number; retryDelaySeconds?: number }
  ) {
    this.id = Math.random().toString(36).substring(2, 15);
    this.name = name;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelaySeconds = options?.retryDelaySeconds ?? 5;
  }

  abstract run(): Promise<void>;
}

export function mapQueueBoardTask(task: Omit<Partial<Pick<Task, 'id' | 'bvid' | 'videoTitle' | 'title' | 'upperName' | 'cover' | 'folderTitle' | 'remotePath' | 'target' | 'detail' | 'userId' | 'mediaId' | 'retries' | 'maxRetries' | 'queuedAt' | 'startedAt' | 'retryAt' | 'sequence' | 'error' | 'coverLocalPath' | 'persistentJobId'>>, 'cover' | 'coverLocalPath' | 'error'> & { status?: string; cover?: unknown; coverLocalPath?: unknown; error?: unknown }, stage: QueueBoardStage, overrides: Partial<QueueBoardItem> = {}): QueueBoardItem {
  const target = task.target;
  const status = String(task.status || "pending");
  const isRetryWait = status === "retry_wait";
  const phase: QueueBoardPhase = status === "running"
    ? "running"
    : status === "retry_wait"
      ? "retry_wait"
      : "queued";
  const errorMessage = task.error && typeof task.error === "object" && "message" in task.error && typeof task.error.message === "string"
    ? task.error.message
    : undefined;
  return {
    id: String(task.id || ""),
    bvid: String(task.bvid || ""),
    title: String(task.videoTitle || task.title || task.bvid || ""),
    upperName: String(task.upperName || ""),
    cover: typeof task.cover === "string" ? task.cover : "",
    folderTitle: String(task.folderTitle || target?.folderTitle || ""),
    remotePath: String(task.remotePath || target?.remotePath || ""),
    detail: String(task.detail || ""),
    userId: task.userId ? String(task.userId) : (target?.userId ? String(target?.userId) : ""),
    mediaId: Number(task.mediaId || target?.mediaId || 0),
    retries: Number(task.retries || 0),
    maxRetries: Number(task.maxRetries || 0),
    queuedAt: typeof task.queuedAt === "number" ? task.queuedAt : undefined,
    startedAt: typeof task.startedAt === "number" ? task.startedAt : undefined,
    retryAt: typeof task.retryAt === "number" ? task.retryAt : undefined,
    sequence: typeof task.sequence === "number" ? task.sequence : undefined,
    status,
    phase,
    nextAction: isRetryWait ? "retry" : undefined,
    nextActionAt: isRetryWait && typeof task.retryAt === "number" ? task.retryAt : undefined,
    actionRequired: false,
    lastError: errorMessage ? sanitizeDiagnosticText(errorMessage, 500) : undefined,
    coverLocalPath: typeof task.coverLocalPath === "string" ? task.coverLocalPath : undefined,
    persistentJobId: task.persistentJobId ? String(task.persistentJobId) : undefined,
    ...overrides,
    stage,
  };
}

export class TaskQueue extends EventEmitter {
  private queue: Task[] = [];
  private activeCount: number = 0;
  private concurrency: number;
  private sequenceCounter = 0;
  private canStartTask?: (task: Task) => boolean;
  private beforeRun?: (task: Task) => boolean;
  private failure: Error | null = null;
  private onFailure?: (error: QueueLifecycleError) => void;
  private maxSize: number;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(concurrency: number = 1, maxSize = Number.POSITIVE_INFINITY) {
    super();
    this.concurrency = concurrency;
    this.maxSize = maxSize;
  }

  setConcurrency(concurrency: number) {
    this.concurrency = concurrency;
    this.processQueue();
  }

  setStartGate(canStartTask?: (task: Task) => boolean) {
    this.canStartTask = canStartTask;
    this.processQueue();
  }

  /** A stale claim is discarded without executing or changing its durable job. */
  setBeforeRun(beforeRun: (task: Task) => boolean) { this.beforeRun = beforeRun; }

  setFailureHandler(handler: (error: QueueLifecycleError) => void) { this.onFailure = handler; }

  getFailure() { return this.failure; }

  halt(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  hasPersistentJob(id: string) {
    return this.queue.some(task => task.persistentJobId === id
      && (task.status === 'pending' || task.status === 'running' || task.status === 'retry_wait'));
  }

  setMaxSize(maxSize: number) {
    this.maxSize = Math.max(this.concurrency, Math.floor(maxSize));
  }

  poke() {
    this.processQueue();
  }

  canAccept(count = 1) {
    return !this.failure && this.queue.length + count <= this.maxSize;
  }

  addTask(task: Task) {
    if (!this.canAccept() || this.queue.includes(task) || (task.persistentJobId && this.hasPersistentJob(task.persistentJobId))) return false;
    this.prepareTask(task);
    this.queue.push(task);
    try { this.emit("taskAdded", task); }
    catch (error) { this.fail(task, 'admission', error); return false; }
    this.processQueue();
    return true;
  }

  addTasks(tasks: Task[]) {
    let accepted = 0;
    for (const task of tasks) {
      if (!this.canAccept()) break;
      if (this.queue.includes(task) || (task.persistentJobId && this.hasPersistentJob(task.persistentJobId))) continue;
      this.prepareTask(task);
      this.queue.push(task);
      try { this.emit("taskAdded", task); }
      catch (error) { this.fail(task, 'admission', error); break; }
      accepted++;
    }
    this.processQueue();
    return accepted;
  }

  private prepareTask(task: Task) {
    if (typeof task.queuedAt !== "number") {
      task.queuedAt = Date.now();
    }
    if (typeof task.sequence !== "number") {
      this.sequenceCounter += 1;
      task.sequence = this.sequenceCounter;
    }
  }

  getTasks() {
    return [...this.queue];
  }

  getTaskCount() {
    return this.queue.length;
  }

  removePendingTasks(predicate: (task: Task) => boolean) {
    const removed = this.queue.filter((task) =>
      (task.status === "pending" || task.status === "retry_wait") && predicate(task)
    );
    if (removed.length === 0) return [];
    const removedIds = new Set(removed.map((task) => task.id));
    this.queue = this.queue.filter((task) => !removedIds.has(task.id));
    for (const task of removed) {
      const timer = this.retryTimers.get(task.id);
      if (timer) clearTimeout(timer);
      this.retryTimers.delete(task.id);
      task.status = "error";
      this.emit("taskSettled", task);
    }
    this.processQueue();
    return removed;
  }

  getActiveCount() {
    return this.activeCount;
  }

  getPendingCount() {
    return this.queue.filter((task) => task.status === "pending").length;
  }

  getRetryWaitCount() {
    return this.queue.filter((task) => task.status === "retry_wait").length;
  }

  getSize() {
    return this.queue.length;
  }

  isBusy() {
    return this.getActiveCount() > 0 || this.getPendingCount() > 0 || this.getRetryWaitCount() > 0;
  }

  private processQueue() {
    if (this.failure || this.activeCount >= this.concurrency) {
      return;
    }
    const runnableTasks = this.queue.filter((t) => t.status === "pending");
    for (const task of runnableTasks) {
      if (this.failure || this.activeCount >= this.concurrency) {
        return;
      }
      try {
        if (this.canStartTask && !this.canStartTask(task)) continue;
      } catch (error) {
        this.fail(task, 'admission', error);
        return;
      }
      if (task.status !== 'pending' || !this.queue.includes(task)) continue;
      // runTask handles lifecycle errors and always releases its active slot.
      void this.runTask(task).catch(error => this.fail(task, 'settled', error));
    }
  }

  private async runTask(task: Task) {
    this.activeCount++;
    let phase: QueueLifecyclePhase = 'start';
    try {
      if (this.beforeRun && !this.beforeRun(task)) {
        task.status = 'error';
        return;
      }
      task.status = "running";
      task.startedAt = Date.now();
      this.emit("taskStart", task);
      if (this.failure) { task.status = 'error'; return; }
      try {
        await task.run();
      } catch (error: unknown) {
        if (this.failure) { task.status = 'error'; return; }
        // Only the task's own failure enters retry policy. Commit/listener
        // failures must never restart an already successful transfer.
        phase = 'failure';
        this.handleTaskFailure(task, error);
        return;
      }
      if (this.failure) { task.status = 'error'; return; }
      phase = 'completion';
      task.status = "completed";
      this.emit("taskCompleted", task);
    } catch (error) {
      task.status = 'error';
      this.fail(task, phase, error);
    } finally {
      this.activeCount--;
      if (task.status === "completed" || task.status === "error") {
        this.queue = this.queue.filter(t => t !== task);
      }
      try {
        this.emit("taskSettled", task);
      } catch (error) {
        this.fail(task, 'settled', error);
      }
      this.processQueue();
    }
  }

  private fail(task: Task, phase: QueueLifecyclePhase, cause: unknown) {
    if (this.failure) return;
    const failure = new QueueLifecycleError(task, phase, cause);
    this.halt(failure);
    // This notification is the terminal application boundary, not task retry.
    console.error(`[Queue] ${failure.message}`);
    try {
      this.onFailure?.(failure);
    } catch (error) {
      console.error(`[Queue] Failure notification failed: ${safeErrorSummary(error)}`);
    }
  }

  private handleTaskFailure(task: Task, error: unknown) {
    task.error = error instanceof Error ? error : new Error(String(error));
    const failure = error !== null && typeof error === 'object' ? error : {};
    const permanent = 'permanent' in failure && failure.permanent === true;
    const deferred = 'deferToNextCycle' in failure && failure.deferToNextCycle === true;
    const retryDelay = 'retryAfterMs' in failure ? failure.retryAfterMs : undefined;
    if (permanent || deferred || task.retries >= task.maxRetries) {
      task.status = "error";
      this.emit("taskError", task, error);
    } else {
      const retryIndex = task.retries;
      task.retries++;
      task.status = "retry_wait";
      task.startedAt = undefined;
      const retryAfterMs = computeTaskRetryDelayMs(task.retryDelaySeconds, retryIndex, typeof retryDelay === 'number' ? retryDelay : undefined);
      task.retryAt = Date.now() + retryAfterMs;
      this.emit("taskRetry", task, error);
      if (this.failure || !this.queue.includes(task) || task.status !== 'retry_wait') return;
      const timer = setTimeout(() => {
        this.retryTimers.delete(task.id);
        task.status = "pending";
        task.retryAt = undefined;
        this.processQueue();
      }, retryAfterMs);
      this.retryTimers.set(task.id, timer);
    }
  }

  async waitForIdle(timeoutMs = 20_000) {
    if (this.failure) throw this.failure;
    if (!this.isBusy()) return true;
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener("taskSettled", onSettled);
        if (this.failure) reject(this.failure);
        else resolve(value);
      };
      const onSettled = () => {
        if (!this.isBusy()) finish(true);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.on("taskSettled", onSettled);
    });
  }
}

export type QueueLifecyclePhase = 'admission' | 'start' | 'completion' | 'failure' | 'settled';
export class QueueLifecycleError extends Error {
  readonly taskId: string;
  readonly persistentJobId?: string;
  constructor(task: Task, readonly phase: QueueLifecyclePhase, readonly cause: unknown) {
    const detail = sanitizeDiagnosticText(cause instanceof Error ? cause.message : String(cause), 500);
    super(`Task lifecycle failed: phase=${phase} task=${task.id} job=${task.persistentJobId ?? 'none'}: ${detail}`);
    this.name = 'QueueLifecycleError';
    this.taskId = task.id;
    this.persistentJobId = task.persistentJobId;
  }
}

export function computeTaskRetryDelayMs(baseSeconds: number, retryIndex: number, explicitDelayMs?: number, random = Math.random) {
  if (Number.isFinite(explicitDelayMs) && Number(explicitDelayMs) >= 0) {
    return Math.min(Number(explicitDelayMs), 15 * 60_000);
  }
  const baseMs = Math.max(1000, Number(baseSeconds || 1) * 1000);
  const exponential = Math.min(baseMs * Math.pow(2, Math.max(0, retryIndex)), 15 * 60_000);
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1000, Math.round(exponential * jitter));
}
