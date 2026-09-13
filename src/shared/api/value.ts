export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ResponseFormatError extends Error {
  readonly code = 'INVALID_RESPONSE';
  constructor(message: string) { super(message); this.name = 'ResponseFormatError'; }
}
export function requireUnique<T>(items: T[], key: (item: T) => string | number, message: string): T[] {
  if (new Set(items.map(key)).size !== items.length) throw new ResponseFormatError(message);
  return items;
}
