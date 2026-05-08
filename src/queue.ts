import { EventEmitter } from "node:events";

export abstract class Task {
  id: string;
  name: string;
  maxRetries: number;
  retryDelaySeconds: number;
  retries: number = 0;
  status: "pending" | "running" | "completed" | "error" = "pending";
  error?: Error;

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

  constructor(concurrency: number = 1) {
    super();
    this.concurrency = concurrency;
  }

  setConcurrency(concurrency: number) {
    this.concurrency = concurrency;
    this.processQueue();
  }

  addTask(task: Task) {
    this.queue.push(task);
    this.emit("taskAdded", task);
    this.processQueue();
  }

  getTasks() {
    return [...this.queue];
  }

  private async processQueue() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const task = this.queue.find((t) => t.status === "pending");
    if (!task) {
      return;
    }

    this.activeCount++;
    task.status = "running";
    this.emit("taskStart", task);

    try {
      await task.run();
      task.status = "completed";
      this.emit("taskCompleted", task);
    } catch (error: any) {
      task.error = error;
      // If error is marked as permanent (e.g. video deleted), skip retries
      if (error?.permanent || task.retries >= task.maxRetries) {
        task.status = "error";
        this.emit("taskError", task, error);
      } else {
        task.retries++;
        task.status = "pending";
        this.emit("taskRetry", task, error);
        
        // Push to end of queue after delay
        this.queue = this.queue.filter(t => t.id !== task.id);
        setTimeout(() => {
          this.queue.push(task);
          this.processQueue();
        }, task.retryDelaySeconds * 1000);
      }
    } finally {
      this.activeCount--;
      
      // Remove completed or permanently failed tasks
      if (task.status === "completed" || task.status === "error") {
        this.queue = this.queue.filter(t => t.id !== task.id);
      }

      this.processQueue();
    }
  }
}
