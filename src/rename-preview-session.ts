import crypto from "node:crypto";
import type {
  InternalRenamePreviewData,
  RenamePreviewCandidate,
  RenamePreviewData,
} from "./rename-preview.js";

export interface RenamePreviewRemoteScanInfo {
  id: string;
  status: "scanning" | "ready" | "failed" | "expired";
  startedAt: number;
  completedAt?: number;
  expiresAt?: number;
  error?: string;
  complete?: boolean;
  scannedFiles?: number;
  scannedEntries?: number;
  scannedDirectories?: number;
  skippedTotal?: number;
}

export interface RenamePreviewSessionCandidate extends Omit<RenamePreviewCandidate, "sourceAccessPath" | "expectedSize"> {
  candidateId: string;
}

export interface RenamePreviewSessionResponse extends Omit<RenamePreviewData, "candidates"> {
  previewId: string;
  revision: number;
  expiresAt: number;
  candidates: RenamePreviewSessionCandidate[];
  remoteScan: RenamePreviewRemoteScanInfo;
  unchanged?: boolean;
}

interface StoredCandidate extends RenamePreviewCandidate {
  candidateId: string;
}

interface RenamePreviewSession {
  id: string;
  key: string;
  configKey: string;
  scanId: string;
  createdAt: number;
  expiresAt: number;
  revision: number;
  local: InternalRenamePreviewData;
  current: InternalRenamePreviewData;
  remoteScan: RenamePreviewRemoteScanInfo;
  remoteSignature: string;
  candidates: Map<string, StoredCandidate>;
  consumed: boolean;
  executing: boolean;
  executionResult?: unknown;
}

export interface RenamePreviewSessionStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

function candidateFingerprint(candidate: RenamePreviewCandidate) {
  return JSON.stringify([candidate.bvid, candidate.oldPath, candidate.newPath]);
}

function newCandidateId() {
  return `rename-${crypto.randomBytes(12).toString("base64url")}`;
}

function cloneRemoteScan(scan: RenamePreviewRemoteScanInfo): RenamePreviewRemoteScanInfo {
  return { ...scan };
}

function clonePublicCandidate(candidate: StoredCandidate): RenamePreviewSessionCandidate {
  const { sourceAccessPath: _sourceAccessPath, expectedSize: _expectedSize, candidateId, ...publicCandidate } = candidate;
  return { ...publicCandidate, candidateId };
}

export class RenamePreviewSessionStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly sessions = new Map<string, RenamePreviewSession>();

  constructor(options: RenamePreviewSessionStoreOptions = {}) {
    this.now = options.now || Date.now;
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 5 * 60_000));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 8));
  }

  create(input: {
    key: string;
    configKey: string;
    scanId: string;
    local: InternalRenamePreviewData;
    current: InternalRenamePreviewData;
    remoteScan: RenamePreviewRemoteScanInfo;
    remoteSignature: string;
    force?: boolean;
  }) {
    this.prune();
    if (input.force) {
      for (const [id, session] of this.sessions) {
        if (session.key === input.key && !session.executing) this.sessions.delete(id);
      }
    }
    if (!input.force) {
      const existing = [...this.sessions.values()]
        .reverse()
        .find((session) => session.key === input.key && !session.consumed);
      if (existing) return this.toResponse(existing);
    }
    if (this.sessions.size >= this.maxEntries) {
      throw new Error("重命名预览过多，请关闭旧预览后再试");
    }
    const now = this.now();
    const session: RenamePreviewSession = {
      id: crypto.randomUUID(),
      key: input.key,
      configKey: input.configKey,
      scanId: input.scanId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      revision: 1,
      local: input.local,
      current: input.current,
      remoteScan: cloneRemoteScan(input.remoteScan),
      remoteSignature: input.remoteSignature,
      candidates: new Map(),
      consumed: false,
      executing: false,
    };
    session.current = this.assignCandidateIds(session, input.current);
    session.local = input.local;
    this.sessions.set(session.id, session);
    return this.toResponse(session);
  }

  get(id: string) {
    this.prune();
    const session = this.sessions.get(String(id || ""));
    if (!session) return undefined;
    return session;
  }

  getResponse(id: string, unchanged = false) {
    const session = this.get(id);
    if (!session) return undefined;
    return this.toResponse(session, unchanged);
  }

  getScanId(id: string) {
    return this.get(id)?.scanId;
  }

  getLocalPreview(id: string) {
    return this.get(id)?.local;
  }

  getRemoteSignature(id: string) {
    return this.get(id)?.remoteSignature;
  }

  getConfigKey(id: string) {
    return this.get(id)?.configKey;
  }

  applyScan(
    id: string,
    input: {
      current: InternalRenamePreviewData;
      remoteScan: RenamePreviewRemoteScanInfo;
      remoteSignature: string;
    },
  ) {
    const session = this.get(id);
    if (!session) return false;
    if (session.remoteSignature === input.remoteSignature) return false;
    session.current = this.assignCandidateIds(session, input.current);
    session.remoteScan = cloneRemoteScan(input.remoteScan);
    session.remoteSignature = input.remoteSignature;
    session.revision += 1;
    return true;
  }

  beginExecution(id: string, candidateIds: string[]) {
    const session = this.get(id);
    if (!session) return { kind: "missing" as const };
    if (session.consumed) {
      if (session.executionResult !== undefined) return { kind: "completed" as const, result: session.executionResult };
      return { kind: "in_progress" as const };
    }
    const normalizedIds = [...new Set(candidateIds.map((value) => String(value || "")))];
    if (normalizedIds.length === 0 || normalizedIds.length !== candidateIds.length) {
      return { kind: "invalid" as const, message: "至少选择一个有效的重命名候选" };
    }
    const candidates = normalizedIds.map((candidateId) => session.candidates.get(candidateId));
    if (candidates.some((candidate): candidate is undefined => !candidate)) {
      return { kind: "invalid" as const, message: "重命名候选已变化，请重新预览" };
    }
    session.consumed = true;
    session.executing = true;
    return { kind: "started" as const, candidates: candidates as StoredCandidate[] };
  }

  finishExecution(id: string, result: unknown) {
    const session = this.sessions.get(String(id || ""));
    if (!session) return false;
    session.executing = false;
    session.executionResult = result;
    // Keep only the idempotency result after execution.  The candidate set is
    // no longer a valid preview and may contain private access spellings.
    session.candidates.clear();
    session.local = { ...session.local, candidates: [] };
    session.current = { ...session.current, candidates: [] };
    return true;
  }

  getExecutionResult(id: string) {
    const session = this.get(id);
    return session?.executionResult;
  }

  invalidateConfig(configKey: string) {
    const normalizedKey = String(configKey || "");
    for (const [id, session] of this.sessions) {
      if (!session.executing && session.configKey !== normalizedKey) this.sessions.delete(id);
    }
  }

  get size() {
    this.prune();
    return this.sessions.size;
  }

  clear() {
    this.sessions.clear();
  }

  private assignCandidateIds(session: RenamePreviewSession, data: InternalRenamePreviewData) {
    const previousByFingerprint = new Map<string, StoredCandidate>();
    for (const candidate of session.candidates.values()) previousByFingerprint.set(candidateFingerprint(candidate), candidate);
    const next = new Map<string, StoredCandidate>();
    const candidates = data.candidates.map((candidate) => {
      const previous = previousByFingerprint.get(candidateFingerprint(candidate));
      const stored = { ...candidate, candidateId: previous?.candidateId || newCandidateId() };
      next.set(stored.candidateId, stored);
      return stored;
    });
    session.candidates = next;
    return { ...data, candidates };
  }

  private toResponse(session: RenamePreviewSession, unchanged = false): RenamePreviewSessionResponse {
    const { candidates, ...summary } = session.current;
    const publicSummary = unchanged
      ? { ...summary, skipped: [], skippedByReason: {} }
      : summary;
    return {
      ...publicSummary,
      previewId: session.id,
      revision: session.revision,
      expiresAt: session.expiresAt,
      candidates: unchanged ? [] : [...session.candidates.values()].map(clonePublicCandidate),
      remoteScan: cloneRemoteScan(session.remoteScan),
      ...(unchanged ? { unchanged: true } : {}),
    };
  }

  private prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now && !session.executing) this.sessions.delete(id);
    }
  }
}
