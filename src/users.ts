import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

export interface BiliCookie {
  SESSDATA: string;
  bili_jct: string;
  DedeUserID: string;
  [key: string]: string | number | undefined;
}

export interface FavoriteFolder {
  mediaId: number;
  title: string;
}

export interface BiliUser {
  id: string;
  uid: number;
  name: string;
  cookie: BiliCookie;
  favorites: FavoriteFolder[];
  enabled: boolean;
  lastLoginAt: string;
  /** Full TV login response (JSON string) — needed for token refresh */
  rawAuth?: string;
  /** OAuth2 access token for TV client API */
  accessToken?: string;
  /** OAuth2 refresh token for auto-renewal */
  refreshToken?: string;
  /** Timestamp (ms) when the cookie expires */
  expires?: number;
  /** User avatar URL returned by Bilibili */
  avatar?: string;
  /** Last successful TV auth refresh time */
  lastAuthRefreshAt?: string;
  /** Last TV auth refresh error, if any */
  lastAuthRefreshError?: string;
  /** Classification used to decide whether a refresh failure can be retried unattended. */
  authRefreshFailureCategory?: "transient" | "permanent" | "unknown";
  /** Number of consecutive refresh failures in the current failure streak. */
  authRefreshFailureAttempts?: number;
  /** Earliest time for the next unattended refresh attempt. */
  authRefreshRetryAt?: string;
  /** Stable non-secret device identity used by BBDown's APP playback API. */
  appBuvid?: string;
}

const usersPath = path.join(dataDir, "users.json");
const defaultUsers: BiliUser[] = [];
const appBuvidPattern = /^XY[0-9a-fA-F]{35}$/;
const nonCookieCredentialKeys = new Set(["accessToken", "refreshToken", "appBuvid"]);

export function generateAppBuvid(randomBytes: (size: number) => Buffer = crypto.randomBytes) {
  const digest = crypto.createHash("md5").update(randomBytes(16)).digest("hex");
  return `XY${digest[1]}${digest[11]}${digest[21]}${digest}`;
}

export function ensureUserAppBuvid(user: BiliUser) {
  if (appBuvidPattern.test(String(user.appBuvid || ""))) return false;
  user.appBuvid = generateAppBuvid();
  return true;
}

export function ensureUserAppBuvids(users: BiliUser[]) {
  let changed = false;
  for (const user of users) {
    if (ensureUserAppBuvid(user)) changed = true;
  }
  return changed;
}

export function downloadCredentialsForUser(user: BiliUser): BiliCookie {
  if (!appBuvidPattern.test(String(user.appBuvid || ""))) ensureUserAppBuvid(user);
  return {
    ...user.cookie,
    accessToken: user.accessToken || "",
    appBuvid: user.appBuvid || "",
  };
}

export function biliWebCookieValues(cookie: BiliCookie) {
  return Object.fromEntries(
    Object.entries(cookie).filter(([key, value]) => (
      !nonCookieCredentialKeys.has(key)
      && value !== undefined
      && value !== null
    ))
  ) as Record<string, string | number>;
}

export class UserStore {
  private users: BiliUser[];

  constructor() {
    this.users = readJsonFile<BiliUser[]>(usersPath, defaultUsers);
    if (ensureUserAppBuvids(this.users)) this.save();
  }

  list() {
    return [...this.users];
  }

  reload() {
    this.users = readJsonFile<BiliUser[]>(usersPath, defaultUsers);
    if (ensureUserAppBuvids(this.users)) this.save();
    return this.list();
  }

  getById(id: string) {
    return this.users.find((user) => user.id === id) || null;
  }

  upsert(user: BiliUser) {
    const existingIndex = this.users.findIndex((item) => item.id === user.id);
    if (existingIndex >= 0) {
      const existing = this.users[existingIndex];
      this.users[existingIndex] = {
        ...existing,
        ...user,
        favorites: existing.favorites,
      };
      ensureUserAppBuvid(this.users[existingIndex]);
    } else {
      ensureUserAppBuvid(user);
      this.users.push(user);
    }
    this.save();
  }

  updateFavorites(id: string, favorites: FavoriteFolder[]) {
    const user = this.getById(id);
    if (!user) {
      return null;
    }
    user.favorites = favorites;
    this.save();
    return user;
  }

  updatePartial(id: string, patch: Partial<BiliUser>) {
    const user = this.getById(id);
    if (!user) {
      return null;
    }
    Object.assign(user, patch);
    this.save();
    return user;
  }

  remove(id: string) {
    const next = this.users.filter((user) => user.id !== id);
    writeJsonFile(usersPath, next);
    this.users = next;
  }

  clear() {
    this.users = [];
  }

  private save() {
    writeJsonFile(usersPath, this.users);
  }
}

export function buildCookieString(cookie: BiliCookie) {
  const cookieValues = biliWebCookieValues(cookie);
  const preferred = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"];
  const seen = new Set<string>();
  const parts: string[] = [];
  const append = (key: string, value: unknown) => {
    if (seen.has(key) || value === undefined || value === null || value === "") {
      return;
    }
    seen.add(key);
    parts.push(`${key}=${value}`);
  };
  for (const key of preferred) {
    append(key, cookieValues[key]);
  }
  for (const [key, value] of Object.entries(cookieValues)) {
    append(key, value);
  }
  return parts.join("; ");
}
