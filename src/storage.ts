import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncCreatedDirectory } from './durability.js';

/** Rename succeeded, but stable storage could not be confirmed. The visible value is already new. */
export class JsonFileDurabilityError extends Error {
  readonly committed = true;
  constructor(cause: unknown) {
    super('文件已替换，但目录落盘失败；请检查磁盘后重试');
    Object.assign(this, { cause });
    this.name = 'JsonFileDurabilityError';
  }
}

export class JsonFileDecodeError extends Error {
  constructor(filePath: string, readonly preservedAt: string | null, cause: unknown) {
    const detail = cause instanceof SyntaxError ? "invalid JSON" : cause instanceof Error ? cause.message : "invalid persisted data";
    super(`Failed to decode JSON file ${filePath}; ${preservedAt ? `original preserved at ${preservedAt}` : "original could not be backed up"}: ${detail}`);
    this.name = "JsonFileDecodeError";
  }
}

/** Read persisted JSON through an explicit boundary decoder. */
export function readJsonFileDecoded<T>(
  filePath: string,
  defaultValue: T,
  decode: (value: unknown) => T,
  options: { flush?: boolean } = {},
): T {
  if (!fs.existsSync(filePath)) {
    writeJsonFile(filePath, defaultValue, options);
    return defaultValue;
  }
  const contents = fs.readFileSync(filePath, "utf-8");
  try {
    return decode(JSON.parse(contents) as unknown);
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let preservedAt: string | null = null;
    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      preservedAt = backupPath;
    } catch (backupError) {
      console.warn(`[Storage] corrupt JSON backup could not be created for ${filePath}`, backupError);
    }
    throw new JsonFileDecodeError(filePath, preservedAt, error);
  }
}

export function writeJsonFile<T>(filePath: string, value: T, options: { flush?: boolean } = {}): void {
  const contents = JSON.stringify(value, null, 2);
  const directory = path.dirname(filePath);
  const firstCreated = fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    const existingMode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : undefined;
    const mode = existingMode ?? 0o600;
    descriptor = fs.openSync(tempPath, 'wx', mode);
    created = true;
    // open() applies umask; restore the existing permissions before committing.
    if (existingMode !== undefined) fs.fchmodSync(descriptor, existingMode);
    fs.writeFileSync(descriptor, contents, 'utf-8');
    if (options.flush) fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // The visible value changes at rename; a later sync failure must not be reported as a rollback.
    fs.renameSync(tempPath, filePath);
    created = false;
    if (options.flush) {
      try { syncCreatedDirectory(directory, firstCreated); }
      catch (error) { throw new JsonFileDurabilityError(error); }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); }
      catch (cleanupError) { console.warn('[Storage] Failed to close temporary JSON file', cleanupError); }
    }
    if (created) {
      try { fs.rmSync(tempPath, { force: true }); }
      catch (cleanupError) { console.warn('[Storage] Failed to remove temporary JSON file', cleanupError); }
    }
    throw error;
  }
}

export async function clearDirectoryContents(directoryPath: string): Promise<void> {
  await fs.promises.mkdir(directoryPath, { recursive: true });
  const entries = await fs.promises.readdir(directoryPath);
  for (const entry of entries) {
    await fs.promises.rm(path.join(directoryPath, entry), { recursive: true, force: true });
  }
}
