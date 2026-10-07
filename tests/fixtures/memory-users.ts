import { UserStore, type BiliUser } from '../../src/users.js';

/** Real account authority with isolated persistence; keep it separate from filesystem-only test helpers. */
export function memoryUsers(initial: BiliUser[]) {
  let saved = structuredClone(initial);
  let firstRead = true;
  return new UserStore({read: () => {
    if (firstRead) {firstRead = false; return initial;}
    return structuredClone(saved);
  }, write: (_file, users) => {saved = structuredClone(users);}});
}
