import type { BiliUser } from "./users.js";

export type AccountRemovalMode = "account_only" | "account_and_remote";

export interface AccountRemovalRequest {
  mode?: unknown;
  previewId?: unknown;
  confirmation?: unknown;
}

interface AccountRemovalOperation {
  id: string;
  scope: string;
  userId: string;
  status?: string;
}

interface AccountRemovalArchiveGateway {
  get(id: string): AccountRemovalOperation | undefined;
  getAccountOperation(userId: string): AccountRemovalOperation | undefined;
  rememberAccount(user: BiliUser): void;
  markAccountRemoved(userId: string): void;
  restoreAccount(userId: string): boolean;
  beginAccountPreparation(id: string, confirmation: string): { operation: AccountRemovalOperation; claimed: boolean };
  validateAccountPreparation(id: string): unknown;
  completeAccountPreparation(id: string): AccountRemovalOperation;
  abortAccountPreparation(id: string, reason?: string): boolean;
}

interface AccountRemovalSchedulerGateway {
  retireUser(user: BiliUser): Promise<Record<string, unknown>>;
  quiesceUserRemoteDeletion(user: BiliUser): Promise<Record<string, unknown>>;
  finalizeUserRemoteDeletion(userId: string, commit: () => void): Record<string, unknown>;
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

const accountRemovalLocks = new Map<string, Promise<void>>();

function removalConflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

async function withAccountRemovalLock<T>(userId: string, action: () => Promise<T>) {
  const previous = accountRemovalLocks.get(userId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  accountRemovalLocks.set(userId, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (accountRemovalLocks.get(userId) === queued) accountRemovalLocks.delete(userId);
  }
}

function restoreAccountAfterFailure(
  dependencies: AccountRemovalDependencies,
  user: BiliUser,
  previewId?: string
) {
  let userAvailable = Boolean(dependencies.userStore.getById(user.id));
  if (!userAvailable) {
    try {
      dependencies.userStore.upsert(user);
      userAvailable = true;
    } catch (rollbackError) {
      dependencies.onRollbackError?.(rollbackError);
    }
  }
  if (!userAvailable) return false;
  try {
    if (previewId) dependencies.archiveDeletion.abortAccountPreparation(previewId);
    if (dependencies.archiveDeletion.restoreAccount(user.id)) {
      dependencies.scheduler.restoreUserAfterLogin(user.id);
    }
  } catch (rollbackError) {
    dependencies.onRollbackError?.(rollbackError);
  }
  return true;
}

export async function executeAccountRemoval(
  dependencies: AccountRemovalDependencies,
  userId: string,
  request: AccountRemovalRequest = {}
) {
  return withAccountRemovalLock(String(userId), async () => {
    const mode: AccountRemovalMode = request.mode === "account_and_remote" ? "account_and_remote" : "account_only";
    const previewId = String(request.previewId || "");
    const confirmation = String(request.confirmation || "");
    const user = dependencies.userStore.getById(String(userId));
    if (!user) {
      const operation = mode === "account_and_remote"
        ? dependencies.archiveDeletion.getAccountOperation(String(userId))
        : undefined;
      return { mode, retired: { alreadyRemoved: true }, operation };
    }

    if (mode === "account_only") {
      dependencies.archiveDeletion.rememberAccount(user);
      try {
        const retired = await dependencies.scheduler.retireUser(user);
        dependencies.archiveDeletion.markAccountRemoved(user.id);
        dependencies.userStore.remove(user.id);
        return { mode, retired, operation: undefined };
      } catch (error) {
        restoreAccountAfterFailure(dependencies, user);
        throw error;
      }
    }

    const preview = dependencies.archiveDeletion.get(previewId);
    if (!preview || preview.scope !== "account" || preview.userId !== user.id) {
      throw removalConflict("账号删除预览不存在或已失效，请重新预览");
    }
    const preparation = dependencies.archiveDeletion.beginAccountPreparation(previewId, confirmation);
    if (!preparation.claimed) {
      return { mode, retired: { alreadyRemoved: false, alreadyPreparing: true }, operation: preparation.operation };
    }

    let retired: Record<string, unknown> = {};
    try {
      const quiesced = await dependencies.scheduler.quiesceUserRemoteDeletion(user);
      dependencies.archiveDeletion.validateAccountPreparation(previewId);
      dependencies.archiveDeletion.rememberAccount(user);
      let operation: AccountRemovalOperation | undefined;
      const finalized = dependencies.scheduler.finalizeUserRemoteDeletion(user.id, () => {
        dependencies.userStore.remove(user.id);
        dependencies.archiveDeletion.markAccountRemoved(user.id);
        operation = dependencies.archiveDeletion.completeAccountPreparation(previewId);
      });
      retired = { ...quiesced, ...finalized };
      return { mode, retired, operation };
    } catch (error) {
      if (restoreAccountAfterFailure(dependencies, user, previewId)) throw error;
      try {
        dependencies.archiveDeletion.markAccountRemoved(user.id);
        const operation = dependencies.archiveDeletion.completeAccountPreparation(previewId);
        return { mode, retired: { ...retired, accountRestoreFailed: true }, operation };
      } catch (recoveryError) {
        dependencies.onRollbackError?.(recoveryError);
        throw error;
      }
    }
  });
}
