interface SourceTarget { userId?: unknown; mediaId?: unknown; }
export interface DeletionScope extends SourceTarget { scope: string; bvid?: string; }
export function matchesDeletedSource(target: DeletionScope | null, source: SourceTarget, bvid: unknown) {
  return Boolean(target?.scope === 'source'
    && String(target.userId || '') === String(source.userId || '')
    && Number(target.mediaId || 0) === Number(source.mediaId || 0)
    && String(target.bvid || '') === String(bvid || ''));
}
export function sourceAdmissionBlocked(locked: boolean, scope: DeletionScope | null,
  task: SourceTarget & {bvid?: string; targets?: SourceTarget[]; target?: SourceTarget},
  control?: SourceTarget & {bvid?: string; targets?: SourceTarget[]; target?: SourceTarget}) {
  if (locked) return true;
  if (scope?.scope !== 'source') return false;
  const bvid = task.bvid || control?.bvid || '';
  if (!bvid || bvid !== scope.bvid) return false;
  const candidates = [...(task.targets || []), ...(control?.targets || [])];
  return candidates.some(candidate => matchesDeletedSource(scope, candidate, bvid))
    || matchesDeletedSource(scope, candidates[0] || task.target || control?.target || task, bvid);
}
