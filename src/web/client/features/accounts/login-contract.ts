import { isRecord } from '../../../../shared/api/value.js';

export function parseLoginStart(value: unknown) {
  if (!isRecord(value) || typeof value.loginId !== 'string' || !value.loginId
    || typeof value.qrDataUrl !== 'string' || !/^data:image\/(?:png|gif|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value.qrDataUrl)) {
    throw new Error('二维码响应格式错误');
  }
  return { loginId: value.loginId, qrDataUrl: value.qrDataUrl };
}

export function parseLoginStatus(value: unknown) {
  if (!isRecord(value) || !['pending', 'completed', 'error'].includes(String(value.status))
    || (value.message !== undefined && typeof value.message !== 'string')) throw new Error('登录状态响应格式错误');
  return { status: value.status, message: typeof value.message === 'string' ? value.message : undefined };
}
