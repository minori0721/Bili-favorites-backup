import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

export interface ProcessedEntry {
  bvid: string;
  mediaId: number;
  processedAt: string;
}

export interface FailedEntry {
  bvid: string;
  mediaId: number;
  failedAt: string;
  reason: string;
  permanent: boolean;
}

export interface StateFile {
  processedByUser: Record<string, Record<string, ProcessedEntry>>;
  failedByUser?: Record<string, Record<string, FailedEntry>>;
}

const statePath = path.join(dataDir, "state.json");
const defaultState: StateFile = { processedByUser: {}, failedByUser: {} };

export class StateManager {
  private state: StateFile;

  constructor() {
    this.state = readJsonFile<StateFile>(statePath, defaultState);
    this.state.processedByUser ||= {};
    this.state.failedByUser ||= {};
  }

  isProcessed(userId: string, bvid: string) {
    return Boolean(this.state.processedByUser[userId]?.[bvid]);
  }

  isFailed(userId: string, bvid: string) {
    return Boolean(this.state.failedByUser?.[userId]?.[bvid]);
  }

  markProcessed(userId: string, bvid: string, mediaId: number) {
    if (!this.state.processedByUser[userId]) {
      this.state.processedByUser[userId] = {};
    }
    this.state.processedByUser[userId][bvid] = {
      bvid,
      mediaId,
      processedAt: new Date().toISOString(),
    };
    delete this.state.failedByUser?.[userId]?.[bvid];
    this.save();
  }

  markFailed(userId: string, bvid: string, mediaId: number, reason: string, permanent = true) {
    this.state.failedByUser ||= {};
    if (!this.state.failedByUser[userId]) {
      this.state.failedByUser[userId] = {};
    }
    this.state.failedByUser[userId][bvid] = {
      bvid,
      mediaId,
      reason,
      permanent,
      failedAt: new Date().toISOString(),
    };
    this.save();
  }

  getAllProcessed() {
    return { ...this.state.processedByUser };
  }

  getAllFailed() {
    return { ...(this.state.failedByUser || {}) };
  }

  private save() {
    writeJsonFile(statePath, this.state);
  }
}
