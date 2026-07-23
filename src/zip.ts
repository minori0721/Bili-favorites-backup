import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}
export async function createZipFromDirectory(root: string, outputPath: string) {
  return createZipFromSources([{ root, prefix: false }], outputPath);
}

function updateCrc32(crc: number, buffer: Buffer) {
  let next = crc;
  for (const byte of buffer) next = crcTable[(next ^ byte) & 0xff] ^ (next >>> 8);
  return next;
}

export interface ZipSource {
  root: string;
  prefix: string | false;
  files?: string[];
}

export async function createZipFromSources(sources: ZipSource[], outputPath: string) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 6 }, forceZip64: true });
    output.once("close", () => resolve());
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    for (const source of sources) {
      if (!source.files) {
        archive.directory(source.root, source.prefix);
        continue;
      }
      for (const relative of source.files) {
        const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
        const name = source.prefix ? path.posix.join(source.prefix, normalized) : normalized;
        archive.file(path.join(source.root, relative), { name });
      }
    }
    void archive.finalize();
  });
}

export interface ZipSafetyLimits {
  maxEntries: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
}

export const defaultZipSafetyLimits: ZipSafetyLimits = {
  maxEntries: Number(process.env.MIGRATION_MAX_ENTRIES || 100_000),
  maxExpandedBytes: Number(process.env.MIGRATION_MAX_EXPANDED_GB || 120) * 1024 ** 3,
  maxCompressionRatio: Number(process.env.MIGRATION_MAX_COMPRESSION_RATIO || 100),
};

export async function extractZipFile(archivePath: string, outputDir: string, limits: ZipSafetyLimits = defaultZipSafetyLimits) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  return await new Promise<{ files: string[]; expandedBytes: number; sha256: Record<string, string> }>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError || new Error("无法打开zip文件"));
      const files: string[] = [];
      const hashes: Record<string, string> = {};
      let expandedBytes = 0;
      let entryCount = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch {}
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ files, expandedBytes, sha256: hashes });
      });
      zip.on("entry", (entry) => {
        entryCount += 1;
        if (entryCount > limits.maxEntries) return fail(new Error(`zip文件数量超过限制 ${limits.maxEntries}`));
        const name = safeZipPath(entry.fileName);
        if (!name) return fail(new Error("zip包含不安全路径"));
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : entry.uncompressedSize;
        if (ratio > limits.maxCompressionRatio) return fail(new Error(`zip条目压缩比超过限制: ${name}`));
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > limits.maxExpandedBytes) return fail(new Error("zip展开大小超过限制"));
        const target = path.resolve(outputDir, name);
        const root = path.resolve(outputDir);
        if (!target.startsWith(root + path.sep)) return fail(new Error("zip包含不安全路径"));
        zip.openReadStream(entry, async (streamError, stream) => {
          if (streamError || !stream) return fail(streamError || new Error("无法读取zip条目"));
          try {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const hash = crypto.createHash("sha256");
            let crc = 0xffffffff;
            const output = fs.createWriteStream(target, { flags: "wx" });
            stream.on("data", (chunk: Buffer) => {
              hash.update(chunk);
              crc = updateCrc32(crc, chunk);
            });
            await new Promise<void>((done, failed) => {
              stream.once("error", failed);
              output.once("error", failed);
              output.once("finish", done);
              stream.pipe(output);
            });
            files.push(name);
            if (((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) throw new Error(`zip条目CRC校验失败: ${name}`);
            hashes[name] = hash.digest("hex");
            zip.readEntry();
          } catch (error) {
            fail(error);
          }
        });
      });
      zip.readEntry();
    });
  });
}

function safeZipPath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.includes(":")) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    return "";
  }
  return parts.join("/");
}
