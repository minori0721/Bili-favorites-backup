import fs from "node:fs";
import path from "node:path";

export function readJsonFile<T>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
    return defaultValue;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // Keep the original file in place even if the backup copy fails.
    }
    throw new Error(`Failed to read JSON file ${filePath}; corrupt data was preserved at ${backupPath}: ${(error as Error).message}`);
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
