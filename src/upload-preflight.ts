import type { RemoteFileRecord } from "./state.js";

export type UploadIntent = "normal_backup" | "history_upload" | "quality_upgrade" | "conflict_candidate";

export interface ExistingArchiveProof {
  remotePath: string;
  files: RemoteFileRecord[];
  status: "verified" | "partial_verified";
  uploadedAt?: string;
  verifiedAt?: string;
}

export interface ObservedRemoteEntry {
  path: string;
  status: "missing" | "exists" | "unknown";
  directory?: boolean;
  size?: number;
  failure?: { category?: string; status?: number; code?: string };
}

export interface UploadTargetPreflightEntry {
  path: string;
  expectedSize: number;
  observed: ObservedRemoteEntry;
  currentSessionPutAccepted: boolean;
}

export type UploadGroupPreflightDecision =
  | {
    kind: "retain_existing";
    proof: ExistingArchiveProof;
    proofStrength: "verified" | "legacy";
  }
  | {
    kind: "upload_new" | "resume_current_session";
    acceptedExistingPaths: string[];
  };

export class UploadPreflightConflictError extends Error {
  readonly status = 409;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UploadPreflightConflictError";
  }
}

function normalizedPath(value: string) {
  return String(value || "").replace(/\\/g, "/");
}

function archiveProofStrength(proof: ExistingArchiveProof) {
  return proof.files.some((file) => file.verificationStatus === undefined)
    ? "legacy" as const
    : "verified" as const;
}

export function decideUploadGroupPreflight(input: {
  intent: UploadIntent;
  existingArchiveProof?: ExistingArchiveProof;
  existingArchiveObservations?: ObservedRemoteEntry[];
  targets: UploadTargetPreflightEntry[];
  legacyConflictSideEffectsStarted?: boolean;
}): UploadGroupPreflightDecision {
  if (input.intent === "normal_backup" && input.legacyConflictSideEffectsStarted) {
    throw new UploadPreflightConflictError(
      "UPLOAD_LEGACY_CONFLICT_ARCHIVE_INTERRUPTED",
      "旧版冲突归档流程已经产生远端副作用，需要人工复核；系统没有继续移动、覆盖或上传文件",
    );
  }

  const proof = input.intent === "normal_backup" ? input.existingArchiveProof : undefined;
  if (proof) {
    if (proof.status !== "verified") {
      throw new UploadPreflightConflictError(
        "UPLOAD_PARTIAL_EXISTING_ARCHIVE",
        "现有归档仅为部分验证状态，系统没有把新旧分P混合，也没有覆盖旧文件",
      );
    }
    if (proof.files.length === 0) {
      throw new UploadPreflightConflictError(
        "UPLOAD_EMPTY_EXISTING_ARCHIVE_PROOF",
        "现有归档证明不包含文件，无法安全判定是否保留旧版",
      );
    }
    const observations = new Map(
      (input.existingArchiveObservations || []).map((entry) => [normalizedPath(entry.path), entry]),
    );
    for (const file of proof.files) {
      const path = normalizedPath(file.path);
      const observed = observations.get(path);
      const expectedSize = Number(file.size);
      if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
        throw new UploadPreflightConflictError(
          "UPLOAD_INCOMPLETE_EXISTING_ARCHIVE_PROOF",
          "现有归档证明缺少有效文件大小，无法安全判定是否保留旧版",
        );
      }
      if (file.verificationStatus && file.verificationStatus !== "verified") {
        throw new UploadPreflightConflictError(
          "UPLOAD_UNVERIFIED_EXISTING_ARCHIVE_PROOF",
          "现有归档证明尚未完成验证，系统没有覆盖旧文件",
        );
      }
      if (!observed || observed.status !== "exists" || observed.directory || observed.size !== expectedSize) {
        throw new UploadPreflightConflictError(
          observed?.status === "unknown" ? "UPLOAD_EXISTING_ARCHIVE_STATE_UNKNOWN" : "UPLOAD_EXISTING_ARCHIVE_CHANGED",
          observed?.status === "unknown"
            ? "现有归档的远端状态无法确认，系统没有上传新版、覆盖旧文件或混合分P"
            : "现有归档与SQLite证明不一致，系统没有上传新版、覆盖旧文件或混合分P",
        );
      }
    }
    return {
      kind: "retain_existing",
      proof,
      proofStrength: archiveProofStrength(proof),
    };
  }

  const acceptedExistingPaths: string[] = [];
  let resumed = false;
  for (const target of input.targets) {
    const observed = target.observed;
    if (observed.status === "missing") continue;
    if (observed.status === "unknown") {
      throw new UploadPreflightConflictError(
        "UPLOAD_REMOTE_STATE_UNKNOWN",
        "远端上传目标状态无法确认，系统没有重复上传或覆盖未知文件",
      );
    }
    if (observed.directory) {
      throw new UploadPreflightConflictError(
        "UPLOAD_TARGET_IS_DIRECTORY",
        "远端上传目标是目录，系统没有覆盖或删除它",
      );
    }
    if (observed.size !== target.expectedSize) {
      throw new UploadPreflightConflictError(
        "UPLOAD_REMOTE_SIZE_CONFLICT",
        `远端存在同名但大小不同的文件，系统没有覆盖它（期望 ${target.expectedSize}，实际 ${observed.size ?? "未知"}）`,
      );
    }
    if (input.intent === "normal_backup" && !target.currentSessionPutAccepted) {
      throw new UploadPreflightConflictError(
        "UPLOAD_UNKNOWN_SAME_SIZE_TARGET",
        "远端存在同名同大小文件，但缺少旧归档证明或本次上传证明，系统没有把它标记为上传成功",
      );
    }
    acceptedExistingPaths.push(normalizedPath(target.path));
    resumed ||= target.currentSessionPutAccepted;
  }

  return {
    kind: resumed ? "resume_current_session" : "upload_new",
    acceptedExistingPaths,
  };
}
