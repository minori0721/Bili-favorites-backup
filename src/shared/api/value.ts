export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ResponseFormatError extends Error {
  readonly code = 'INVALID_RESPONSE';
  constructor(message: string) { super(message); this.name = 'ResponseFormatError'; }
}

export function optionalBilibiliUid(value: unknown): number | undefined {
  // Historical records can omit the owner or use 0 for an unknown owner.
  if (value == null || value === 0) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ResponseFormatError('UP UID 字段格式错误');
  }
  return value;
}
export function requireUnique<T>(items: T[], key: (item: T) => string | number, message: string): T[] {
  if (new Set(items.map(key)).size !== items.length) throw new ResponseFormatError(message);
  return items;
}
