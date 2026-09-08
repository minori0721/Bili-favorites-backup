import path from 'node:path';
import type { PersistentJobRecord } from '../database.js';
import type { PersistentJobStore } from '../job-store.js';
import type { StateManager } from '../state.js';
import type { UserStore, BiliUser } from '../users.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { sanitizeUploadText, type UploadCircuitBreaker } from '../upload-health.js';
import type { EncodingRetryContext, QualityUpgradeTarget } from '../tasks.js';
import { parseEncodingRetryContext } from './recovery-context.js';
import { parseRecoveryIssuePayload } from './recovery-issue-payload.js';
import {
  planRecoveryActions,
  recoveryIssueDisposition,
  recoveryIssueSeverity,
  type DownloadRecoveryCategory,
  type RecoveryIssueAction,
  type RecoveryIssueKind,
} from '../recovery-policy.js';
import type { RecoveryAssessment, RecoveryIssue } from './recovery-contracts.js';
import {
  qualityTargetsFromPayload,
  resolveQualityUpgradeTarget,
} from './quality-rules.js';

type RecoveryJobStore = Pick<PersistentJobStore, 'listFailed' | 'listManualRecovery'>;

interface RecoveryIssueProjectionDependencies {
  jobs: RecoveryJobStore;
  users: Pick<UserStore, 'list'>;
  state: Pick<StateManager, 'getVideoMeta' | 'getCompletedLocalDownload' | 'getQualityUpgradeOperation'>;
  uploadCircuit: Pick<UploadCircuitBreaker, 'getSnapshot'>;
  now: () => number;
  isUserSyncEligible(user: BiliUser): boolean;
  manualRecoveryJobs(): PersistentJobRecord[];
  manualDownloadRecoveryJobs(): PersistentJobRecord[];
  recoveryAssessment(payload: unknown): RecoveryAssessment | null;
  inspectConflictCandidateEligibility(job: PersistentJobRecord, assessment: RecoveryAssessment | null): { eligible: boolean };
  persistedExistingArchiveProof(payload: unknown): ExistingArchiveProof | null;
}

function payloadOf(job: PersistentJobRecord) {
  return parseRecoveryIssuePayload(job.payload);
}

function qualityRetryChoices(currentQuality: unknown) {
  const current = String(currentQuality || '').trim().toUpperCase();
  return ['8K', '4K', '1080P60', '1080P', '720P']
    .filter(value => value !== current)
    .map(value => ({ value, label: value }));
}

export function uploadRecoverySummary(
  kind: string,
  assessment: RecoveryAssessment | null,
  retry: EncodingRetryContext | null,
  fallback: string,
) {
  if (kind !== 'encoding_retry_failed') return fallback;
  if (assessment?.qualityMismatch) {
    return `请求 ${assessment.requestedQuality || retry?.quality || '指定画质'}，但实际文件未满足；错误候选没有上传或采用，未执行归档替换。`;
  }
  if (assessment?.encodingMismatch) {
    return `请求 ${assessment.requestedEncoding || retry?.priority?.[0] || '指定编码'}，但实际文件未满足；错误候选没有上传或采用，未执行归档替换。`;
  }
  if (assessment?.remoteStatus === 'mismatch') {
    return '新候选上传后遇到远端同名大小冲突；系统未采用候选，也未执行归档替换。';
  }
  return '新候选未通过远端确认；系统已停止替换，未改变正式归档状态。';
}

function uploadRecoveryActions(
  deps: RecoveryIssueProjectionDependencies,
  assessment: RecoveryAssessment | null,
  job?: PersistentJobRecord,
  candidateEligible?: boolean,
): RecoveryIssueAction[] {
  const eligible = typeof candidateEligible === 'boolean'
    ? candidateEligible
    : (job ? deps.inspectConflictCandidateEligibility(job, assessment).eligible : false);
  const payload = parseRecoveryIssuePayload(job?.payload);
  const planned = planRecoveryActions({
    domain: 'upload',
    kind: assessment?.kind || 'manual_review',
    jobKind: job?.kind,
    historyOnly: Boolean(payload.historyOnly),
    localStatus: assessment?.localStatus,
    remoteStatus: assessment?.remoteStatus,
    candidateEligible: eligible,
  });
  if (assessment?.kind !== 'conflict_candidate_ready') return planned;
  const candidateRecord = payload.conflictCandidate;
  const existingProof = deps.persistedExistingArchiveProof(payload)
    || deps.persistedExistingArchiveProof({ existingArchiveProof: candidateRecord?.existingArchiveProof });
  return existingProof ? planned : planned.filter(action => action.id !== 'keep_existing');
}

function buildUploadRecoveryIssue(
  deps: RecoveryIssueProjectionDependencies,
  job: PersistentJobRecord,
): RecoveryIssue {
  const payload = payloadOf(job);
  const storedMeta = (!payload.videoTitle || !payload.upperName) && job.bvid
    ? deps.state.getVideoMeta(String(job.bvid))
    : null;
  const assessment = deps.recoveryAssessment(payload);
  const remoteErrorCode = assessment?.remoteErrorCode || payload.remoteErrorCode;
  const responseHeaders = assessment?.responseHeaders || payload.responseHeaders;
  const responseSnippet = assessment?.responseSnippet || payload.responseSnippet;
  const retry = parseEncodingRetryContext(payload.encodingRetry);
  const retryBusy = Boolean(payload.encodingRetry && ['running', 'uploading', 'verifying'].includes(String(payload.encodingRetry.state || '')));
  const kind = (assessment?.kind || (payload.conflictRelativePath ? 'remote_size_conflict' : 'manual_review')) as RecoveryIssueKind;
  const candidateEligible = typeof assessment?.candidateEligible === 'boolean'
    ? assessment.candidateEligible
    : payload.recoveryProjection === true
      ? false
      : deps.inspectConflictCandidateEligibility(job, assessment).eligible;
  const actions = retryBusy ? [] : uploadRecoveryActions(deps, assessment, job, candidateEligible);
  const titleByKind: Record<string, string> = {
    remote_visibility_timeout: '远端文件仍在等待可见',
    remote_visibility_stalled: '远端文件长时间不可见',
    remote_write_rejected: '远端写入结果未确认',
    remote_size_conflict: '远端存在同名冲突文件',
    remote_size_limit: '远端单文件超过存储限制',
    partial_remote_state: '多分P远端状态不一致',
    local_file_missing: '本地补传文件已丢失',
    local_file_changed: '本地补传文件已变化',
    remote_connection: '暂时无法连接存储后端',
    remote_permission: '存储后端拒绝了复核',
    remote_unsupported: '存储后端不支持复核方法',
    remote_unknown: '存储后端返回未知错误',
    unknown_same_size: '远端同大小文件缺少上传证明',
    legacy_conflict_interrupted: '旧式冲突归档需要人工复核',
    conflict_candidate_ready: '远端冲突候选等待选择',
    encoding_retry_failed: '编码替换未完成',
    manual_review: '上传任务需要复核',
  };
  const rawSummary = assessment?.summary || sanitizeUploadText(payload.manualRecoveryReason || job.lastError || '上传任务已安全暂停，等待复核。', 300);
  const retryFailureSummary = uploadRecoverySummary(kind, assessment, retry, rawSummary);
  const protectedFacts = [
    '没有自动覆盖或删除远端文件',
    '没有把未确认文件标记为归档成功',
    assessment?.localStatus === 'available' ? '本地文件仍保留' : '其他已验证归档不受影响',
  ];
  const diagnostic = {
    issue: kind,
    task: job.kind,
    bvid: job.bvid || undefined,
    videoTitle: payload.videoTitle || storedMeta?.title || undefined,
    upperName: payload.upperName || storedMeta?.upperName || undefined,
    userId: job.userId || undefined,
    mediaId: job.mediaId ?? undefined,
    localStatus: assessment?.localStatus || 'unknown',
    remoteStatus: assessment?.remoteStatus || 'unknown',
    writeStatus: assessment?.writeStatus,
    remoteErrorCode,
    responseHeaders,
    responseSnippet,
    writeEvidence: assessment?.writeEvidence,
    uploadAttempts: assessment?.uploadAttempts,
    requestedEncoding: assessment?.requestedEncoding,
    actualEncodings: assessment?.actualEncodings,
    encodingMismatch: assessment?.encodingMismatch,
    requestedQuality: assessment?.requestedQuality,
    actualQualities: assessment?.actualQualities,
    qualityMismatch: assessment?.qualityMismatch,
    verifiedPages: assessment?.verifiedPages,
    firstObservedAt: assessment?.firstObservedAt,
    consecutiveObservations: assessment?.consecutiveObservations,
    candidateEligible,
    checkedAt: assessment?.checkedAt || undefined,
    attempts: job.attempts,
    automaticRecoveryAttempts: Number(payload.automaticRecoveryAttempts || 0),
  };
  return {
    id: `upload.${job.id}`,
    kind,
    severity: recoveryIssueSeverity(kind),
    title: kind === 'encoding_retry_failed' && (assessment?.requestedQuality || retry?.quality)
      ? '媒体替换未完成'
      : (titleByKind[kind] || titleByKind.manual_review),
    summary: retryBusy
      ? `正在按 ${[retry?.quality, retry?.priority?.[0]].filter(Boolean).join(' / ') || '指定媒体规格'} 重新下载并上传；替换流程不会主动清理旧文件，完成后会自动确认。`
      : retryFailureSummary,
    protectedFacts,
    recommendedAction: actions[0],
    availableActions: actions,
    bvid: job.bvid || undefined,
    userId: job.userId || undefined,
    mediaId: job.mediaId ?? undefined,
    folderTitle: payload.folderTitle || undefined,
    fileName: assessment?.fileName || (payload.conflictRelativePath ? path.basename(String(payload.conflictRelativePath)) : undefined),
    expectedSize: assessment?.expectedSize,
    observedSize: assessment?.observedSize,
    remoteErrorCode,
    responseHeaders,
    responseSnippet,
    requestedEncoding: assessment?.requestedEncoding,
    actualEncodings: assessment?.actualEncodings,
    encodingMismatch: assessment?.encodingMismatch,
    requestedQuality: assessment?.requestedQuality,
    actualQualities: assessment?.actualQualities,
    qualityMismatch: assessment?.qualityMismatch,
    verifiedPages: assessment?.verifiedPages,
    totalPages: Number.isInteger(Number(payload.totalPages)) ? Number(payload.totalPages) : undefined,
    lifecycleState: payload.lifecycleState ? String(payload.lifecycleState) : undefined,
    attemptKey: payload.attemptKey ? String(payload.attemptKey) : undefined,
    occurredAt: job.updatedAt || job.createdAt || deps.now(),
    checkedAt: assessment?.checkedAt,
    nextAutomaticCheckAt: assessment?.nextCheckAt,
    busy: retryBusy,
    safeDiagnostic: JSON.stringify(diagnostic, null, 2),
    disposition: recoveryIssueDisposition(kind),
  };
}

function buildDownloadRecoveryIssue(
  deps: RecoveryIssueProjectionDependencies,
  job: PersistentJobRecord,
): RecoveryIssue {
  const payload = payloadOf(job);
  const stored = payload.downloadRecovery;
  const category = ['transient', 'account', 'tool', 'unknown'].includes(String(stored.category || ''))
    ? String(stored.category) as DownloadRecoveryCategory
    : 'unknown';
  const kindByCategory: Record<DownloadRecoveryCategory, Extract<RecoveryIssueKind, 'download_retry_exhausted' | 'download_account_required' | 'download_tool_failure'>> = {
    transient: 'download_retry_exhausted', account: 'download_account_required', tool: 'download_tool_failure', unknown: 'download_retry_exhausted',
  };
  const kind = (['download_retry_exhausted', 'download_account_required', 'download_tool_failure'].includes(String(stored.kind || ''))
    ? String(stored.kind)
    : kindByCategory[category]) as RecoveryIssueKind;
  const currentDownloadUserId = String(stored.downloadUserId || payload.downloadUserId || payload.primaryUserId || job.userId || '');
  const alternateAccounts = deps.users.list()
    .filter(user => user.id !== currentDownloadUserId && deps.isUserSyncEligible(user))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id))
    .map(user => ({ value: user.id, label: `${user.name}（UID ${user.uid}）` }));
  const actions = planRecoveryActions({
    domain: 'download',
    kind,
    jobKind: job.kind,
    downloadCategory: category,
    alternateAccounts,
    downloadEncodingEligible: payload.qualityFailure?.encodingEligible === true,
    downloadQualityEligible: payload.qualityFailure?.qualityEligible === true,
    downloadQualityChoices: qualityRetryChoices(payload.qualityProfile?.quality),
  });
  const meta = job.bvid ? deps.state.getVideoMeta(String(job.bvid)) : null;
  const titleByKind: Record<string, string> = {
    download_retry_exhausted: '下载重试次数已用完',
    download_account_required: '当前账号无法继续下载',
    download_tool_failure: '本地下载工具需要处理',
  };
  const local = job.bvid ? deps.state.getCompletedLocalDownload(String(job.bvid)) : null;
  const strictMediaTarget = payload.qualityStrict === true || payload.qualityEncodingOverride?.strict === true;
  return {
    id: `download.${job.id}`,
    kind,
    severity: recoveryIssueSeverity(kind),
    title: strictMediaTarget && payload.qualityFailure ? '严格媒体目标未满足' : (titleByKind[kind] || titleByKind.download_retry_exhausted),
    summary: sanitizeUploadText(stored.summary || job.lastError || '下载任务已安全暂停，等待选择恢复方式。', 300),
    protectedFacts: [
      '收藏来源和远端目标保持不变',
      local ? '已完成的本地文件和下载清单仍保留' : '已有下载进度不会因打开待处理面板而删除',
      '暂缓或换账号不会把视频标记为永久不可用',
    ],
    recommendedAction: actions[0],
    availableActions: actions,
    bvid: job.bvid || undefined,
    videoTitle: meta?.title || undefined,
    upperName: meta?.upperName || undefined,
    userId: currentDownloadUserId || undefined,
    requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality || undefined,
    actualQualities: payload.qualityFailure?.actualQualities,
    qualityMismatch: payload.qualityFailure?.qualityMismatch,
    requestedEncoding: payload.qualityFailure?.requestedEncoding || payload.qualityEncodingOverride?.priority?.[0],
    actualEncodings: payload.qualityFailure?.actualEncodings,
    encodingMismatch: payload.qualityFailure?.encodingMismatch,
    verifiedPages: payload.qualityFailure?.verifiedPages,
    occurredAt: Number(stored.occurredAt || job.updatedAt || job.createdAt || deps.now()),
    safeDiagnostic: JSON.stringify({
      issue: kind,
      category,
      task: job.kind,
      bvid: job.bvid || undefined,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      downloadUserId: currentDownloadUserId || undefined,
      alternateAccountCount: alternateAccounts.length,
      localDownloadRetained: Boolean(local),
      strictMediaTarget,
      requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality,
      actualQualities: payload.qualityFailure?.actualQualities,
      requestedEncoding: payload.qualityFailure?.requestedEncoding || payload.qualityEncodingOverride?.priority?.[0],
      actualEncodings: payload.qualityFailure?.actualEncodings,
    }, null, 2),
    disposition: 'action_required',
  };
}

function qualityArtifactRetryEligibility(
  deps: RecoveryIssueProjectionDependencies,
  job: PersistentJobRecord,
  evidenceField: 'encodingEligible' | 'qualityEligible',
  label: string,
) {
  if (!job || !['quality_download', 'quality_upload'].includes(job.kind)) return { eligible: false, reason: `当前阶段不能安全地更换${label}` };
  const payload = payloadOf(job);
  if (payload.qualityFailure?.[evidenceField] !== true) return { eligible: false, reason: `失败证据不能明确指向${label}` };
  if ((Array.isArray(payload.backupFiles) && payload.backupFiles.length > 0)
    || (Array.isArray(payload.finalFiles) && payload.finalFiles.length > 0)) return { eligible: false, reason: '远端正式替换已经开始，只能恢复原阶段' };
  const bvid = String(job.bvid || payload.bvid || '');
  const allTargets = qualityTargetsFromPayload(payload);
  const selectedTarget = resolveQualityUpgradeTarget(job, payload, allTargets);
  const targets: QualityUpgradeTarget[] = job.kind === 'quality_upload' && selectedTarget ? [selectedTarget] : allTargets;
  if (!bvid || targets.length === 0) return { eligible: false, reason: '画质重调目标不完整' };
  for (const target of targets) {
    if (deps.state.getQualityUpgradeOperation(target.userId, target.mediaId, bvid)) return { eligible: false, reason: '远端替换证明已经建立，只能恢复原阶段' };
  }
  return { eligible: true, reason: '旧归档尚未进入替换阶段' };
}

export function createRecoveryIssueProjection(deps: RecoveryIssueProjectionDependencies) {
  const getRecoveryIssues = () => {
    const issues: RecoveryIssue[] = [
      ...deps.manualRecoveryJobs().map(job => buildUploadRecoveryIssue(deps, job)),
      ...deps.manualDownloadRecoveryJobs().map(job => buildDownloadRecoveryIssue(deps, job)),
    ];
    const qualityJobs = new Map<string, PersistentJobRecord>();
    for (const job of deps.jobs.listFailed(['quality_download', 'quality_upload', 'quality_replace', 'quality_cleanup'], 1_000)) qualityJobs.set(job.id, job);
    for (const job of deps.jobs.listManualRecovery(['quality_download', 'quality_upload', 'quality_replace', 'quality_cleanup'], 1_000)) qualityJobs.set(job.id, job);
    for (const job of qualityJobs.values()) {
      const payload = payloadOf(job);
      const storedMeta = (!payload.videoTitle || !payload.upperName) && job.bvid ? deps.state.getVideoMeta(String(job.bvid)) : null;
      const encodingEligibility = qualityArtifactRetryEligibility(deps, job, 'encodingEligible', '编码或单文件限制');
      const qualityEligibility = qualityArtifactRetryEligibility(deps, job, 'qualityEligible', '画质档位');
      const actions = planRecoveryActions({
        domain: 'quality', kind: 'quality_failed', jobKind: job.kind,
        qualityEncodingEligible: encodingEligibility.eligible,
        qualityQualityEligible: qualityEligibility.eligible,
        qualityChoices: qualityRetryChoices(payload.qualityProfile?.quality),
      });
      issues.push({
        id: `quality.${job.id}`, kind: 'quality_failed', severity: 'warning', title: '画质重调已暂停',
        summary: sanitizeUploadText(job.lastError || payload.error || '画质重调任务失败。', 300),
        protectedFacts: ['失败流程不会自动删除正式旧路径', '失败任务不会进入普通播放来源', '重试会重新校验当前阶段'],
        recommendedAction: actions[0], availableActions: actions,
        bvid: job.bvid || payload.bvid, videoTitle: payload.videoTitle || storedMeta?.title || undefined,
        upperName: payload.upperName || storedMeta?.upperName || undefined, userId: job.userId || payload.userId,
        mediaId: job.mediaId ?? payload.mediaId, folderTitle: payload.folderTitle || payload.target?.folderTitle,
        requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality,
        actualQualities: payload.qualityFailure?.actualQualities, qualityMismatch: payload.qualityFailure?.qualityMismatch,
        requestedEncoding: payload.qualityFailure?.requestedEncoding || payload.qualityEncodingOverride?.priority?.[0] || payload.qualityProfile?.encoding,
        actualEncodings: payload.qualityFailure?.actualEncodings, encodingMismatch: payload.qualityFailure?.encodingMismatch,
        verifiedPages: payload.qualityFailure?.verifiedPages, occurredAt: job.updatedAt || job.createdAt || deps.now(),
        safeDiagnostic: JSON.stringify({
          issue: 'quality_failed', stage: job.kind, bvid: job.bvid, attempts: job.attempts,
          failureCategory: payload.qualityFailure?.category,
          encodingRetryEligible: encodingEligibility.eligible, encodingRetryReason: encodingEligibility.reason,
          qualityRetryEligible: qualityEligibility.eligible, qualityRetryReason: qualityEligibility.reason,
          requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality,
          actualQualities: payload.qualityFailure?.actualQualities,
        }, null, 2), disposition: 'action_required',
      });
    }
    const uploadHealth = deps.uploadCircuit.getSnapshot();
    if (uploadHealth.state !== 'closed' && ['auth', 'deterministic'].includes(String(uploadHealth.category || ''))) {
      const action: RecoveryIssueAction = { id: 'open_settings', label: '检查存储设置', description: '打开设置页核对 AList / OpenList 地址和认证信息。' };
      issues.unshift({
        id: 'storage-backend', kind: 'storage_backend', severity: 'danger',
        title: uploadHealth.category === 'auth' ? '存储认证失败' : '存储配置需要检查',
        summary: sanitizeUploadText(uploadHealth.reason || 'AList / OpenList 暂不可用。', 300),
        protectedFacts: ['下载队列已暂停，避免继续占用本地空间', '认证失败不会自动清理待补传本地文件', '系统不会在认证失败时重复写入远端'],
        recommendedAction: action, availableActions: [action], occurredAt: uploadHealth.openedAt || deps.now(),
        nextAutomaticCheckAt: uploadHealth.retryAt,
        safeDiagnostic: JSON.stringify({ issue: 'storage_backend', category: uploadHealth.category, state: uploadHealth.state, retryAt: uploadHealth.retryAt }, null, 2),
        disposition: 'action_required',
      });
    }
    issues.sort((left, right) => {
      const weight = { danger: 0, warning: 1, info: 2 };
      return weight[left.severity] - weight[right.severity] || right.occurredAt - left.occurredAt || left.id.localeCompare(right.id);
    });
    return issues;
  };
  return {
    getRecoveryIssues,
    getRecoveryIssueSnapshot() {
      const allIssues = getRecoveryIssues();
      const backgroundRecoveries = allIssues.filter(issue => issue.disposition === 'background');
      const actionRequiredIssues = allIssues.filter(issue => issue.disposition === 'action_required');
      const intentionalConfirmations = allIssues.filter(issue => issue.disposition === 'intentional_confirmation');
      const issues = [...actionRequiredIssues, ...intentionalConfirmations];
      return {
        issues, backgroundRecoveries, actionRequiredIssues, intentionalConfirmations,
        issueSummary: {
          total: actionRequiredIssues.length,
          danger: actionRequiredIssues.filter(issue => issue.severity === 'danger').length,
          warning: actionRequiredIssues.filter(issue => issue.severity === 'warning').length,
          info: actionRequiredIssues.filter(issue => issue.severity === 'info').length,
          actionRequired: actionRequiredIssues.length,
          intentional: intentionalConfirmations.length,
          background: backgroundRecoveries.length,
        },
      };
    },
    qualityEncodingRetryEligibility(job: PersistentJobRecord) {
      return qualityArtifactRetryEligibility(deps, job, 'encodingEligible', '编码或单文件限制');
    },
    qualityQualityRetryEligibility(job: PersistentJobRecord) {
      return qualityArtifactRetryEligibility(deps, job, 'qualityEligible', '画质档位');
    },
    qualityRetryChoices,
  };
}
