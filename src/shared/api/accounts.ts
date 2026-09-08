import { isRecord } from './value.js';

function text(record: Record<string, unknown>, key: string, fallback = '') {
  const value = record[key];
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error('账号字段格式错误：' + key);
  return value;
}
function count(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('账号计数字段格式错误：' + key);
  return value;
}
function flag(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('账号状态格式错误：' + key);
  return value;
}
export function parseFavoriteFolders(value: unknown) {
  if (!Array.isArray(value)) throw new Error('收藏夹列表格式错误');
  return value.map(item => {
    if (!isRecord(item) || !Number.isSafeInteger(item.mediaId) || typeof item.mediaId !== 'number' || item.mediaId < 1) throw new Error('收藏夹编号格式错误');
    return {mediaId:item.mediaId,title:text(item,'title'),mediaCount:count(item,'mediaCount'),selected:flag(item,'selected')};
  });
}
export type FavoriteFolder = ReturnType<typeof parseFavoriteFolders>[number];

/** Deliberately contains only the public account list, never cookies or refresh credentials. */
export function parsePublicAccounts(value: unknown) {
  if (!Array.isArray(value)) throw new Error('账号列表格式错误');
  return value.map(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) throw new Error('账号编号格式错误');
    if (item.uid !== undefined && typeof item.uid !== 'number' && typeof item.uid !== 'string') throw new Error('账号 UID 格式错误');
    const health = item.authHealth == null ? {} : item.authHealth;
    if (!isRecord(health)) throw new Error('账号授权状态格式错误');
    return {id:item.id,uid:item.uid,name:text(item,'name'),enabled:flag(item,'enabled'),favoritesCount:count(item,'favoritesCount'),
      expiresText:text(item,'expiresText'),favorites:parseFavoriteFolders(item.favorites || []),
      authHealth:{level:text(health,'level','warn'),summary:text(health,'summary'),detail:text(health,'detail'),
        lastSuccessAt:text(health,'lastSuccessAt'),autoRefreshEnabled:flag(health,'autoRefreshEnabled'),needsManualLogin:flag(health,'needsManualLogin')},
    };
  });
}
export type PublicAccount = ReturnType<typeof parsePublicAccounts>[number];
