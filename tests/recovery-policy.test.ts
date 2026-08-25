import assert from "node:assert/strict";
import test from "node:test";
import {
  planRecoveryActions,
  recordRemoteVisibilityObservation,
  recoveryIssueDisposition,
} from "../src/recovery-policy.js";

test("remote visibility becomes actionable only after independent observations over 30 minutes", () => {
  const start = Date.parse("2026-08-24T00:00:00.000Z");
  const first = recordRemoteVisibilityObservation(null, start);
  const duplicate = recordRemoteVisibilityObservation(first, start + 60_000);
  const second = recordRemoteVisibilityObservation(duplicate, start + 6 * 60_000);
  const third = recordRemoteVisibilityObservation(second, start + 31 * 60_000);

  assert.equal(first.consecutiveObservations, 1);
  assert.equal(duplicate.consecutiveObservations, 1);
  assert.equal(second.consecutiveObservations, 2);
  assert.equal(third.consecutiveObservations, 3);
  assert.equal(third.actionRequired, true);
  assert.equal(recoveryIssueDisposition("remote_visibility_timeout"), "background");
  assert.equal(recoveryIssueDisposition("remote_visibility_stalled"), "action_required");
});

test("candidate action is offered only after the complete local group is eligible", () => {
  const blocked = planRecoveryActions({
    domain: "upload",
    kind: "remote_size_conflict",
    localStatus: "available",
    candidateEligible: false,
  });
  const allowed = planRecoveryActions({
    domain: "upload",
    kind: "remote_size_conflict",
    localStatus: "available",
    candidateEligible: true,
  });

  assert.deepEqual(blocked.map((action) => action.id), ["recheck"]);
  assert.deepEqual(allowed.map((action) => action.id), ["create_candidate", "recheck"]);
});

test("download and quality policies expose bounded recovery choices", () => {
  const accounts = [{ value: "u2", label: "备用账号" }];
  assert.deepEqual(planRecoveryActions({
    domain: "download",
    kind: "download_account_required",
    downloadCategory: "account",
    alternateAccounts: accounts,
  }).map((action) => action.id), ["retry_download_with_account", "retry_download", "defer_download"]);

  const combinedDownload = planRecoveryActions({
    domain: "download",
    kind: "download_tool_failure",
    downloadQualityEligible: true,
    downloadQualityChoices: [{ value: "1080P", label: "1080P" }],
    downloadEncodingEligible: true,
  });
  assert.deepEqual(combinedDownload.map((action) => action.id), ["redownload_with_encoding", "retry_download", "defer_download"]);
  assert.deepEqual(combinedDownload[0].mediaProfile, { quality: true, encoding: true });

  assert.deepEqual(planRecoveryActions({
    domain: "quality",
    kind: "quality_failed",
    qualityEncodingEligible: true,
  }).map((action) => action.id), ["retry_quality_with_encoding", "retry_quality"]);

  const combinedQuality = planRecoveryActions({
    domain: "quality",
    kind: "quality_failed",
    qualityQualityEligible: true,
    qualityChoices: [{ value: "4K", label: "4K" }],
    qualityEncodingEligible: true,
  });
  assert.deepEqual(combinedQuality.map((action) => action.id), ["retry_quality_with_encoding", "retry_quality"]);
  assert.deepEqual(combinedQuality[0].mediaProfile, { quality: true, encoding: true });

  assert.deepEqual(planRecoveryActions({
    domain: "quality",
    kind: "quality_failed",
    qualityEncodingEligible: false,
  }).map((action) => action.id), ["retry_quality"]);
});
