/** Persisted payloads are mandatory objects; damaged rows must abort the export transaction. */
export function parseMigrationPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) throw new Error('迁移记录缺少 JSON 对象');
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('迁移记录必须是 JSON 对象');
  }
  return Object.fromEntries(Object.entries(parsed));
}
