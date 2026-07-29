import type { BiliUser } from "./users.js";

export type AccountRemovalMode = "account_only" | "account_and_remote";

export interface AccountRemovalRequest {
  mode?: unknown;
  previewId?: unknown;
  confirmation?: unknown;
}

interface AccountRemovalPreview {
  id: string;
  scope: string;
  userId: string;
}

interface AccountRemovalArchiveGateway {
  get(id: string): AccountRemovalPreview | undefined;
  rememberAccount(user: BiliUser): void;
  markAccountRemoved(userId: string): void;
  restoreAccount(userId: string): boolean;
  validateStart(id: string, confirmation: string): unknown;
  start(id: string, confirmation: string): unknown;
}

interface AccountRemovalSchedulerGateway {
  retireUser(user: BiliUser): Promise<Record<string, unknown>>;
  restoreUserAfterLogin(userId: string): unknown;
}

interface AccountRemovalUserGateway {
  getById(id: string): BiliUser | null;
  upsert(user: BiliUser): void;
  remove(id: string): void;
}

export interface AccountRemovalDependencies {
  archiveDeletion: AccountRemovalArchiveGateway;
  scheduler: AccountRemovalSchedulerGateway;
  userStore: AccountRemovalUserGateway;
  onRollbackError?: (error: unknown) => void;
}

function removalConflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export async function executeAccountRemoval(
  dependencies: AccountRemovalDependencies,
  user: BiliUser,
  request: AccountRemovalRequest = {}
) {
  const mode: AccountRemovalMode = request.mode === "account_and_remote" ? "account_and_remote" : "account_only";
  const previewId = String(request.previewId || "");
  const confirmation = String(request.confirmation || "");
  if (mode === "account_and_remote") {
    const preview = dependencies.archiveDeletion.get(previewId);
    if (!preview || preview.scope !== "account" || preview.userId !== user.id) {
      throw removalConflict("账号删除预览不存在或已失效，请重新预览");
    }
  }

  dependencies.archiveDeletion.rememberAccount(user);
  try {
    const retired = await dependencies.scheduler.retireUser(user);
    if (mode === "account_and_remote") dependencies.archiveDeletion.validateStart(previewId, confirmation);
    dependencies.archiveDeletion.markAccountRemoved(user.id);
    dependencies.userStore.remove(user.id);
    const operation = mode === "account_and_remote"
      ? dependencies.archiveDeletion.start(previewId, confirmation)
      : undefined;
    return { mode, retired, operation };
  } catch (error) {
    let userAvailable = Boolean(dependencies.userStore.getById(user.id));
    if (!userAvailable) {
      try {
        dependencies.userStore.upsert(user);
        userAvailable = true;
      } catch (rollbackError) {
        dependencies.onRollbackError?.(rollbackError);
        try {
          dependencies.archiveDeletion.markAccountRemoved(user.id);
        } catch (snapshotError) {
          dependencies.onRollbackError?.(snapshotError);
        }
      }
    }
    if (userAvailable) {
      try {
        if (dependencies.archiveDeletion.restoreAccount(user.id)) {
          dependencies.scheduler.restoreUserAfterLogin(user.id);
        }
      } catch (rollbackError) {
        dependencies.onRollbackError?.(rollbackError);
      }
    }
    throw error;
  }
}
