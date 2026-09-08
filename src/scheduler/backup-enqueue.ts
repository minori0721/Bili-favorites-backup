import type { AppConfig, ConfigStore } from '../config.js';
import type { BiliUser } from '../users.js';
import type { StateManager } from '../state.js';
import type { PersistentJobStore, EnqueuePersistentJob } from '../job-store.js';
import type { QualityEncodingOverride } from '../tasks.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { RecoveryUploadItem } from './upload-work.js';
import { buildQualityArtifactKey, normalizeQualityArtifactProfile, type QualityArtifactProfile } from '../quality-artifact.js';
import { buildUploadFileMetadataFromSession, historySessionGroups } from '../download-session.js';
import { joinRemotePath } from '../utils.js';

export interface BackupEnqueueOptions {
  persisted?: boolean; notBefore?: number; downloadUserId?: string; recoveryAttempt?: number; dedupeKey?: string;
  qualityProfile?: QualityArtifactProfile; qualityStrict?: boolean; qualityEncodingOverride?: QualityEncodingOverride;
}
interface Dependencies {
  config: Pick<ConfigStore, 'get'>;
  state: Pick<StateManager, 'getCompletedLocalDownload' | 'getChargingRestriction' | 'clearChargingRestriction' | 'shouldEnqueueBackup' | 'getRelationStatus' | 'getVideoMeta' | 'markQueued' | 'runAtomic'>;
  jobs: Pick<PersistentJobStore, 'findByDedupeKey' | 'complete' | 'enqueueBatch'>;
  eligible(user: BiliUser): boolean;
  blocked(userId: string, mediaId: number, bvid: string): boolean;
  remotePath(user: BiliUser, mediaId: number, title: string, config: AppConfig): string;
  proof(userId: string, mediaId: number, bvid: string): ExistingArchiveProof | undefined;
  uploadJob(item: RecoveryUploadItem): EnqueuePersistentJob;
  historySegment(value: string): string;
  probe(bvid: string, options: { preferredUserId: string; checkedAccountUids?: string[]; previewAvailable?: boolean; notBefore: number }): unknown;
  cycleStartedAt(): string | undefined;
  generation(): number;
  now(): number;
  dispatch(): void;
}
export function createBackupEnqueue(deps: Dependencies) {
  /** All filesystem evidence is read while preparing; commit only mutates SQLite and its memory projection. */
  function prepare(user: BiliUser, mediaId: number, folderTitle: string, bvid: string, options: BackupEnqueueOptions = {}, recoveryDownload = false) {
    if (!deps.eligible(user) || deps.blocked(user.id, mediaId, bvid)) return null;
    const epoch = deps.generation();
    const exact = Boolean(options.qualityProfile && (options.qualityStrict || options.qualityEncodingOverride?.strict));
    const local = exact || recoveryDownload ? null : deps.state.getCompletedLocalDownload(bvid);
    const restriction = deps.state.getChargingRestriction(bvid);
    if (restriction && !local) {
      const nextAt = Date.parse(restriction.nextCheckAt || '');
      return { kind: 'probe' as const, commit: () => {
        if (epoch !== deps.generation() || !deps.eligible(user) || deps.blocked(user.id, mediaId, bvid)) return false;
        deps.probe(bvid, { preferredUserId: user.id, checkedAccountUids: restriction.checkedAccountUids,
          previewAvailable: restriction.previewAvailable, notBefore: Number.isFinite(nextAt) ? Math.max(deps.now(), nextAt) : deps.now() });
        return true;
      } };
    }
    if (!options.persisted && !(restriction && local) && !deps.state.shouldEnqueueBackup(bvid, user.id, mediaId, deps.cycleStartedAt())) return null;
    const config = deps.config.get();
    const remotePath = deps.state.getRelationStatus(user.id, mediaId, bvid)?.remotePath || deps.remotePath(user, mediaId, folderTitle, config);
    const existingArchiveProof = deps.proof(user.id, mediaId, bvid);
    const jobs: EnqueuePersistentJob[] = [];
    if (local) {
      const meta = deps.state.getVideoMeta(bvid);
      const common = { bvid, localDir: local.localDir, remotePath, userId: user.id, mediaId, folderTitle,
        videoTitle: meta?.title || bvid, upperName: meta?.upperName || '', cover: meta?.cover || '' };
      jobs.push(deps.uploadJob({ ...common, files: local.files,
        filenameMetadataByPath: buildUploadFileMetadataFromSession(local.localDir, local.files),
        partialBackup: local.partialBackup, existingArchiveProof, priority: true }));
      for (const history of historySessionGroups(local.localDir)) {
        jobs.push(deps.uploadJob({ ...common, remotePath: joinRemotePath(remotePath, '_history', deps.historySegment(history.snapshotAt)),
          files: history.files.map(file => file.relativePath), historyOnly: true, historySnapshotAt: history.snapshotAt, priority: false }));
      }
    } else {
      jobs.push({ kind: 'download', dedupeKey: options.dedupeKey || `download:${bvid}`, bvid, priority: 40,
        maxAttempts: config.maxRetries + 1, notBefore: options.notBefore || 0,
        payload: { primaryUserId: user.id, primaryMediaId: mediaId, primaryFolderTitle: folderTitle,
          downloadUserId: options.downloadUserId || user.id, automaticRecoveryAttempts: Math.max(0, Number(options.recoveryAttempt || 0)),
          qualityProfile: options.qualityProfile, qualityStrict: options.qualityStrict === true,
          qualityEncodingOverride: options.qualityEncodingOverride,
          qualityArtifactKey: exact && options.qualityProfile ? buildQualityArtifactKey(bvid, normalizeQualityArtifactProfile(options.qualityProfile)) : undefined } });
    }
    return { kind: local ? 'upload' as const : 'download' as const, commit: () => {
      if (epoch !== deps.generation() || !deps.eligible(user) || deps.blocked(user.id, mediaId, bvid)) return false;
      if (recoveryDownload) {
        const existing = deps.jobs.findByDedupeKey(jobs[0].dedupeKey);
        if (existing && (existing.kind !== 'download' || !['pending', 'leased', 'running', 'retry_wait'].includes(existing.status))) return false;
      }
      deps.state.runAtomic(() => {
        if (restriction && local) {
          deps.state.clearChargingRestriction(bvid);
          const probe = deps.jobs.findByDedupeKey(`access_probe:${bvid}`);
          if (probe) deps.jobs.complete(probe.id);
        }
        deps.state.markQueued(bvid, remotePath, user.id, mediaId);
        deps.jobs.enqueueBatch(jobs);
      });
      return true;
    } };
  }
  function enqueue(user: BiliUser, mediaId: number, title: string, bvid: string, options: BackupEnqueueOptions = {}) {
    const prepared = prepare(user, mediaId, title, bvid, options);
    if (!prepared) return false;
    const queued = prepared.commit();
    deps.dispatch();
    return queued && prepared.kind !== 'probe';
  }
  function prepareRecoveryDownload(user: BiliUser, mediaId: number, title: string, bvid: string, options: BackupEnqueueOptions = {}) {
    return prepare(user, mediaId, title, bvid, { ...options, persisted: true }, true);
  }
  return { prepare, prepareRecoveryDownload, enqueue };
}
