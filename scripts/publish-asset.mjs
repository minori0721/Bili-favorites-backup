import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Readers see either the previous complete file or the new complete file. */
export async function publishAsset(file, contents) {
  const bytes = Buffer.from(contents);
  try {
    if ((await fs.readFile(file)).equals(bytes)) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pending = `${file}.${randomUUID()}.pending`;
  try {
    await fs.writeFile(pending, bytes, { flag: 'wx' });
    await fs.rename(pending, file);
  } finally {
    await fs.rm(pending, { force: true });
  }
}
