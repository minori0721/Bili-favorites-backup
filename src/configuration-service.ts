import { parseConfigPatch, validateBBDownRuntimeConfig, type AppConfig, type ConfigStore } from './config.js';
import { normalizeRemotePath } from './remote-path.js';
import type { checkRemoteStorageReadOnly } from './storage-diagnostic.js';
import type { BiliUser } from './users.js';

export function createConfigurationService(deps: {
  config: Pick<ConfigStore, 'get' | 'update'>;
  users(): BiliUser[];
  hasPathMigration(): boolean;
  hasArchiveDeletion(): boolean;
  hasRemotePaths(): boolean;
  changed(previous: AppConfig, next: AppConfig): void;
  inspectStorage: typeof checkRemoteStorageReadOnly;
}) {
  function update(input: unknown) {
    const parsed = parseConfigPatch(input);
    if (!parsed.ok) return { status: 400, body: {success: false, message: parsed.message} };
    const patch = parsed.value;
  const previous = deps.config.get();
  const activePathMigration = deps.hasPathMigration();
  const activeArchiveDeletion = deps.hasArchiveDeletion();
  const protectedAlistKeys = ["alistUrl", "alistUsername", "alistPassword", "alistDest", "uploadLayout"] as const;
  const protectedChanged = activePathMigration && protectedAlistKeys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
    if (key === "alistDest") {
      return normalizeRemotePath(String(patch[key] || ""), { allowTrailingSlash: true })
        !== normalizeRemotePath(String(previous[key] || ""), { allowTrailingSlash: true });
    }
    return patch[key] !== previous[key];
  });
  if (protectedChanged) {
    return { status: 409, body: { success: false, code: "PATH_MIGRATION_ACTIVE", message: "归档路径迁移期间不能修改 AList / OpenList 连接、路径或目录结构" } };
  }
  const archiveDeletionProtectedChanged = activeArchiveDeletion && protectedAlistKeys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
    if (key === "alistDest") {
      return normalizeRemotePath(String(patch[key] || ""), { allowTrailingSlash: true })
        !== normalizeRemotePath(String(previous[key] || ""), { allowTrailingSlash: true });
    }
    return patch[key] !== previous[key];
  });
  if (archiveDeletionProtectedChanged) {
    return { status: 409, body: { success: false, code: "ARCHIVE_DELETION_ACTIVE", message: "归档清理期间不能修改 AList / OpenList 连接、路径或目录结构" } };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "alistDest")
    && String(patch.alistDest || "").trim() !== String(previous.alistDest || "").trim()
    && deps.hasRemotePaths()) {
    return { status: 409, body: { success: false, code: "PATH_MIGRATION_REQUIRED", message: "已有归档数据，请先使用“迁移归档路径”完成远端复制和确认" } };
  }
  const candidate = { ...previous, ...patch };
  const runtimeError = validateBBDownRuntimeConfig(candidate, deps.users());
  if (runtimeError) {
    return { status: 400, body: { success: false, message: runtimeError } };
  }
  const updated = deps.config.update(patch);
  deps.changed(previous, updated);
  return { status: 200, body: { success: true, data: updated } };
  }
  async function checkStorage(input: unknown) {
    const parsed = parseConfigPatch(input);
    if (!parsed.ok) return {status: 400, body: {success: false, message: parsed.message}};
    const allowed = new Set(['alistUrl', 'alistUsername', 'alistPassword', 'alistDest']);
    if (Object.keys(parsed.value).some(key => !allowed.has(key))) {
      return {status: 400, body: {success: false, message: '存储检查包含不支持的字段'}};
    }
    return {status: 200, body: {success: true, data: await deps.inspectStorage({...deps.config.get(), ...parsed.value})}};
  }
  return {get: () => deps.config.get(), update, checkStorage};
}
