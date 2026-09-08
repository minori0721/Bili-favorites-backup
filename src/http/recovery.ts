import { Router } from 'express';
import type { RouteBoundary } from './route-boundary.js';
import type { RecoveryIssueActionId } from '../recovery-policy.js';
import type { RecoveryActionOptions, RecoveryActionResult } from '../scheduler/recovery-action-contracts.js';
import type { createUploadResumeService } from '../scheduler/upload-resume.js';
interface Dependencies {
  boundary: RouteBoundary;
  recoverUploadJob: ReturnType<typeof createUploadResumeService>['recover'];
  resolveRecoveryIssue(id: string, action: RecoveryIssueActionId, options: RecoveryActionOptions): Promise<RecoveryActionResult>;
}
export function createRecoveryRouter(deps: Dependencies) {
  const router = Router();
router.post("/api/queue/recover", deps.boundary(async (req, res) => {
  const jobId = typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
  if (!jobId || jobId.length > 128) {
    res.status(400).json({ success: false, message: "Invalid recovery job id" });
    return;
  }
  const result = await deps.recoverUploadJob(jobId, req.body?.allowReupload === true);
  if (!result.ok) {
    res.status(result.status).json({ success: false, message: result.message });
    return;
  }
  res.json({
    success: true,
    data: {
      jobId: result.job.id,
      idempotent: result.idempotent,
      ...(result.resolved ? { resolved: result.resolved } : {}),
    },
  });
}));

router.post("/api/recovery-issues/:id/actions/:action", deps.boundary(async (req, res) => {
  const issueId = String(req.params.id || "").trim();
  const action = String(req.params.action || "").trim();
  const allowedActions: readonly RecoveryIssueActionId[] = [
    "recheck",
    "reupload",
    "create_candidate",
    "redownload",
    "redownload_with_encoding",
    "redownload_with_quality",
    "retry_download",
    "retry_download_with_account",
    "defer_download",
    "retry_quality",
    "retry_quality_with_encoding",
    "retry_quality_with_quality",
    "abandon_attempt",
    "keep_existing",
    "use_candidate",
  ];
  const selectedAction = allowedActions.find(value => value === action);
  if (!issueId || issueId.length > 160 || !selectedAction) {
    res.status(400).json({ success: false, message: "Invalid recovery issue action" });
    return;
  }
  const result = await deps.resolveRecoveryIssue(issueId, selectedAction, req.body || {});
  if (!result.ok) {
    res.status(result.status).json({ success: false, message: result.message });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ success: true, data: { issues: result.issues } });
}));

  return router;
}
