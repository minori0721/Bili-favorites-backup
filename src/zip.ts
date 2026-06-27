import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosDate, dosTime };
}

async function listFiles(root: string) {
  const files: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function writeLocalHeader(fileName: Buffer, method: number, crc: number, compressedSize: number, uncompressedSize: number, date = new Date()) {
  const { dosDate, dosTime } = dosDateTime(date);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function writeCentralHeader(
  fileName: Buffer,
  method: number,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
  date = new Date()
) {
  const { dosDate, dosTime } = dosDateTime(date);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(fileName.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

function writeEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

export async function createZipFromDirectory(root: string, outputPath: string) {
  const chunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  const files = await listFiles(root);

  for (const fullPath of files) {
    const relativeName = path.relative(root, fullPath).replace(/\\/g, "/");
    const fileName = Buffer.from(relativeName, "utf8");
    const raw = await fs.promises.readFile(fullPath);
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const localHeader = writeLocalHeader(fileName, 8, crc, compressed.length, raw.length);
    chunks.push(localHeader, fileName, compressed);
    centralChunks.push(writeCentralHeader(fileName, 8, crc, compressed.length, raw.length, offset), fileName);
    offset += localHeader.length + fileName.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = writeEndOfCentralDirectory(files.length, centralSize, centralOffset);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, Buffer.concat([...chunks, ...centralChunks, eocd]));
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("zip 文件缺少中央目录");
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

export async function extractZipBuffer(buffer: Buffer, outputDir: string) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  let ptr = centralOffset;
  await fs.promises.mkdir(outputDir, { recursive: true });

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("zip 中央目录损坏");
    }
    const flags = buffer.readUInt16LE(ptr + 8);
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const fileNameLength = buffer.readUInt16LE(ptr + 28);
    const extraLength = buffer.readUInt16LE(ptr + 30);
    const commentLength = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const rawName = buffer.subarray(ptr + 46, ptr + 46 + fileNameLength);
    const name = safeZipPath(rawName.toString((flags & 0x0800) ? "utf8" : "utf8"));
    ptr += 46 + fileNameLength + extraLength + commentLength;
    if (!name || name.endsWith("/")) {
      continue;
    }
    if ((flags & 1) !== 0) {
      throw new Error("不支持加密 zip");
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("zip 本地文件头损坏");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else if (method === 8) {
      content = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`不支持的 zip 压缩方式：${method}`);
    }
    const target = path.join(outputDir, name);
    const resolved = path.resolve(target);
    const root = path.resolve(outputDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error("zip 包含不安全路径");
    }
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content);
  }
}
