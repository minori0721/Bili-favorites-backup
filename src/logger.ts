import { EventEmitter } from "node:events";

export interface LogEntry {
  timestamp: string;
  type: "download" | "upload" | "system";
  level: "info" | "warn" | "error";
  /** Human-friendly one-liner, e.g. "正在下载《XXX》 1080P HEVC" */
  summary: string;
  /** Raw terminal output lines that produced this entry */
  raw: string;
  bvid?: string;
}

const MAX_LOG_ENTRIES = 500;

class LogManager extends EventEmitter {
  private entries: LogEntry[] = [];

  push(entry: LogEntry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    this.emit("log", entry);
  }

  getAll(): LogEntry[] {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}

export const logManager = new LogManager();

/** Parse structured info from a chunk of BBDown stdout lines */
export function parseBBDownOutput(rawChunk: string, bvid: string): { entries: LogEntry[], unmatched: string[] } {
  const entries: LogEntry[] = [];
  const unmatched: string[] = [];
  const now = () => new Date().toISOString();
  const lines = rawChunk.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Video title
    const titleMatch = line.match(/视频标题:\s*(.+)/);
    if (titleMatch) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `解析视频: 《${titleMatch[1]}》`, raw: line, bvid,
      });
      continue;
    }

    // Selected stream line: [视频] [1080P 高清] [1080x1920] [HEVC] ...
    const streamMatch = line.match(/\[视频\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]/);
    if (streamMatch) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `已选画质: ${streamMatch[1]} ${streamMatch[2]} ${streamMatch[3]}`,
        raw: line, bvid,
      });
      continue;
    }

    // Audio stream
    const audioMatch = line.match(/\[音频\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]/);
    if (audioMatch) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `已选音频: ${audioMatch[1]} ${audioMatch[2]}`, raw: line, bvid,
      });
      continue;
    }

    // Download start
    if (line.includes("开始下载P")) {
      const pMatch = line.match(/开始下载(P\d+)(视频|音频)/);
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `正在下载 ${pMatch ? pMatch[1] + pMatch[2] : "分片"}...`,
        raw: line, bvid,
      });
      continue;
    }

    // Merge
    if (line.includes("开始合并音视频")) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: "正在合并音视频...", raw: line, bvid,
      });
      continue;
    }

    // Task done
    if (line.includes("任务完成")) {
      entries.push({
        timestamp: now(), type: "download", level: "info",
        summary: `下载完成 ${bvid}`, raw: line, bvid,
      });
      continue;
    }
    
    unmatched.push(line);
  }

  return { entries, unmatched };
}
