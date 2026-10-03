import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { BiliUser } from '../users.js';
import { logManager } from '../logger.js';

const RESUME_DELAYS = [30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
export function downloadRecoveryDelay(round: number) {
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('Invalid automatic download resume round');
  return RESUME_DELAYS[Math.min(round, RESUME_DELAYS.length - 1)];
}

export function downloadCredentialRevision(user: Pick<BiliUser, 'lastLoginAt' | 'lastAuthRefreshAt'>) {
  return `${user.lastLoginAt}|${user.lastAuthRefreshAt || ''}`;
}

interface Dependencies {
  jobs: Pick<JobRepository, 'findById' | 'updatePayload' | 'wakeManualJob'>;
  user(id: string): BiliUser | null | undefined;
  eligible(job: PersistentJobRecord, user: BiliUser): boolean;
  atomic<T>(work: () => T): T;
  now(): number;
  canRun(): boolean;
  resumed(job: PersistentJobRecord): void;
  dispatch(): void;
}

/** Reuses the original directory and normal queue admission; never starts a downloader itself. */
export function resumeAutomaticDownload(deps: Dependencies, jobId: string) {
  const resumed = deps.atomic(() => {
    const job = deps.jobs.findById(jobId);
    if (!deps.canRun() || !job || job.kind !== 'download' || job.payload.awaitingManualRecovery !== true
      || job.payload.userDisposition === 'abandoned' || job.payload.lifecycleState === 'abandoned') return false;
    const recovery = job.payload.downloadRecovery;
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return false;
    const category = Reflect.get(recovery, 'category');
    if (category !== 'transient' && category !== 'account') return false;
    const nextAt = Reflect.get(recovery, 'nextCheckAt');
    if (typeof nextAt === 'number' && nextAt > deps.now()) return false;
    const userId = Reflect.get(recovery, 'downloadUserId') ?? job.payload.downloadUserId ?? job.userId;
    const user = typeof userId === 'string' ? deps.user(userId) : null;
    if (!user || !deps.eligible(job, user)) {
      deps.jobs.updatePayload(job.id, { ...job.payload, downloadRecovery: { ...recovery, nextCheckAt: deps.now() + RESUME_DELAYS[0] } });
      return false;
    }
    if (category === 'account') {
      const revision = downloadCredentialRevision(user);
      const previous = Reflect.get(recovery, 'credentialRevision');
      if (previous === undefined || previous === revision) {
        deps.jobs.updatePayload(job.id, { ...job.payload, downloadRecovery: { ...recovery, credentialRevision: revision,
          nextCheckAt: deps.now() + RESUME_DELAYS[0] } });
        return false;
      }
    }
    const round = typeof job.payload.automaticDownloadResumes === 'number'
      ? job.payload.automaticDownloadResumes : 0;
    if (!Number.isSafeInteger(round) || round < 0) throw new Error('Invalid automatic download resume round');
    if (!deps.jobs.wakeManualJob(job.id, { downloadUserId: user.id, awaitingManualRecovery: false, downloadRecovery: undefined,
      recoveryAssessment: undefined, automaticDownloadResumes: round + 1 })) return false;
    deps.resumed(job);
    return true;
  });
  if (resumed) {
    logManager.push({ timestamp: new Date(deps.now()).toISOString(), type: 'download', level: 'info',
      summary: '已自动继续临时失败的下载', raw: `[Recovery] download resumed through normal queue; job=${jobId}`,
      simpleVisible: true, debugVisible: true });
    deps.dispatch();
  }
  return resumed;
}
