import { BiliRiskOrLoginError, BiliFavoriteFolderResponseError } from './bili.js';
export function getBiliListErrorMessage(error: unknown) {
  if (error instanceof BiliRiskOrLoginError) {
    return "B 站返回了风控/登录异常响应，请稍后重试；如持续失败请重新扫码登录。";
  }
  if (error instanceof BiliFavoriteFolderResponseError) {
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : "Failed to list items";
}
