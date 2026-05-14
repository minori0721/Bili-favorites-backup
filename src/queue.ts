import { EventEmitter } from "node:events";

export abstract class Task {
  id: string;
  name: string;
  maxRetries: number;
  retryDelaySeconds: number;
  retries: number = 0;
  status: "pending" | "running" | "retry_wait" | "completed" | "error" = "pending";
  error?: Error;
  [key: string]: any; // Allow dynamic properties for task metadata (userId, mediaId, etc)

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

export type QueueBoardStage = "download_pending" | "download_running" | "upload_pending" | "upload_running";

export interface QueueBoardItem {
  id: string;
  bvid: string;
  title: string;
  upperName: string;
  cover: string;
  folderTitle: string;
  remotePath: string;
  detail: string;
  userId: string;
  mediaId: number;
  retries: number;
  maxRetries: number;
  queuedAt?: number;
  startedAt?: number;
  retryAt?: number;
  sequence?: number;
  stage: QueueBoardStage;
}

export function mapQueueBoardTask(task: any, stage: QueueBoardStage, overrides: Partial<QueueBoardItem> = {}): QueueBoardItem {
  const target = task.target || {};
  return {
    id: String(task.id || ""),
    bvid: String(task.bvid || ""),
    title: String(task.videoTitle || task.title || task.bvid || ""),
    upperName: String(task.upperName || ""),
    cover: task.cover ? String(task.cover) : "",
    folderTitle: String(task.folderTitle || target.folderTitle || ""),
    remotePath: String(task.remotePath || target.remotePath || ""),
    detail: String(task.detail || ""),
    userId: task.userId ? String(task.userId) : (target.userId ? String(target.userId) : ""),
    mediaId: Number(task.mediaId || target.mediaId || 0),
    retries: Number(task.retries || 0),
    maxRetries: Number(task.maxRetries || 0),
    queuedAt: typeof task.queuedAt === "number" ? task.queuedAt : undefined,
    startedAt: typeof task.startedAt === "number" ? task.startedAt : undefined,
    retryAt: typeof task.retryAt === "number" ? task.retryAt : undefined,
    sequence: typeof task.sequence === "number" ? task.sequence : undefined,
    ...overrides,
    stage,
  };
}

export class TaskQueue extends EventEmitter {
  private queue: Task[] = [];
  private activeCount: number = 0;
  private concurrency: number;
  private sequenceCounter = 0;

  constructor(concurrency: number = 1) {
    super();
    this.concurrency = concurrency;
  }

  setConcurrency(concurrency: number) {
    this.concurrency = concurrency;
    this.processQueue();
  }

  addTask(task: Task) {
    if (typeof task.queuedAt !== "number") {
      task.queuedAt = Date.now();
    }
    if (typeof task.sequence !== "number") {
      this.sequenceCounter += 1;
      task.sequence = this.sequenceCounter;
    }
    this.queue.push(task);
    this.emit("taskAdded", task);
    this.processQueue();
  }

  getTasks() {
    return [...this.queue];
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

  isBusy() {
    return this.getActiveCount() > 0 || this.getPendingCount() > 0 || this.getRetryWaitCount() > 0;
  }

  private processQueue() {
    if (this.activeCount >= this.concurrency) {
      return;
    }
    const runnableTasks = this.queue.filter((t) => t.status === "pending");
    for (const task of runnableTasks) {
      if (this.activeCount >= this.concurrency) {
        return;
      }
      void this.runTask(task);
    }
  }

  private async runTask(task: Task) {
    this.activeCount++;
    task.status = "running";
    task.startedAt = Date.now();
    this.emit("taskStart", task);

    try {
      await task.run();
      task.status = "completed";
      this.emit("taskCompleted", task);
    } catch (error: any) {
      task.error = error;
      if (error?.permanent || error?.deferToNextCycle || task.retries >= task.maxRetries) {
        task.status = "error";
        this.emit("taskError", task, error);
      } else {
        task.retries++;
        task.status = "retry_wait";
        task.startedAt = undefined;
        task.retryAt = Date.now() + task.retryDelaySeconds * 1000;
        this.emit("taskRetry", task, error);
        setTimeout(() => {
          task.status = "pending";
          task.retryAt = undefined;
          this.processQueue();
        }, task.retryDelaySeconds * 1000);
      }
    } finally {
      this.activeCount--;
      if (task.status === "completed" || task.status === "error") {
        this.queue = this.queue.filter(t => t.id !== task.id);
      }

      this.processQueue();
    }
  }
}
