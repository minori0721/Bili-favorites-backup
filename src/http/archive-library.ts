import express, { Router } from 'express';
import type { ArchiveLibraryPort } from '../archive-library-service.js';
import { ArchiveLibraryQueryError, type ArchiveLibraryFilter, type ArchiveLibraryQuery, type ArchiveLibraryScope, type ArchiveLibrarySearchScope, type ArchiveLibrarySort } from '../archive-library.js';

function parseArchiveLibraryQuery(query: Record<string, unknown>): Partial<ArchiveLibraryQuery> {
  const pageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new ArchiveLibraryQueryError("Invalid archive page size");
  }
  let mediaId: number | undefined;
  if (query.mediaId !== undefined && query.mediaId !== "") mediaId = Number(query.mediaId);
  return {
    scope: String(query.scope || "global") as ArchiveLibraryScope,
    userId: String(query.userId || "") || undefined,
    mediaId,
    query: String(query.q || ""),
    searchScope: String(query.searchScope || "current") as ArchiveLibrarySearchScope,
    filter: String(query.filter || "all") as ArchiveLibraryFilter,
    sort: String(query.sort || "context") as ArchiveLibrarySort,
    cursor: String(query.cursor || "") || undefined,
    pageSize,
  };
}

function sendArchiveLibraryError(res: express.Response, error: unknown) {
  if (error instanceof ArchiveLibraryQueryError) {
    res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return;
  }
  throw error;
}

export function createArchiveLibraryRouter(service: ArchiveLibraryPort) {
  const router = Router();
  router.get("/api/archive-library/navigation", (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      success: true,
      data: service.navigation(),
    });
  });

  router.get("/api/archive-library/items", (req, res) => {
    try {
      const input = parseArchiveLibraryQuery(req.query as Record<string, unknown>);
      const data = service.items(input);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ success: true, data });
    } catch (error) {
      sendArchiveLibraryError(res, error);
    }
  });

  router.get("/api/archive-library/items/:bvid", (req, res) => {
    try {
      const bvid = String(req.params.bvid || "").trim();
      if (!bvid || bvid.length > 64 || /[\\/\0]/.test(bvid)) {
        throw new ArchiveLibraryQueryError("Invalid archive BVID");
      }
      const input = parseArchiveLibraryQuery(req.query as Record<string, unknown>);
      const data = service.detail(input, bvid);
      if (!data) {
        res.status(404).json({ success: false, message: "Archive item not found" });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ success: true, data });
    } catch (error) {
      sendArchiveLibraryError(res, error);
    }
  });



  router.get("/api/archive-library/playback-queue", (req, res) => {
    try {
      const input = parseArchiveLibraryQuery(req.query as Record<string, unknown>);
      const focusBvid = String(req.query.focusBvid || "").trim();
      const page = req.query.page === undefined ? undefined : Number(req.query.page);
      const cursor = String(req.query.cursor || "").trim();
      const direction = String(req.query.direction || "after");
      if ((focusBvid && (focusBvid.length > 64 || /[\\/\0]/.test(focusBvid)))
        || (page !== undefined && (!Number.isInteger(page) || page < 1))
        || (cursor.length > 4096)
        || !["after", "before"].includes(direction)
        || (cursor && page === undefined)) {
        throw new ArchiveLibraryQueryError("Invalid archive playback request");
      }
      const data = service.playbackQueue(input, {
        focusBvid: focusBvid || undefined,
        page,
        pageSize: input.pageSize,
        cursor: cursor || undefined,
        direction: direction as "after" | "before",
      });
      if (!data) {
        res.status(404).json({ success: false, code: "PLAYBACK_NOT_AVAILABLE", message: "该归档当前不可播放" });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ success: true, data });
    } catch (error) {
      sendArchiveLibraryError(res, error);
    }
  });

  router.get("/api/archive-library/playback-search", (req, res) => {
    try {
      const input = parseArchiveLibraryQuery(req.query as Record<string, unknown>);
      const query = String(req.query.queueQ || "").trim();
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      if (!query || query.length > 80 || query.includes("\0") || !Number.isInteger(page) || page < 1) {
        throw new ArchiveLibraryQueryError("Invalid archive playback search");
      }
      const data = service.playbackSearch(input, {
        query,
        page,
        pageSize: input.pageSize,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ success: true, data });
    } catch (error) {
      sendArchiveLibraryError(res, error);
    }
  });

  return router;
}
