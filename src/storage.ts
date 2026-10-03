import fs from "node:fs";
import path from "node:path";

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
): T {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
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

export function writeJsonFile<T>(filePath: string, value: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
}

export async function clearDirectoryContents(directoryPath: string): Promise<void> {
  await fs.promises.mkdir(directoryPath, { recursive: true });
  const entries = await fs.promises.readdir(directoryPath);
  for (const entry of entries) {
    await fs.promises.rm(path.join(directoryPath, entry), { recursive: true, force: true });
  }
}
