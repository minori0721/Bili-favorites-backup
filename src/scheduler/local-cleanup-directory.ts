import fs from 'node:fs';
import path from 'node:path';

export interface CleanupRootIdentity {
  realPath: string;
  dev: number;
  ino: number;
}

export type CleanupDirectoryInspection =
  | { kind: 'present'; realPath: string; root: CleanupRootIdentity }
  | { kind: 'missing'; root: CleanupRootIdentity }
  | { kind: 'unsafe' };

export function sameCleanupRoot(left: CleanupRootIdentity, right: CleanupRootIdentity) {
  return left.realPath === right.realPath && left.dev === right.dev && left.ino === right.ino;
}

/** A missing child is conclusive only while its configured root is available and unchanged. */
export function inspectLocalCleanupDirectory(tempRoot: string, localDir: string): CleanupDirectoryInspection {
  const relative = path.relative(path.resolve(tempRoot), path.resolve(localDir));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: 'unsafe' };
  }
  function readRoot(): CleanupRootIdentity {
    const realPath = fs.realpathSync(tempRoot);
    const stat = fs.lstatSync(realPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Local cleanup root is not a directory');
    return { realPath, dev: stat.dev, ino: stat.ino };
  }
  const root = readRoot();
  function finish(result: CleanupDirectoryInspection) {
    if (!sameCleanupRoot(root, readRoot())) throw new Error('Local cleanup root changed during inspection');
    return result;
  }
  let current = root.realPath;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return finish({ kind: 'missing', root });
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return finish({ kind: 'unsafe' });
  }
  return finish({ kind: 'present', realPath: current, root });
}
