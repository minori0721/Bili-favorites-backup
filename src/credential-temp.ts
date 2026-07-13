import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BBDownCredentialTempPrefix = "bfb-credentials-";
export const legacyBBDownCredentialTempPrefix = "bbdown-credentials-";

export function isBBDownCredentialDirectoryName(value: string) {
  return value.startsWith(BBDownCredentialTempPrefix) || value.startsWith(legacyBBDownCredentialTempPrefix);
}

export function isBBDownCredentialArchivePath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[0] === "temp" && parts.length >= 2 && isBBDownCredentialDirectoryName(parts[1]);
}

export async function createBBDownCredentialDirectory(root = os.tmpdir()) {
  await fs.promises.mkdir(root, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(root, BBDownCredentialTempPrefix));
  await fs.promises.chmod(directory, 0o700);
  return directory;
}

export async function cleanupStaleBBDownCredentialDirectories(root = os.tmpdir()) {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isBBDownCredentialDirectoryName(entry.name)) continue;
    await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
