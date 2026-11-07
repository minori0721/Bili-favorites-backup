import fs from 'node:fs';
import path from 'node:path';

/** Node cannot open directory handles for fsync on Windows. Linux deployments sync them explicitly. */
export function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Include new ancestor entries, up to the existing parent of mkdir's first created directory. */
export function syncCreatedDirectory(directory: string, firstCreated?: string) {
  const stop = firstCreated ? path.dirname(path.resolve(firstCreated)) : path.resolve(directory);
  let current = path.resolve(directory);
  while (true) {
    syncDirectory(current);
    if (current === stop) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Rare import/recovery path: persist staged data before recording a durable commit decision. */
export function syncPath(target: string) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('Cannot persist a symbolic link as recovery evidence');
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) syncPath(path.join(target, entry));
    syncDirectory(target);
  } else if (stat.isFile()) {
    const fd = fs.openSync(target, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } else throw new Error('Recovery evidence is not a regular file or directory');
}

/** Flush a completed media file without reading its contents a second time. */
export async function syncCompletedFile(file: string, root: string, expectedSize: number) {
  const realRoot = await fs.promises.realpath(root);
  const realFile = await fs.promises.realpath(file);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error('Completed media is outside its download directory');
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedSize) throw new Error('Completed media changed before disk sync');
  const handle = await fs.promises.open(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error('Completed media changed before disk sync');
    await handle.sync();
    if (!sameFile(before, await fs.promises.lstat(file))) throw new Error('Completed media changed during disk sync');
  } finally { await handle.close(); }
  // A nested media directory may itself have just been created by BBDown.
  const stop = path.dirname(path.resolve(root));
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    if (process.platform !== 'win32') {
      const handle = await fs.promises.open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    if (directory === stop) break;
    if (path.dirname(directory) === directory) throw new Error('Completed media is outside its download directory');
  }
}

function sameFile(a: fs.Stats, b: fs.Stats) {
  return b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
