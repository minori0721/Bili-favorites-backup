import fs from 'node:fs';
import type { AppInfo } from './app-info.js';
import { buildChannel, isObject, releaseNotes, repositoryUrl } from './update-release.js';
import type { ReleaseNotes } from './shared/api/updates.js';

export function readCurrentRelease(current: AppInfo, file: URL | string = new URL('../dist/build-release.json', import.meta.url)): ReleaseNotes | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    console.warn('[Update] Cannot read embedded release notes');
    return null;
  }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { console.warn('[Update] Invalid embedded release notes JSON'); return null; }
  if (!isObject(data) || data.version !== current.version || data.revision !== current.revision
    || typeof data.notes !== 'string') {
    console.warn('[Update] Embedded release notes do not match the running build');
    return null;
  }
  const channel = buildChannel(current) === 'stable' ? 'stable' : 'dev';
  const notes = releaseNotes(channel, 'v' + current.version, current.revision, '', data.notes);
  // A rolling GitHub page cannot link to an old development build. Keep its external link immutable too.
  if (channel === 'dev') notes.url = current.revision ? `${repositoryUrl}/commit/${current.revision}` : repositoryUrl;
  return notes;
}
