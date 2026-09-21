import type {JobRepository} from '../repositories/jobs.js';
import type {UploadFailureInfo} from '../upload-health.js';
import {logManager} from '../logger.js';
import {AUTOMATIC_QUALITY_RECOVERY_LIMIT, computeAutomaticQualityRecoveryDelayMs} from './retry-policy.js';
interface Dependencies {jobStore: Pick<JobRepository, 'findById' | 'wakeManualJob'>; now(): number;}
export function queueAutomaticQualityRecovery(deps: Dependencies, jobId: string, failure: UploadFailureInfo) {
    if (!["transient", "rate_limit", "server", "unknown"].includes(failure.category)) return false;
    const current = deps.jobStore.findById(jobId);
    if (!current || current.status !== "failed") return false;
    const payload = current.payload;
    const attempts = Math.max(0, Number(payload.automaticQualityRecoveryAttempts || 0));
    if (attempts >= AUTOMATIC_QUALITY_RECOVERY_LIMIT) return false;
    const nextAt = deps.now() + computeAutomaticQualityRecoveryDelayMs(attempts);
    const woken = deps.jobStore.wakeManualJob(jobId, {
      automaticQualityRecoveryAttempts: attempts + 1,
      automaticQualityRecoveryCategory: failure.category,
      automaticQualityRecoveryError: failure.summary,
      awaitingManualRecovery: false,
    }, nextAt);
    if (!woken) return false;
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "system",
      level: "warn",
      summary: `画质重调遇到临时${failure.category === "rate_limit" ? "限流" : "存储"}错误，已安排后台重试 ${current.bvid || ""}`,
      raw: `[QualityRecovery] automatic retry=${attempts + 1}/${AUTOMATIC_QUALITY_RECOVERY_LIMIT} category=${failure.category} next=${new Date(nextAt).toISOString()}`,
      bvid: current.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    return true;
  }
