import type { UserStore } from './users.js';
import type { StateManager } from './state.js';
import { parseUnavailableCursor, encodeUnavailableCursor } from './unavailable-cursor.js';
export function createUnavailableService(deps: {users: Pick<UserStore, 'getById'>; state: Pick<StateManager, 'listUnavailableForUser'>}) {
  return {list(userId: string, input: {filter?: unknown; cursor?: unknown; pageSize: number}) {
    const user = deps.users.getById(userId);
    if (!user) return {status: 404, body: {success: false, message: 'User not found'}};
    const filter = input.filter === 'missing' || input.filter === 'uploaded' ? input.filter : 'all';
    const cursor = parseUnavailableCursor(input.cursor, filter);
    if (!cursor.ok) return {status: 400, body: {success: false, message: cursor.message}};
    const page = deps.state.listUnavailableForUser(user.id, {filter, cursor: cursor.cursor, legacyOffset: cursor.legacyOffset}, input.pageSize);
    return {status: 200, body: {success: true, data: {items: page.items, hasMore: page.hasMore,
      nextCursor: page.hasMore && page.nextCursor ? encodeUnavailableCursor(page.nextCursor, filter) : null}}};
  }};
}
