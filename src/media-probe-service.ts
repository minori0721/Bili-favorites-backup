import { MediaProbeBusyError, type MediaProbeService } from './media-probe.js';
import { isSelectableBilibiliQuality } from './media-metadata.js';
import type { UserStore } from './users.js';
export function createMediaProbeRequests(deps: {users: Pick<UserStore, 'getById'>; probe: Pick<MediaProbeService, 'start' | 'get'>}) {
  return {get: (id: string) => deps.probe.get(id), start(input: {userId?: unknown; bvid?: unknown; quality?: unknown; encoding?: unknown; strict?: unknown}) {

  const userId = String(input.userId || "").trim();
  const bvid = String(input.bvid || "").trim();
  const user = deps.users.getById(userId);
  if (!user || !user.enabled || !/^BV[0-9A-Za-z]+$/.test(bvid)) {
    return {status: 400, body: { success: false, message: "媒体探测参数无效" }};
  }
  const requestedQuality = String(input.quality || "").trim().toUpperCase();
  const requestedEncoding = String(input.encoding || "").trim().toUpperCase();
  if ((requestedQuality && !isSelectableBilibiliQuality(requestedQuality))
    || (requestedEncoding && !["HEVC", "AVC", "AV1"].includes(requestedEncoding))) {
    return {status: 400, body: { success: false, message: "媒体探测的画质或编码无效" }};
  }
  let result;
  try {
    result = deps.probe.start(user, bvid, {
      quality: requestedQuality || undefined,
      encoding: requestedEncoding === "HEVC" || requestedEncoding === "AVC" || requestedEncoding === "AV1" ? requestedEncoding : undefined,
      strict: Boolean(input.strict || requestedQuality || requestedEncoding),
    });
  } catch (error) {
    if (error instanceof MediaProbeBusyError) {
      return {status: 409, body: { success: false, code: error.code, message: error.message }};
    }
    throw error;
  }
  return {status: 202, body: { success: true, data: { probeId: result.probeId, status: result.status, bvid } }};
}};
}
