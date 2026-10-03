import fs from 'node:fs';
import path from 'node:path';
import type { LocalCleanupPlan, RemoteFileRecord } from '../state.js';
import { DOWNLOAD_SESSION_FILE, DOWNLOAD_RETAINED_FILE } from '../download-session.js';
import { isRecoveryProtected, RECOVERY_PROTECTION_FILE } from '../recovery-file-protection.js';
import { recoveryManifestStamp } from './recovery-replacement.js';

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

interface Dependencies {
  tempRoot: string;
  current(): boolean;
  proof(file: RemoteFileRecord): boolean;
  inspect(file: RemoteFileRecord): Promise<boolean>;
  unlink?(file: string): void;
}

/** Removes a fixed inventory after replacement commits; never recursively deletes its source directory. */
export async function cleanupRecoveryReplacement(plan: LocalCleanupPlan, deps: Dependencies) {
  if (plan.reason !== 'recovery_replaced' || !plan.replacementFiles?.length || !deps.current()) return null;
  if (!fs.existsSync(plan.localDir)) return [];
  const root = fs.realpathSync(deps.tempRoot), directory = fs.realpathSync(plan.localDir);
  if (fs.lstatSync(plan.localDir).isSymbolicLink() || !directory.startsWith(`${root}${path.sep}`)) return null;
  const controls = new Set([DOWNLOAD_SESSION_FILE, DOWNLOAD_RETAINED_FILE, RECOVERY_PROTECTION_FILE]);
  const onlyControlsRemain = () => {
    if (!fs.readdirSync(plan.localDir).every(name => controls.has(name))) return false;
    for (const file of plan.files) {
      try { fs.lstatSync(path.resolve(plan.localDir, file.relativePath)); return false; }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    return true;
  };
  const current = () => {
    if (!deps.current() || !plan.replacementFiles!.every(file => deps.proof(file))) return false;
    const stamp = recoveryManifestStamp(plan.localDir);
    if (isRecoveryProtected(plan.localDir) && stamp === plan.replacementManifestStamp) return true;
    // A previous authorized attempt may have removed some control files before
    // an IO failure. Resume only when no media or untracked files remain.
    return (stamp === 'missing' || stamp === plan.replacementManifestStamp) && onlyControlsRemain();
  };
  if (!current()) return null;
  for (const file of plan.replacementFiles) {
    if (!await deps.inspect(file)) throw Object.assign(new Error('Replacement remote proof is not visible'), { localCleanupRetryable: true });
    if (!current()) return null;
  }
  const remaining: string[] = [];
  for (const file of plan.files) {
    const target = path.resolve(plan.localDir, file.relativePath);
    if (!target.startsWith(`${path.resolve(plan.localDir)}${path.sep}`)) { remaining.push(file.relativePath); continue; }
    try {
      if (!fs.realpathSync(target).startsWith(`${directory}${path.sep}`)) { remaining.push(file.relativePath); continue; }
      const stat = fs.lstatSync(target), expected = file.expectedIdentity;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.expectedSize
        || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.mtimeMs !== expected.mtimeMs || stat.ctimeMs !== expected.ctimeMs
        || !current()) { remaining.push(file.relativePath); continue; }
      (deps.unlink || fs.unlinkSync)(target);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  if (remaining.length === 0 && current()) {
    const entries = fs.readdirSync(plan.localDir);
    // Historical, unknown, or uncovered pages keep their files and protection.
    if (entries.every(name => controls.has(name))) {
      for (const name of entries) (deps.unlink || fs.unlinkSync)(path.join(plan.localDir, name));
      fs.rmdirSync(plan.localDir);
    }
  }
  return remaining;
}
