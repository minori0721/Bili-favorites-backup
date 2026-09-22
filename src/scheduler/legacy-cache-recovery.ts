import fs from 'node:fs';
import path from 'node:path';
import type { BiliUser } from '../users.js';
import type { StateManager } from '../state.js';
import { LEGACY_TEMP_CACHE_MARKER } from '../database.js';
import { DOWNLOAD_RETAINED_FILE, readDownloadSessionAsync } from '../download-session.js';
import { logManager } from '../logger.js';
import { safeErrorSummary } from '../diagnostics.js';
interface Dependencies {
  stateManager: Pick<StateManager, 'markDownloadInterrupted'>;
  legacyTempDir: string;
  canRun(): boolean;
  generation(): number;
  getMeta(key: string): string | null | undefined;
  setMeta(key: string, value: string): void;
  findBestRelationForBvid(bvid: string): { user: BiliUser; mediaId: number; folderTitle: string } | null;
  enqueueIfNeeded(user: BiliUser, mediaId: number, title: string, bvid: string, options: { persisted: boolean }): boolean;
  wake(): void;
}
function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
export function createLegacyCacheRecovery(deps: Dependencies) {
  let pending: Promise<void> | null = null;
  async function recover() {
    const epoch = deps.generation();
    const canContinue = () => deps.canRun() && epoch === deps.generation();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(deps.legacyTempDir, { withFileTypes: true });
    } catch (error) {
      // boundary-critical: ENOENT is the explicitly supported absence of a legacy cache; every other filesystem error is rethrown.
      if (errorCode(error) === "ENOENT") entries = [];
      else throw error;
    }
    let recovered = 0;
    let unresolved = 0;
    for (const entry of entries) {
      if (!canContinue()) return;
      if (entry.isSymbolicLink() || !entry.isDirectory() || !/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;
      const localDir = path.join(deps.legacyTempDir, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(localDir);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      try {
        const retained = await fs.promises.lstat(path.join(localDir, DOWNLOAD_RETAINED_FILE));
        if (retained.isFile() && !retained.isSymbolicLink()) continue;
      } catch (error) {
        // boundary-critical: A missing retention marker permits inspection; all non-ENOENT failures propagate.
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const session = await readDownloadSessionAsync(localDir);
      if (session.kind === 'valid') continue;
      const corruptManifest = session.kind === 'invalid';
      if (session.kind === 'invalid') {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: 'system',
          level: 'warn',
          summary: `旧缓存下载清单损坏，已保留待重新探测：${entry.name}`,
          raw: `[Recovery] corrupt legacy download manifest retained bvid=${entry.name} reason=${session.reason}${session.field ? ` field=${session.field}` : ''}`,
          bvid: entry.name,
          simpleVisible: true,
          debugVisible: true,
        });
      }
      if (!canContinue()) return;
      const resolved = deps.findBestRelationForBvid(entry.name);
      if (!resolved) {
        unresolved += 1;
        continue;
      }
      deps.stateManager.markDownloadInterrupted(
        entry.name,
        localDir,
        corruptManifest
          ? "Corrupt download manifest queued for safe re-probe."
          : "Legacy local cache queued for safe recovery.",
        [{ userId: resolved.user.id, mediaId: resolved.mediaId }]
      );
      deps.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.name, { persisted: true });
      recovered += 1;
    }
    if (!canContinue()) return;
    deps.setMeta(LEGACY_TEMP_CACHE_MARKER, "complete");
    if (recovered > 0 || unresolved > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: unresolved > 0 ? "warn" : "info",
        summary: unresolved > 0
          ? `旧缓存已恢复 ${recovered} 项，另有 ${unresolved} 项保留待识别`
          : `已恢复 ${recovered} 项旧缓存`,
        raw: `[Recovery] legacy local cache recovered=${recovered} unresolved=${unresolved}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }

  function start() {
    if (pending || deps.getMeta(LEGACY_TEMP_CACHE_MARKER) === 'complete' || !deps.canRun()) return;
    pending = recover().catch(error => {
      console.warn(`[Recovery] Failed to inspect legacy local cache: ${safeErrorSummary(error)}`);
    }).finally(() => {
      pending = null;
      if (deps.canRun()) deps.wake();
    });
  }
  return { start, whenIdle: () => pending || Promise.resolve(), get busy() { return pending !== null; } };
}
