import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";

export interface LogEntry {
  timestamp: string;
  type: "download" | "upload" | "system";
  level: "info" | "warn" | "error";
  /** Human-friendly one-liner, e.g. "正在下载《XXX》 1080P HEVC" */
  summary: string;
  /** Raw terminal output lines that produced this entry */
  raw: string;
  bvid?: string;
  /** Whether this line should be shown in simple mode (default true). */
  simpleVisible?: boolean;
  /** Whether this line should be shown in debug mode (default false). */
  debugVisible?: boolean;
}

const MAX_LOG_ENTRIES = 500;
export const logsPath = path.join(dataDir, "logs.json");

export class LogManager extends EventEmitter {
  private entries: LogEntry[];
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly filePath: string;

  constructor(filePath = logsPath) {
    super();
    this.filePath = filePath;
    this.entries = this.sanitizeEntries(readJsonFile<LogEntry[]>(this.filePath, []));
  }

  push(entry: LogEntry) {
    const sanitizedEntry = this.sanitizeEntry(entry);
    this.entries.push(sanitizedEntry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    this.schedulePersist();
    this.emit("log", sanitizedEntry);
  }

  getAll(): LogEntry[] {
    return [...this.entries];
  }

  reload() {
    this.entries = this.sanitizeEntries(readJsonFile<LogEntry[]>(this.filePath, []));
    return this.getAll();
  }

  clear() {
    this.entries = [];
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // ignore log cleanup failure
    }
  }

  flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    writeJsonFile(this.filePath, this.entries);
  }

  close() {
    this.flush();
    this.removeAllListeners();
  }

  private schedulePersist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      writeJsonFile(this.filePath, this.entries);
    }, 300);
  }

  private sanitizeEntry(entry: LogEntry): LogEntry {
    return {
      ...entry,
      summary: sanitizeDiagnosticText(entry.summary, 1_000),
      raw: sanitizeDiagnosticText(entry.raw, 2_000),
    };
  }

  private sanitizeEntries(entries: LogEntry[]) {
    return Array.isArray(entries) ? entries.map((entry) => this.sanitizeEntry(entry)) : [];
  }
}

export const logManager = new LogManager();

function stripTimestampPrefix(line: string) {
  return line
    .replace(/^\[\d{4}-\d{2}-\d{2} [^\]]+\]\s*-\s*/, "")
    .trim();
}

/** Parse structured info from a chunk of BBDown stdout lines */
export function parseBBDownOutput(rawChunk: string, bvid: string): { entries: LogEntry[], unmatched: string[] } {
  const entries: LogEntry[] = [];
  const unmatched: string[] = [];
  const now = () => new Date().toISOString();
  const lines = rawChunk.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const normalized = stripTimestampPrefix(line);

    // Video title
    const titleMatch = normalized.match(/视频标题:\s*(.+)/);
    if (titleMatch) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `解析视频: 《${titleMatch[1]}》`, raw: line, bvid,
      });
      continue;
    }

    // Selected stream line: [视频] [1080P 高清] [1080x1920] [HEVC] ...
    const streamMatch = normalized.match(/\[视频\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]/);
    if (streamMatch) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `已选画质: ${streamMatch[1]} ${streamMatch[2]} ${streamMatch[3]}`,
        raw: line, bvid,
      });
      continue;
    }

    // Audio stream
    const audioMatch = normalized.match(/\[音频\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]/);
    if (audioMatch) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `已选音频: ${audioMatch[1]} ${audioMatch[2]}`, raw: line, bvid,
      });
      continue;
    }

    // Download start (only keep the video track in simple mode)
    if (normalized.includes("开始下载P")) {
      const pMatch = normalized.match(/开始下载(P\d+)(视频|音频)/);
      if (pMatch && pMatch[2] === "视频") {
        entries.push({
          timestamp: now(), type: "download", level: "info",
          summary: `正在下载 ${pMatch[1]}视频...`,
          raw: line, bvid,
        });
        continue;
      }
    }

    // BBDown may print "任务完成" before a later "解析此分P失败", so the
    // final success line is emitted only after downloader validation.
    if (normalized.includes("任务完成")) {
      continue;
    }

    if (normalized.includes("解析此分P失败")) {
      continue;
    }
    
    unmatched.push(line);
  }

  return { entries, unmatched };
}
