import assert from 'node:assert/strict';

/** Inspect an unknown response/evidence value without asserting a DTO type. */
export function readField(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys) {
    assert.ok(current !== null && typeof current === 'object', `Expected object before field ${key}`);
    if (Array.isArray(current)) {
      assert.equal(typeof key, 'number', 'Array access requires an index');
      current = current[Number(key)];
    } else {
      current = Reflect.get(current, key);
    }
  }
  return current;
}

export function readArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'Expected an array in the response/evidence');
  return value;
}

export function readString(value: unknown): string {
  assert.equal(typeof value, 'string', 'Expected a string in the response/evidence');
  // typeof is kept explicit so the compiler and the assertion share the boundary.
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}

export function required<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, 'Expected a present contract value');
  return value;
}
