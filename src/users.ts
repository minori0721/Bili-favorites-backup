import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./paths.js";
import { readJsonFileDecoded, writeJsonFile } from "./storage.js";
import { isRecord } from "./shared/api/value.js";

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

/** Process-local authority; it is never serialized with credentials or archive identities. */
export interface AccountIdentity {
  readonly userId: string;
  readonly instance: symbol;
  readonly authorization: symbol;
  readonly selection: symbol;
}

export class AccountOperationCancelled extends Error {
  readonly code = 'ACCOUNT_OPERATION_CANCELLED';
  readonly statusCode = 409;
  constructor() { super('账号操作已失效，请使用当前账号重试'); this.name = 'AccountOperationCancelled'; }
}

export function decodeStoredUsers(value: unknown): BiliUser[] {
  if (!Array.isArray(value)) throw new Error("Stored users must be an array");
  const ids = new Set<string>();
  const uids = new Set<number>();
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim().length === 0
      || typeof item.uid !== "number" || !Number.isSafeInteger(item.uid) || item.uid <= 0
      || typeof item.name !== "string" || !isRecord(item.cookie)
      || !Array.isArray(item.favorites) || typeof item.enabled !== "boolean" || typeof item.lastLoginAt !== "string") {
      throw new Error(`Invalid stored user at index ${index}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate stored user id at index ${index}`);
    if (uids.has(item.uid)) throw new Error(`Duplicate stored user uid at index ${index}`);
    ids.add(item.id);
    uids.add(item.uid);
    if (typeof item.cookie.SESSDATA !== "string" || typeof item.cookie.bili_jct !== "string"
      || typeof item.cookie.DedeUserID !== "string") {
      throw new Error(`Invalid stored user cookie at index ${index}`);
    }
    const cookie: BiliCookie = { SESSDATA: "", bili_jct: "", DedeUserID: "" };
    for (const [key, credential] of Object.entries(item.cookie)) {
      if (typeof credential !== "string" && typeof credential !== "number" && credential !== undefined) {
        throw new Error(`Invalid stored user cookie at index ${index}`);
      }
      cookie[key] = credential;
    }
    const favorites = item.favorites.map((favorite, favoriteIndex) => {
      if (!isRecord(favorite) || typeof favorite.mediaId !== "number" || !Number.isSafeInteger(favorite.mediaId)
        || favorite.mediaId <= 0
        || typeof favorite.title !== "string") throw new Error(`Invalid stored favorite at ${index}:${favoriteIndex}`);
      return { mediaId: favorite.mediaId, title: favorite.title };
    });
    const optionalTextKeys = ["rawAuth", "accessToken", "refreshToken", "avatar", "lastAuthRefreshAt", "lastAuthRefreshError", "appBuvid"] as const;
    const optionalText = (key: typeof optionalTextKeys[number]) => item[key] === undefined || typeof item[key] === "string";
    if (!optionalTextKeys.every(optionalText)
      || (item.expires !== undefined && (typeof item.expires !== "number" || !Number.isFinite(item.expires) || item.expires < 0))
      || (item.authRefreshFailureAttempts !== undefined
        && (typeof item.authRefreshFailureAttempts !== "number"
          || !Number.isSafeInteger(item.authRefreshFailureAttempts) || item.authRefreshFailureAttempts < 0))
      || (item.authRefreshRetryAt !== undefined && typeof item.authRefreshRetryAt !== "string")
      || (item.authRefreshFailureCategory !== undefined && !["transient", "permanent", "unknown"].includes(String(item.authRefreshFailureCategory)))) {
      throw new Error(`Invalid stored user metadata at index ${index}`);
    }
    return {
      id: item.id, uid: item.uid, name: item.name, cookie, favorites,
      enabled: item.enabled, lastLoginAt: item.lastLoginAt,
      ...(typeof item.rawAuth === "string" ? { rawAuth: item.rawAuth } : {}),
      ...(typeof item.accessToken === "string" ? { accessToken: item.accessToken } : {}),
      ...(typeof item.refreshToken === "string" ? { refreshToken: item.refreshToken } : {}),
      ...(typeof item.expires === "number" ? { expires: item.expires } : {}),
      ...(typeof item.avatar === "string" ? { avatar: item.avatar } : {}),
      ...(typeof item.lastAuthRefreshAt === "string" ? { lastAuthRefreshAt: item.lastAuthRefreshAt } : {}),
      ...(typeof item.lastAuthRefreshError === "string" ? { lastAuthRefreshError: item.lastAuthRefreshError } : {}),
      ...(item.authRefreshFailureCategory === "transient" || item.authRefreshFailureCategory === "permanent" || item.authRefreshFailureCategory === "unknown"
        ? { authRefreshFailureCategory: item.authRefreshFailureCategory } : {}),
      ...(typeof item.authRefreshFailureAttempts === "number" ? { authRefreshFailureAttempts: item.authRefreshFailureAttempts } : {}),
      ...(typeof item.authRefreshRetryAt === "string" ? { authRefreshRetryAt: item.authRefreshRetryAt } : {}),
      ...(typeof item.appBuvid === "string" ? { appBuvid: item.appBuvid } : {}),
    };
  });
}

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
  private readonly filePath: string;
  private readonly write: (file: string, value: BiliUser[]) => void;
  private readonly read: () => BiliUser[];
  private readonly identities = new Map<string, AccountIdentity>();
  private readonly snapshots = new WeakMap<BiliUser, symbol>();
  private readonly removals = new Map<string, { done: Promise<void>; release(): void }>();

  constructor(options: { filePath?: string; read?: () => BiliUser[]; write?: (file: string, value: BiliUser[]) => void } = {}) {
    this.filePath = options.filePath ?? usersPath;
    this.write = options.write ?? ((file, value) => writeJsonFile(file, value, { flush: true }));
    this.read = options.read ?? (() => readJsonFileDecoded(this.filePath, defaultUsers, decodeStoredUsers));
    this.users = [];
    this.reload();
  }

  list() {
    return [...this.users];
  }

  reload() {
    const next = this.read();
    if (ensureUserAppBuvids(next)) this.write(this.filePath, next);
    this.users = next;
    this.identities.clear();
    for (const user of next) this.register(user, this.newIdentity(user.id));
    return this.list();
  }

  getById(id: string) {
    return this.users.find((user) => user.id === id) || null;
  }

  upsert(user: BiliUser) {
    this.assertWritable(user.id);
    const existingIndex = this.users.findIndex((item) => item.id === user.id);
    const next = [...this.users];
    const candidate = structuredClone(user);
    if (existingIndex >= 0) {
      const existing = this.users[existingIndex];
      next[existingIndex] = {
        ...existing,
        ...candidate,
        favorites: structuredClone(existing.favorites),
      };
      ensureUserAppBuvid(next[existingIndex]);
    } else {
      ensureUserAppBuvid(candidate);
      next.push(candidate);
    }
    this.write(this.filePath, next);
    this.users = next;
    const identity = this.identities.get(user.id) ?? this.newIdentity(user.id);
    this.register(next[existingIndex >= 0 ? existingIndex : next.length - 1], { ...identity, authorization: Symbol(),
      selection: Symbol(),
    });
  }

  updateFavorites(id: string, favorites: FavoriteFolder[]) {
    const user = this.getById(id);
    if (!user) {
      return null;
    }
    return this.updatePartial(id, { favorites });
  }

  updatePartial(id: string, patch: Partial<BiliUser>) {
    const user = this.getById(id);
    if (!user) {
      return null;
    }
    this.assertWritable(id);
    const candidate = { ...structuredClone(user), ...structuredClone(patch) };
    const next = this.users.map(item => item.id === id ? candidate : item);
    this.write(this.filePath, next);
    this.users = next;
    const identity = this.identities.get(id)!;
    const authorizationChanged = ['cookie', 'rawAuth', 'accessToken', 'refreshToken', 'expires', 'lastLoginAt']
      .some(key => Object.prototype.hasOwnProperty.call(patch, key));
    const selectionChanged = candidate.enabled !== user.enabled
      || candidate.favorites.map(folder => folder.mediaId).join(',') !== user.favorites.map(folder => folder.mediaId).join(',');
    this.register(candidate, { ...identity,
      authorization: authorizationChanged ? Symbol() : identity.authorization,
      selection: selectionChanged ? Symbol() : identity.selection,
    });
    return candidate;
  }

  remove(id: string) {
    const next = this.users.filter((user) => user.id !== id);
    this.write(this.filePath, next);
    this.users = next;
    this.identities.delete(id);
  }

  clear() {
    this.users = [];
    this.identities.clear();
  }

  captureAccount(id: string) {
    const user = this.getById(id);
    const identity = this.identities.get(id);
    if (!user || !identity || this.removals.has(id)) return null;
    const snapshot = structuredClone(user);
    this.snapshots.set(snapshot, identity.instance);
    return { user: snapshot, identity };
  }

  isAccountCurrent(identity: AccountIdentity) {
    return !this.removals.has(identity.userId) && this.identities.get(identity.userId)?.instance === identity.instance;
  }

  isAuthorizationCurrent(identity: AccountIdentity) {
    return this.isAccountCurrent(identity) && this.identities.get(identity.userId)?.authorization === identity.authorization;
  }

  isScanCurrent(identity: AccountIdentity, mediaId: number) {
    const user = this.getById(identity.userId);
    return this.isSelectionCurrent(identity)
      && Boolean(user?.enabled && user.favorites.some(folder => folder.mediaId === mediaId));
  }

  isSelectionCurrent(identity: AccountIdentity) {
    return this.isAccountCurrent(identity) && this.identities.get(identity.userId)?.selection === identity.selection;
  }

  getCurrentUser(snapshot: BiliUser) {
    const identity = this.identities.get(snapshot.id);
    if (!identity || this.removals.has(snapshot.id) || this.snapshots.get(snapshot) !== identity.instance) return null;
    return this.getById(snapshot.id);
  }

  async waitForAccountRemoval(id: string) {
    while (this.removals.has(id)) await this.removals.get(id)!.done;
  }

  beginAccountRemoval(id: string) {
    if (this.removals.has(id)) throw new AccountOperationCancelled();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const removal = { done, release };
    this.removals.set(id, removal);
    this.rotateInstance(id);
    return () => {
      if (this.removals.get(id) !== removal) return;
      this.removals.delete(id);
      this.rotateInstance(id);
      release();
    };
  }

  private assertWritable(id: string) {
    if (this.removals.has(id)) throw new AccountOperationCancelled();
  }

  private newIdentity(userId: string): AccountIdentity {
    return { userId, instance: Symbol(), authorization: Symbol(), selection: Symbol() };
  }

  private register(user: BiliUser, identity: AccountIdentity) {
    this.identities.set(user.id, identity);
    this.snapshots.set(user, identity.instance);
  }

  private rotateInstance(id: string) {
    const user = this.getById(id);
    if (!user) return;
    const next = structuredClone(user);
    this.users = this.users.map(item => item.id === id ? next : item);
    this.register(next, this.newIdentity(id));
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
