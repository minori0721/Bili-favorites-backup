import { BiliResponseFormatError, BiliRiskOrLoginError } from '../bili.js';
import { safeErrorCode, safeErrorSummary, sanitizeDiagnosticText } from '../diagnostics.js';
import type { StateManager } from '../state.js';
import type { BiliUser } from '../users.js';
import type { FavoriteScanPort } from './favorite-scan.js';

export interface SyncWorkflowDependencies {
  users(): BiliUser[];
  eligible(user: BiliUser): boolean;
  state: Pick<StateManager, 'getUserCooldown' | 'setUserCooldown'>;
  scan: FavoriteScanPort;
  progress(patch: { detail: string; userName?: string; folderTitle?: string; mediaId?: number; page?: number }): void;
  scanPosition(): { mediaId?: number; page?: number } | null;
  enterUser(id: string): void;
  leaveUser(id: string): void;
  random(): number;
  sleep(ms: number): Promise<void>;
}

/** Runtime owns admission and active-user accounting; this workflow owns scan policy. */
export function createSyncWorkflow(dependencies: SyncWorkflowDependencies) {
  async function run(manual: boolean, forceFullFavoriteScan: boolean) {
    const users = dependencies.users().filter((user) => dependencies.eligible(user));
    dependencies.progress({ detail: `正在检查 ${users.length} 个启用账号。` });
    for (const user of users) {
      dependencies.enterUser(user.id);
      try {
        const cooldown = dependencies.state.getUserCooldown(user.id);
        if (cooldown) {
          console.warn(`[Scheduler] User ${user.name} is cooling down until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`);
          continue;
        }

        for (const folder of user.favorites) {
          let phase = forceFullFavoriteScan ? 'full' : 'hot';
          try {
            dependencies.progress({
              userName: user.name,
              folderTitle: folder.title,
              mediaId: folder.mediaId,
              page: undefined,
              detail: forceFullFavoriteScan ? "准备全量扫描收藏夹。" : "准备同步收藏夹。",
            });
            if (forceFullFavoriteScan) {
              await dependencies.scan.all(user, folder.mediaId, folder.title);
            } else {
              const hotLastPage = await dependencies.scan.hot(user, folder.mediaId, folder.title, manual);
              phase = 'history';
              dependencies.progress({ detail: '正在补扫收藏夹历史页面。', page: undefined });
              await dependencies.scan.history(user, folder.mediaId, folder.title, manual, hotLastPage);
            }
          } catch (error) {
            const position = dependencies.scanPosition();
            const page = position?.mediaId === folder.mediaId ? position.page : undefined;
            const code = safeErrorCode(error);
            const category = error instanceof BiliRiskOrLoginError ? 'risk_or_login'
              : error instanceof BiliResponseFormatError ? 'response_format'
                : /^(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNREFUSED|ERR_NETWORK)$/.test(code) ? 'network' : 'other';
            const context = `user_id=${JSON.stringify(sanitizeDiagnosticText(user.id, 100))} media_id=${folder.mediaId} phase=${phase} page=${page ?? 'unknown'} category=${category} code=${code}`;
            if (error instanceof BiliRiskOrLoginError) {
              dependencies.state.setUserCooldown(user.id, error.message, (30 + Math.floor(dependencies.random() * 60)) * 60 * 1000);
              console.warn(`[Scheduler] Risk control; cooling down ${context}: ${safeErrorSummary(error)}`);
              break;
            }
            console.error(`[Scheduler] Failed to scan favorite ${context}: ${safeErrorSummary(error)}`);
          }

          const jitter = 2000 + Math.floor(dependencies.random() * 3000);
          await dependencies.sleep(jitter);
        }
      } finally {
        dependencies.leaveUser(user.id);
      }
    }
  }

  return { run };
}
