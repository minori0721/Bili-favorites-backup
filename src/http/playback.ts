import { Router } from 'express';
import { actualQualityLabel, validBrowserMediaMetadata } from '../media-metadata.js';
import { PlaybackHttpError } from '../playback.js';
import { MANUAL_ARCHIVE_MEDIA_ID } from '../state.js';
import type { createPlaybackService } from '../playback-service.js';
import type { RouteBoundary } from './route-boundary.js';
function isPlaybackMediaId(mediaId: number) {
  return Number.isInteger(mediaId) && (mediaId >= 1 || mediaId === MANUAL_ARCHIVE_MEDIA_ID);
}
export function createPlaybackRouter(deps: {service: ReturnType<typeof createPlaybackService>; boundary: RouteBoundary}) {
const router = Router();
router.get("/api/users/:id/favorites/:mediaId/playback-queue", (req, res) => {
  const user = deps.service.getUser(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaId = Number(req.params.mediaId);
  if (!isPlaybackMediaId(mediaId)) {
    res.status(400).json({ success: false, message: "Invalid mediaId" });
    return;
  }
  const page = req.query.page === undefined ? undefined : Number(req.query.page);
  const pageSize = req.query.pageSize === undefined ? 30 : Number(req.query.pageSize);
  if ((page !== undefined && (!Number.isInteger(page) || page < 1))
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    res.status(400).json({ success: false, message: "Invalid playback pagination" });
    return;
  }
  const focusBvid = String(req.query.focusBvid || "").trim();
  if (focusBvid.length > 64 || /[\\/\0]/.test(focusBvid)) {
    res.status(400).json({ success: false, message: "Invalid focusBvid" });
    return;
  }
  const data = deps.service.queue(user.id, mediaId, {
    focusBvid: focusBvid || undefined,
    page,
    pageSize,
  });
  if (!data) {
    res.status(404).json({ success: false, code: "PLAYBACK_NOT_AVAILABLE", message: "该归档当前不可播放" });
    return;
  }
  res.json({ success: true, data });
});

router.get("/api/users/:id/favorites/:mediaId/playback-search", (req, res) => {
  const user = deps.service.getUser(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaId = Number(req.params.mediaId);
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const pageSize = req.query.pageSize === undefined ? 50 : Number(req.query.pageSize);
  const query = String(req.query.q || "").trim();
  if (!isPlaybackMediaId(mediaId)
    || !Number.isInteger(page) || page < 1
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50
    || !query || query.length > 80 || query.includes("\0")) {
    res.status(400).json({ success: false, message: "Invalid playback search" });
    return;
  }
  const data = deps.service.search(user.id, mediaId, {
    query,
    page,
    pageSize,
  });
  res.json({ success: true, data });
});

function playbackOwnerExists(userId: string) {
  return deps.service.ownerExists(userId);
}

router.put("/api/users/:id/favorites/:mediaId/playback/files/:fileId/media-metadata", (req, res) => {
  const userId = String(req.params.id || "");
  const mediaId = Number(req.params.mediaId);
  const fileId = Number(req.params.fileId);
  const fingerprint = String(req.body?.fingerprint || "");
  const metadata = validBrowserMediaMetadata(req.body || {});
  if (!playbackOwnerExists(userId)) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  if (!isPlaybackMediaId(mediaId) || !Number.isInteger(fileId) || fileId < 1
    || !metadata || !fingerprint || fingerprint.length > 160 || fingerprint.includes("\0")) {
    res.status(400).json({ success: false, message: "Invalid playback media metadata" });
    return;
  }
  try {
    const result = deps.service.updateMetadata(userId, mediaId, fileId, { fingerprint, ...metadata });
    if (!result) {
      res.status(409).json({ success: false, code: "PLAYBACK_FILE_CHANGED", message: "播放文件记录已变化，请重新打开播放器" });
      return;
    }
    res.json({
      success: true,
      data: {
        ...result,
        actualQuality: actualQualityLabel(result.mediaMetadata),
      },
    });
  } catch (error) {
    if (error instanceof PlaybackHttpError) {
      res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      return;
    }
    throw error;
  }
});

router.get("/api/users/:id/favorites/:mediaId/playback/delivery/:attemptId", (req, res) => {
  const userId = String(req.params.id || "");
  const mediaId = Number(req.params.mediaId);
  const attemptId = String(req.params.attemptId || "");
  if (!playbackOwnerExists(userId)) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  if (!isPlaybackMediaId(mediaId) || !/^[0-9a-f]{32}$/i.test(attemptId)) {
    res.status(400).json({ success: false, message: "Invalid playback delivery attempt" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ success: true, data: deps.service.deliveryStatus(req.sessionID, userId, mediaId, attemptId) });
});

router.get("/api/users/:id/favorites/:mediaId/playback/files/:fileId/open-in-alist", (req, res) => {
  const userId = String(req.params.id || "");
  const mediaId = Number(req.params.mediaId);
  const fileId = Number(req.params.fileId);
  if (!playbackOwnerExists(userId)) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  if (!isPlaybackMediaId(mediaId) || !Number.isInteger(fileId) || fileId < 1) {
    res.status(400).json({ success: false, message: "Invalid playback file" });
    return;
  }
  try {
    const location = deps.service.alistLocation(userId, mediaId, fileId);
    res.status(302);
    res.setHeader("Location", location);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Length", "0");
    res.end();
  } catch (error) {
    if (error instanceof PlaybackHttpError) {
      res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      return;
    }
    throw error;
  }
});

const playbackFileHandler = deps.boundary(async (req, res) => {
  const userId = String(req.params.id || "");
  if (!playbackOwnerExists(userId)) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaId = Number(req.params.mediaId);
  const fileId = Number(req.params.fileId);
  if (!isPlaybackMediaId(mediaId) || !Number.isInteger(fileId) || fileId < 1) {
    res.status(400).json({ success: false, message: "Invalid playback file" });
    return;
  }
  const delivery = req.query.delivery;
  const attemptId = req.query.attempt === undefined ? undefined : String(req.query.attempt);
  if (delivery !== undefined && delivery !== "proxy") {
    res.status(400).json({ success: false, message: "Invalid playback delivery mode" });
    return;
  }
  if (attemptId !== undefined && !/^[0-9a-f]{32}$/i.test(attemptId)) {
    res.status(400).json({ success: false, message: "Invalid playback delivery attempt" });
    return;
  }
  try {
    await deps.service.stream(req, res, {
      userId,
      mediaId,
      fileId,
      ownerKey: req.sessionID,
      attemptId,
      forceProxy: delivery === "proxy",
    });
  } catch (error) {
    if (error instanceof PlaybackHttpError && !res.headersSent) {
      res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      return;
    }
    throw error;
  }
});

router.get("/api/users/:id/favorites/:mediaId/playback/files/:fileId", playbackFileHandler);
router.head("/api/users/:id/favorites/:mediaId/playback/files/:fileId", playbackFileHandler);

return router;
}
