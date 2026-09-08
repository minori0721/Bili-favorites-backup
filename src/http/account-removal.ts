import { Router } from 'express';
import type { BiliUser } from '../users.js';
import type { AccountRemovalRequest, executeAccountRemoval } from '../account-removal.js';
import type { ArchiveDeletionService } from '../archive-deletion.js';
import type { RouteBoundary } from './route-boundary.js';

export function createAccountRemovalRouter(deps: {
  user(id: string): BiliUser | null;
  preview: ArchiveDeletionService['previewAccount'];
  remove(id: string, body: AccountRemovalRequest): ReturnType<typeof executeAccountRemoval>;
  boundary: RouteBoundary;
}) {
  const router = Router();
  router.post("/api/users/:id/removal-preview", (req, res) => {
    const user = deps.user(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data: deps.preview(user) });
  });

  router.delete("/api/users/:id", deps.boundary(async (req, res) => {
    const result = await deps.remove(String(req.params.id || ""), req.body || {});
    if (result.operation) {
      res.status(202).json({ success: true, data: { ...result.retired, operation: result.operation } });
      return;
    }
    res.json({ success: true, data: result.retired });
  }));


  return router;
}
