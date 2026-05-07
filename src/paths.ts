import path from "node:path";
import fs from "node:fs";

export const appRoot = process.cwd();
export const dataDir = path.join(appRoot, "data");
export const tempDir = path.join(appRoot, "temp");

export function ensureAppDirs() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
}
