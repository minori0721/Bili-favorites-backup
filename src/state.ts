import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

export interface ProcessedEntry {
  bvid: string;
  mediaId: number;
  processedAt: string;
}

export interface StateFile {
  processedByUser: Record<string, Record<string, ProcessedEntry>>;
}

const statePath = path.join(dataDir, "state.json");
const defaultState: StateFile = { processedByUser: {} };

export class StateManager {
  private state: StateFile;

  constructor() {
    this.state = readJsonFile<StateFile>(statePath, defaultState);
  }

  isProcessed(userId: string, bvid: string) {
    return Boolean(this.state.processedByUser[userId]?.[bvid]);
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
    this.save();
  }

  private save() {
    writeJsonFile(statePath, this.state);
  }
}
