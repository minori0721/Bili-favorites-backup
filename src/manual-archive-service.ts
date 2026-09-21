import { normalizeBBDownEncodingPriority, type AppConfig } from './config.js';
import { isSelectableBilibiliQuality } from './media-metadata.js';
import { normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig } from './quality-artifact.js';
import type { OnlineContentService } from './online-content.js';
import type { UserStore } from './users.js';
import type { createManualArchive } from './scheduler/manual-archive.js';
export function createManualArchiveService(deps: {
  users: Pick<UserStore, 'getById'>;
  content: Pick<OnlineContentService, 'getItem' | 'promoteCover'>;
  config(): AppConfig;
  enqueue: ReturnType<typeof createManualArchive>['enqueue'];
  coverFailure(error: unknown): void;
}) {
  return {async execute(input: {userId?: unknown; token?: unknown; quality?: unknown; encoding?: unknown}) {

  const userId = String(input.userId || "").trim();
  const token = String(input.token || "").trim();
  const user = deps.users.getById(userId);
  const reference = deps.content.getItem(token);
  const bvid = reference?.item.bvid;
  if (!user || !user.enabled || !reference || reference.userId !== userId || !bvid) {
    return {status: 400, body: { success: false, message: "在线条目已过期，请重新打开当前页面" }};
  }
  const item = reference.item;
  const requestedQuality = String(input.quality || "").trim().toUpperCase();
  const requestedEncoding = String(input.encoding || "").trim().toUpperCase();
  const allowedEncodings = new Set(["HEVC", "AVC", "AV1"]);
  if ((requestedQuality && !isSelectableBilibiliQuality(requestedQuality))
    || (requestedEncoding && !allowedEncodings.has(requestedEncoding))) {
    return {status: 400, body: { success: false, message: "手动归档的画质或编码选项无效" }};
  }
  const exactRequest = Boolean(requestedQuality || requestedEncoding);
  const currentProfile = qualityArtifactProfileFromConfig(deps.config());
  const qualityProfile = exactRequest
    ? normalizeQualityArtifactProfile({
      ...currentProfile,
      quality: requestedQuality || currentProfile.quality,
      encoding: requestedEncoding || currentProfile.encoding,
    })
    : undefined;
  const qualityEncodingOverride = requestedEncoding
    ? {
      generation: 1,
      priority: normalizeBBDownEncodingPriority(undefined, requestedEncoding),
      strict: true,
    }
    : undefined;
  const result = deps.enqueue(userId, {
    bvid,
    title: item.title,
    upperName: item.upperName || "Unknown",
    upperMid: item.upperMid,
    cover: item.cover,
    qualityProfile,
    qualityStrict: Boolean(requestedQuality),
    qualityEncodingOverride,
  });
  await deps.content.promoteCover(token).catch(error => deps.coverFailure(error));
  return {status: result.status === "queued" ? 202 : 200, body: { success: true, data: result }};
}};
}
