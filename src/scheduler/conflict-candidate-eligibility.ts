import fs from 'node:fs';
import path from 'node:path';
import type { TransferSessionStore } from '../transfer-session.js';
import type { PersistentJobRecord } from '../database.js';
import type { RecoveryIssueKind } from '../recovery-policy.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
export function inspectConflictCandidateEligibility(transfers: Pick<TransferSessionStore, 'get' | 'listFiles'>, job: PersistentJobRecord, assessment: RecoveryAssessment | null) {
    const payload = job.payload;
    if (!job || !payload || job.kind !== "upload" || payload.historyOnly) {
      return { eligible: false, reason: "只有普通归档上传可以生成冲突候选", fileCount: 0, totalBytes: 0 };
    }
    const allowedKinds = new Set<RecoveryIssueKind>([
      "remote_size_conflict",
      "partial_remote_state",
      "unknown_same_size",
      "legacy_conflict_interrupted",
      "remote_visibility_stalled",
      "remote_unsupported",
      "remote_unknown",
      "manual_review",
    ]);
    if (!assessment || !allowedKinds.has(assessment.kind)) {
      return { eligible: false, reason: "当前远端状态不适合生成候选", fileCount: 0, totalBytes: 0 };
    }
    if (["remote_visibility_stalled", "remote_unsupported", "remote_unknown", "manual_review"].includes(assessment.kind)
      && assessment.candidateSafe !== true) {
      return { eligible: false, reason: "尚未确认候选父目录可见，不能安全写入", fileCount: 0, totalBytes: 0 };
    }
    const localDir = String(payload.localDir || "");
    const requestedFiles: string[] = Array.isArray(payload.files)
      ? [...new Set<string>(payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/")).filter(Boolean))]
      : [];
    if (!localDir || requestedFiles.length === 0) {
      return { eligible: false, reason: "本地文件组清单不完整", fileCount: 0, totalBytes: 0 };
    }
    const localRoot = path.resolve(localDir);
    let totalBytes = 0;
    for (const relativePath of requestedFiles) {
      const localFile = path.resolve(localRoot, relativePath);
      if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`)) {
        return { eligible: false, reason: "本地文件路径超出任务目录", fileCount: 0, totalBytes: 0 };
      }
      try {
        const stat = fs.lstatSync(localFile);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
          return { eligible: false, reason: "本地文件组包含无效文件", fileCount: 0, totalBytes: 0 };
        }
        totalBytes += stat.size;
      } catch {
        return { eligible: false, reason: "本地文件组已有文件缺失", fileCount: 0, totalBytes: 0 };
      }
    }
    if (payload.sessionId) {
      const session = transfers.get(String(payload.sessionId));
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session?.generation;
      if (!session || session.generation !== expectedGeneration) {
        return { eligible: false, reason: "上传Session已经变化", fileCount: 0, totalBytes: 0 };
      }
      const sessionFiles = transfers.listFiles(session.id, session.generation);
      const requestedSet = new Set(requestedFiles);
      if (sessionFiles.length !== requestedSet.size
        || sessionFiles.some((file) => !requestedSet.has(file.relativePath.replace(/\\/g, "/")))) {
        return { eligible: false, reason: "本地文件组与上传Session不一致", fileCount: 0, totalBytes: 0 };
      }
      for (const file of sessionFiles) {
        try {
          if (fs.lstatSync(path.resolve(localRoot, file.relativePath)).size !== file.expectedSize) {
            return { eligible: false, reason: "本地文件大小与上传Session不一致", fileCount: 0, totalBytes: 0 };
          }
        } catch {
          return { eligible: false, reason: "上传Session文件已不可用", fileCount: 0, totalBytes: 0 };
        }
      }
    }
    return { eligible: true, reason: "本地完整文件组可写入隔离候选", fileCount: requestedFiles.length, totalBytes };
  }
