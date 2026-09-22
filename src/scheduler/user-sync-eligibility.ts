import type { StateDatabase } from '../database.js';
import type { BiliUser } from '../users.js';

export interface UserSyncEligibilityPort {
  hasUnfinishedArchiveAccountDeletion(userId: string): boolean;
}

/** Owns account admission using only the deletion query required by the rule. */
export function createUserSyncEligibility(
  dependencies: Pick<StateDatabase, 'hasUnfinishedArchiveAccountDeletion'>,
) {
  return (user: BiliUser | null | undefined): user is BiliUser => Boolean(
    user?.enabled && !dependencies.hasUnfinishedArchiveAccountDeletion(user.id),
  );
}
