import { BiliRiskOrLoginError } from '../bili.js';
import { safeErrorSummary } from '../diagnostics.js';
import type { StateManager } from '../state.js';
import type { BiliUser } from '../users.js';
import type { FavoriteScanPort } from './favorite-scan.js';

export interface SyncWorkflowDependencies {
  users(): BiliUser[];
  eligible(user: BiliUser): boolean;
  state: Pick<StateManager, 'getUserCooldown' | 'setUserCooldown'>;
  scan: FavoriteScanPort;
  progress(patch: { detail: string; userName?: string; folderTitle?: string; mediaId?: number }): void;
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
          try {
            dependencies.progress({
              userName: user.name,
              folderTitle: folder.title,
              mediaId: folder.mediaId,
              detail: forceFullFavoriteScan ? "准备全量扫描收藏夹。" : "准备同步收藏夹。",
            });
            if (forceFullFavoriteScan) {
              await dependencies.scan.all(user, folder.mediaId, folder.title);
            } else {
              const hotLastPage = await dependencies.scan.hot(user, folder.mediaId, folder.title, manual);
              await dependencies.scan.history(user, folder.mediaId, folder.title, manual, hotLastPage);
            }
          } catch (error) {
            if (error instanceof BiliRiskOrLoginError) {
              dependencies.state.setUserCooldown(user.id, error.message, (30 + Math.floor(dependencies.random() * 60)) * 60 * 1000);
              console.warn(`[Scheduler] Risk control for user ${user.name}; cooling down.`);
              break;
            }
            console.error(`[Scheduler] Failed to scan favorite: ${safeErrorSummary(error)}`);
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
