import fs from 'node:fs';
import path from 'node:path';
import { syncDirectory } from './durability.js';

export const RECOVERY_PROTECTION_FILE = '.bfb-recovery-protected';

function openMarker(marker: string) {
  try { return {fd: fs.openSync(marker, 'wx', 0o600), created: true}; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return {fd: fs.openSync(marker, 'r+'), created: false};
    }
    throw error;
  }
}

/** A durable hold, distinct from upload/cleanup proof. Explicit user deletion is unaffected. */
export function protectRecoveryDirectory(directory: string) {
  if (!directory) return;
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery directory is not a regular directory');
  const marker = path.join(directory, RECOVERY_PROTECTION_FILE);
  const {fd, created} = openMarker(marker);
  try {
    if (created) fs.writeFileSync(fd, 'Automatic cleanup blocked: unresolved recovery evidence\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(directory);
}

export function isRecoveryProtected(directory: string) {
  try { fs.lstatSync(path.join(directory, RECOVERY_PROTECTION_FILE)); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
