export type TransferSessionPhase =
  | "uploading"
  | "awaiting_remote"
  | "completed"
  | "failed"
  | "superseded";

export type TransferSessionFileStatus =
  | "pending"
  | "uploading"
  | "awaiting_remote"
  | "verified"
  | "failed";

export interface TransferSessionRecord {
  id: string;
  dedupeKey: string;
  kind: "upload";
  bvid: string;
  userId?: string;
  mediaId?: number;
  localDir: string;
  remotePath: string;
  stagingPath: string;
  phase: TransferSessionPhase;
  generation: number;
  historyOnly: boolean;
  historySnapshotAt?: string;
  allowReupload: boolean;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TransferSessionFileRecord {
  sessionId: string;
  generation: number;
  relativePath: string;
  name: string;
  stagingPath: string;
  finalPath: string;
  expectedSize: number;
  status: TransferSessionFileStatus;
  putAcceptedAt?: number;
  stageVerifiedAt?: number;
  movedAt?: number;
  verifiedAt?: number;
  attempts: number;
  nextCheckAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export type TransferSessionPatch = Partial<Pick<TransferSessionRecord, "phase" | "allowReupload">> & {
  lastError?: string | null;
  completedAt?: number | null;
};

export type TransferSessionFilePatch = Partial<Pick<TransferSessionFileRecord,
  "name" | "stagingPath" | "finalPath" | "status" | "attempts"
>> & {
  putAcceptedAt?: number | null;
  stageVerifiedAt?: number | null;
  movedAt?: number | null;
  verifiedAt?: number | null;
  nextCheckAt?: number | null;
  lastError?: string | null;
};

export interface EnsureTransferSessionInput {
  sessionId?: string;
  dedupeKey: string;
  bvid: string;
  userId?: string;
  mediaId?: number;
  localDir: string;
  remotePath: string;
  historyOnly?: boolean;
  historySnapshotAt?: string;
  expectedGeneration?: number;
}

/** Domain persistence contract. Connection replacement belongs to the application lifecycle. */
export interface TransferSessionRepository {
  get(id: string): TransferSessionRecord | null;
  assertGeneration(id: string, expectedGeneration?: number): TransferSessionRecord;
  getByDedupeKey(dedupeKey: string): TransferSessionRecord | null;
  findForTarget(userId: string | undefined, mediaId: number | undefined, bvid: string, finalPath?: string): TransferSessionRecord | null;
  hasActiveForBvid(bvid: string): boolean;
  listFiles(sessionId: string, generation?: number): TransferSessionFileRecord[];
  getFile(sessionId: string, relativePath: string, generation?: number): TransferSessionFileRecord | null;
  ensurePrepared(input: EnsureTransferSessionInput, files: Array<{
    relativePath: string;
    name: string;
    expectedSize: number;
  }>, bind?: (session: TransferSessionRecord) => void): TransferSessionRecord;
  ensure(input: EnsureTransferSessionInput): TransferSessionRecord;
  ensureFile(sessionId: string, input: {
    relativePath: string;
    name: string;
    expectedSize: number;
  }, expectedGeneration?: number): TransferSessionFileRecord;
  updateSession(id: string, patch: TransferSessionPatch, expectedGeneration?: number): TransferSessionRecord | null;
  allowReupload(id: string, expectedGeneration?: number): TransferSessionRecord | null;
  updateFile(id: string, relativePath: string, patch: TransferSessionFilePatch, expectedGeneration?: number): TransferSessionFileRecord | null;
  supersede(id: string, expectedGeneration?: number): boolean;
  listRecoverable(limit?: number): TransferSessionRecord[];
  listRecoverablePage(limit?: number, offset?: number): TransferSessionRecord[];
  summary(): {
    count: number;
    phases: Record<string, number>;
  };
}
