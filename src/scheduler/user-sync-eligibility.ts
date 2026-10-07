import type { BiliUser } from '../users.js';

export interface UserSyncEligibilityPort {
  hasUnfinishedArchiveAccountDeletion(userId: string): boolean;
  currentUser(user: BiliUser): BiliUser | null;
}

/** Owns account admission using only the deletion query required by the rule. */
export function createUserSyncEligibility(
  dependencies: UserSyncEligibilityPort,
) {
  return (user: BiliUser | null | undefined): user is BiliUser => {
    const current = user && dependencies.currentUser(user);
    return Boolean(current?.enabled && !dependencies.hasUnfinishedArchiveAccountDeletion(current.id));
  };
}
