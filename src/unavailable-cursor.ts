import type { UnavailablePageCursor, UnavailablePageFilter } from './database.js';
export function parseUnavailableCursor(value: unknown, filter: UnavailablePageFilter):
  {ok: true; cursor: UnavailablePageCursor | null; legacyOffset: number} | {ok: false; message: string} {
  if (value === undefined || value === null || value === '') return {ok: true, cursor: null, legacyOffset: 0};
  const invalid = {ok: false as const, message: '下架清单分页游标无效，请重新加载'};
  if (typeof value !== 'string') return invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch {return invalid;}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid;
  const fields = Object.fromEntries(Object.entries(parsed));
  if (fields.version === 2) {
    if (fields.filter !== filter) return invalid;
    if ((typeof fields.lastSeenAt !== 'number' && typeof fields.lastSeenAt !== 'string')
      || (typeof fields.mediaId !== 'number' && typeof fields.mediaId !== 'string')
      || fields.lastSeenAt === '' || fields.mediaId === '') return invalid;
    const lastSeenAt = Number(fields.lastSeenAt), mediaId = Number(fields.mediaId);
    const bvid = fields.bvid;
    if (!Number.isFinite(lastSeenAt) || lastSeenAt < 0 || typeof bvid !== 'string' || !bvid || bvid.length > 64 || !Number.isInteger(mediaId) || mediaId < 1) return invalid;
    return {ok: true, cursor: {lastSeenAt, mediaId, bvid}, legacyOffset: 0};
  }
  if (fields.version !== undefined && fields.version !== 1) return invalid;
  if ((typeof fields.offset !== 'number' && typeof fields.offset !== 'string') || fields.offset === '') return invalid;
  const offset = Number(fields.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return invalid;
  return {ok: true, cursor: null, legacyOffset: offset};
}
export function encodeUnavailableCursor(cursor: UnavailablePageCursor, filter: UnavailablePageFilter) {
  return Buffer.from(JSON.stringify({version: 2, filter, ...cursor}), 'utf8').toString('base64url');
}
