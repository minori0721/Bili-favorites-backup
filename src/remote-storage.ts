import crypto from "node:crypto";
import { createClient, type WebDAVClient } from "webdav";
import type { AppConfig } from "./config.js";
import { buildStorageDavUrl } from "./storage-url.js";

export type RemoteCapability = "supported" | "unsupported" | "unknown";

export type RemoteCapabilityKey =
  | "copy"
  | "move"
  | "directoryList"
  | "extendedUploadHeaders";

export interface RemoteBackendProfile {
  readonly identity: string;
  readonly createdAt: number;
  lastUsedAt: number;
  capabilities: Record<RemoteCapabilityKey, RemoteCapability>;
}

const PROFILE_TTL_MS = 30 * 60_000;
const MAX_PROFILES = 32;
const profiles = new Map<string, RemoteBackendProfile>();

function normalizedConfigIdentity(config: AppConfig) {
  return JSON.stringify({
    alistUrl: String(config.alistUrl || "").trim(),
    alistUsername: String(config.alistUsername || ""),
    alistPassword: String(config.alistPassword || ""),
    alistDest: String(config.alistDest || "").trim(),
  });
}

export function remoteStorageIdentity(config: AppConfig) {
  return crypto.createHash("sha256").update(normalizedConfigIdentity(config)).digest("hex");
}

function newProfile(identity: string, now: number): RemoteBackendProfile {
  return {
    identity,
    createdAt: now,
    lastUsedAt: now,
    capabilities: {
      copy: "unknown",
      move: "unknown",
      directoryList: "unknown",
      extendedUploadHeaders: "unknown",
    },
  };
}

export function getRemoteBackendProfile(config: AppConfig, now = Date.now()) {
  const identity = remoteStorageIdentity(config);
  let profile = profiles.get(identity);
  if (!profile || now - profile.lastUsedAt >= PROFILE_TTL_MS) {
    profile = newProfile(identity, now);
    profiles.set(identity, profile);
  }
  profile.lastUsedAt = now;
  while (profiles.size > MAX_PROFILES) {
    const oldest = [...profiles.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!oldest) break;
    profiles.delete(oldest.identity);
  }
  return profile;
}

export function updateRemoteCapability(
  config: AppConfig,
  key: RemoteCapabilityKey,
  value: RemoteCapability,
  now = Date.now(),
) {
  const profile = getRemoteBackendProfile(config, now);
  if (value === "unknown") return profile;
  profile.capabilities[key] = value;
  return profile;
}

export function clearRemoteBackendProfiles() {
  profiles.clear();
}

export function buildDavClient(config: AppConfig): WebDAVClient {
  return createClient(buildStorageDavUrl(config.alistUrl), {
    username: config.alistUsername,
    password: config.alistPassword,
  });
}

export function createRemoteStorageContext(config: AppConfig, client?: WebDAVClient) {
  return {
    client: client || buildDavClient(config),
    profile: getRemoteBackendProfile(config),
    identity: remoteStorageIdentity(config),
  };
}
