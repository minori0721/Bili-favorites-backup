import fs from 'node:fs';
import path from 'node:path';

export const RECOVERY_PROTECTION_FILE = '.bfb-recovery-protected';

/** A durable hold, distinct from upload/cleanup proof. Explicit user deletion is unaffected. */
export function protectRecoveryDirectory(directory: string) {
  if (!directory) return;
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery directory is not a regular directory');
  const marker = path.join(directory, RECOVERY_PROTECTION_FILE);
  try { fs.writeFileSync(marker, 'Automatic cleanup blocked: unresolved recovery evidence\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }
}

export function isRecoveryProtected(directory: string) {
  try { fs.lstatSync(path.join(directory, RECOVERY_PROTECTION_FILE)); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
