import { BiliResponseFormatError } from '../bili.js';
import { isRecord } from '../shared/api/value.js';
import type { UpDiscoveryPage, UpIdentity, UpSubmission } from '../shared/up-subscriptions.js';

const invalid = (field: string): never => { throw new BiliResponseFormatError(`up.${field}`); };
function identity(value: unknown, field: string): number {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : invalid(field);
}
function count(value: unknown, field: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid(field);
}
function string(value: unknown, field: string): string { return typeof value === 'string' ? value : invalid(field); }
function optionalString(value: unknown, field: string) { return value === undefined || value === null ? '' : string(value, field); }

export function decodeUpFollowings(value: unknown, page: number, pageSize: number): UpDiscoveryPage {
  if (!isRecord(value) || !Array.isArray(value.list)) return invalid('followings.list');
  const total = count(value.total, 'followings.total');
  const items = value.list.map((row, index): UpIdentity => {
    if (!isRecord(row)) return invalid(`followings.list[${index}]`);
    return { uid: identity(row.mid, `followings.list[${index}].mid`), name: string(row.uname, `followings.list[${index}].uname`),
      avatar: string(row.face, `followings.list[${index}].face`), signature: optionalString(row.sign, `followings.list[${index}].sign`), followed: true };
  });
  return { items, page, pageSize, total, hasMore: page * pageSize < total };
}

/** Search does not carry is_follow. Absence must remain unknown, never false. */
export function decodeUpSearch(value: unknown): UpDiscoveryPage {
  if (!isRecord(value) || !Array.isArray(value.result)) return invalid('search.result');
  const page = count(value.page, 'search.page');
  const pageSize = count(value.pagesize, 'search.pagesize');
  const pages = count(value.numPages, 'search.numPages');
  if (page < 1 || pageSize < 1) return invalid('search.pagination');
  const total = count(value.numResults, 'search.numResults');
  const items = value.result.map((row, index): UpIdentity => {
    if (!isRecord(row) || row.type !== 'bili_user') return invalid(`search.result[${index}]`);
    return { uid: identity(row.mid, `search.result[${index}].mid`), name: string(row.uname, `search.result[${index}].uname`),
      avatar: string(row.upic, `search.result[${index}].upic`), signature: optionalString(row.usign, `search.result[${index}].usign`) };
  });
  return { items, page, pageSize, total, hasMore: page < pages };
}

export function decodeUpCard(value: unknown, uid: number): UpIdentity {
  if (!isRecord(value) || !isRecord(value.card)) return invalid('card');
  const card = value.card;
  const mid = identity(card.mid, 'card.mid');
  if (mid !== uid) return invalid('card.mid');
  if (value.following !== undefined && typeof value.following !== 'boolean') return invalid('card.following');
  return { uid, name: string(card.name, 'card.name'), avatar: string(card.face, 'card.face'),
    signature: optionalString(card.sign, 'card.sign'), ...(typeof value.following === 'boolean' ? { followed: value.following } : {}) };
}

function duration(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const input = string(value, field);
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(input)) return invalid(field);
  const parts = input.split(':').map(Number);
  if (parts.slice(1).some(part => part > 59)) return invalid(field);
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

export function decodeUpSubmissions(value: unknown, requestedPage: number, requestedSize: number) {
  if (!isRecord(value) || !isRecord(value.page) || !isRecord(value.list) || !Array.isArray(value.list.vlist)) return invalid('submissions');
  const total = count(value.page.count, 'submissions.page.count');
  if (count(value.page.pn, 'submissions.page.pn') !== requestedPage || count(value.page.ps, 'submissions.page.ps') !== requestedSize) return invalid('submissions.pagination');
  const items = value.list.vlist.map((row, index): UpSubmission => {
    if (!isRecord(row)) return invalid(`submissions[${index}]`);
    const field = `submissions[${index}]`;
    const bvid = string(row.bvid, `${field}.bvid`);
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) return invalid(`${field}.bvid`);
    if (row.is_union_video !== undefined && row.is_union_video !== 0 && row.is_union_video !== 1 && typeof row.is_union_video !== 'boolean') return invalid(`${field}.is_union_video`);
    return { bvid, title: string(row.title, `${field}.title`), cover: string(row.pic, `${field}.pic`),
      publishedAt: count(row.created, `${field}.created`) * 1000, ownerUid: identity(row.mid, `${field}.mid`),
      ownerName: string(row.author, `${field}.author`), duration: duration(row.length, `${field}.length`),
      joint: row.is_union_video === 1 || row.is_union_video === true };
  });
  if (new Set(items.map(item => item.bvid)).size !== items.length) return invalid('submissions.duplicate');
  if (items.some((item,index)=>index>0&&item.publishedAt>items[index-1].publishedAt)) return invalid('submissions.order');
  if (items.length===0 && total>0 && (requestedPage-1)*requestedSize<total) return invalid('submissions.empty_page');
  return { items, page: requestedPage, pageSize: requestedSize, total, hasMore: requestedPage * requestedSize < total };
}
