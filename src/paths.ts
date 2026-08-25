import path from "node:path";
import fs from "node:fs";

const isolatedTestRoot = process.env.NODE_ENV === "test" ? process.env.BFB_TEST_APP_ROOT : "";
export const appRoot = isolatedTestRoot ? path.resolve(isolatedTestRoot) : process.cwd();
export const dataDir = path.join(appRoot, "data");
export const databasePath = path.join(dataDir, "bfb.sqlite");
export const authSessionDatabasePath = path.join(dataDir, "auth-sessions.sqlite");
export const tempDir = path.join(appRoot, "temp");
export const coversDir = path.join(dataDir, "covers");
export const onlineCoversDir = path.join(dataDir, "online-covers");
export const exportsDir = path.join(dataDir, "exports");
export const backupsDir = path.join(dataDir, "backups");

export function ensureAppDirs() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  if (!fs.existsSync(coversDir)) {
    fs.mkdirSync(coversDir, { recursive: true });
  }
  if (!fs.existsSync(onlineCoversDir)) {
    fs.mkdirSync(onlineCoversDir, { recursive: true });
  }
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
}
