import { EventEmitter } from "node:events";

export abstract class Task {
  id: string;
  name: string;
  maxRetries: number;
  retryDelaySeconds: number;
  retries: number = 0;
  status: "pending" | "running" | "completed" | "error" = "pending";
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

  isBusy() {
    return this.getActiveCount() > 0 || this.getPendingCount() > 0;
  }

  private processQueue() {
    while (this.activeCount < this.concurrency) {
      const task = this.queue.find((t) => t.status === "pending");
      if (!task) {
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
        task.status = "pending";
        task.startedAt = undefined;
        this.emit("taskRetry", task, error);
        this.queue = this.queue.filter(t => t.id !== task.id);
        setTimeout(() => {
          this.queue.push(task);
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
