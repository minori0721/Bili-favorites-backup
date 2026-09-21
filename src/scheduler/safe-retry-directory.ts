import fs from 'node:fs';
import path from 'node:path';

/**
 * A retry directory may only be created below the configured legacy temp
 * root. Existing symlinks and unreadable paths are never treated as safe.
 */
export function isSafeEncodingRetryDirectory(rootValue: string, value: string, expectedPrefix?: string): boolean {
  const root = path.resolve(rootValue);
  const candidate = path.resolve(String(value || ''));
  if (!candidate || candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return false;
  if (expectedPrefix && !path.basename(candidate).startsWith(expectedPrefix)) return false;
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return false;
  } catch (error) {
    // Only a missing candidate is safe to create; unreadable paths are not
    // evidence of absence and must propagate to the recovery boundary.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return true;
}
