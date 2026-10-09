import type { UpSubscription, UpSubmission, UpVideoDecision } from '../shared/up-subscriptions.js';

/** Explicit exclusions survive rule changes; discovery checkpoints do not depend on selection. */
export function shouldArchiveUpVideo(
  subscription: Pick<UpSubscription, 'enabled' | 'removed' | 'mode' | 'since'>,
  item: Pick<UpSubmission, 'publishedAt'>,
  decision: UpVideoDecision,
  globallyExcluded: boolean,
) {
  if (!subscription.enabled || subscription.removed || globallyExcluded || decision === 'exclude') return false;
  if (decision === 'include') return true;
  if (subscription.mode === 'selected') return false;
  if (subscription.mode === 'all') return true;
  return subscription.since !== null && item.publishedAt >= subscription.since;
}

export function parseUpUid(value: unknown): number {
  const invalid=(message:string):never=>{throw Object.assign(new Error(message),{statusCode:400});};
  if (typeof value !== 'string' && typeof value !== 'number') return invalid('请输入有效的 UID 或 UP 主页链接');
  const input = String(value).trim();
  let identity = input;
  if (input.startsWith('http://') || input.startsWith('https://')) {
    let url:URL;try{url=new URL(input);}catch{return invalid('UP 主页链接无效');}
    if (url.hostname !== 'space.bilibili.com' || url.username || url.password) return invalid('请使用 space.bilibili.com 的 UP 主页链接');
    identity = url.pathname.split('/').filter(Boolean)[0] || '';
  }
  if (!/^[1-9]\d{0,15}$/.test(identity)) return invalid('UP 的 UID 格式无效');
  const uid = Number(identity);
  if (!Number.isSafeInteger(uid)) return invalid('UP 的 UID 超出有效范围');
  return uid;
}
