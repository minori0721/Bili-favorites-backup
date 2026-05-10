import path from "node:path";
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
}

const usersPath = path.join(dataDir, "users.json");
const defaultUsers: BiliUser[] = [];

export class UserStore {
  private users: BiliUser[];

  constructor() {
    this.users = readJsonFile<BiliUser[]>(usersPath, defaultUsers);
  }

  list() {
    return [...this.users];
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
    } else {
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
    this.users = this.users.filter((user) => user.id !== id);
    this.save();
  }

  private save() {
    writeJsonFile(usersPath, this.users);
  }
}

export function buildCookieString(cookie: BiliCookie) {
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
    append(key, cookie[key]);
  }
  for (const [key, value] of Object.entries(cookie)) {
    if (key === "accessToken" || key === "refreshToken") {
      continue;
    }
    append(key, value);
  }
  return parts.join("; ");
}
