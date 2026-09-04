export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

/**
 * Depot's Connect JSON binding emits lowerCamelCase, but `depot ci diagnose --output json`
 * emits snake_case for the same document. Accept either spelling everywhere so a field
 * rename between the two representations can never silently blank a value.
 */
function keyVariants(key: string): string[] {
  const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
  const camel = key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  return [...new Set([key, snake, camel])];
}

function readValue(source: unknown, keys: readonly string[]): unknown {
  const record = asObject(source);
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    for (const variant of keyVariants(key)) {
      const value = record[variant];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
  }
  return undefined;
}

export function readString(source: unknown, ...keys: string[]): string | undefined {
  const raw = readValue(source, keys);
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * protobuf JSON serialises 64-bit integers as strings so they survive JSON's 2^53 limit,
 * so a numeric field can legitimately arrive as either a number or a decimal string.
 */
export function readNumber(source: unknown, ...keys: string[]): number | undefined {
  const raw = readValue(source, keys);
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readBoolean(source: unknown, ...keys: string[]): boolean | undefined {
  const raw = readValue(source, keys);
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

export function readObject(source: unknown, ...keys: string[]): JsonObject | undefined {
  return asObject(readValue(source, keys));
}

export function readArray(source: unknown, ...keys: string[]): unknown[] {
  const raw = readValue(source, keys);
  return Array.isArray(raw) ? raw : [];
}

export function readObjectArray(source: unknown, ...keys: string[]): JsonObject[] {
  const items: JsonObject[] = [];
  for (const entry of readArray(source, ...keys)) {
    const record = asObject(entry);
    if (record !== undefined) {
      items.push(record);
    }
  }
  return items;
}

export function readStringArray(source: unknown, ...keys: string[]): string[] {
  return readArray(source, ...keys).filter((entry): entry is string => typeof entry === 'string');
}

/**
 * protobuf JSON renders an enum as its full symbolic name (`STATUS_FAILED`), while Depot's
 * docs and CLI describe the same values unprefixed (`failed`). Strip the declaring prefix so
 * callers see one spelling. Numeric encodings need a per-enum table and are handled by `mapEnumNumber`.
 */
export function readEnum(
  source: unknown,
  keys: readonly string[],
  prefixes: readonly string[] = [],
): string | undefined {
  const raw = readValue(source, keys);
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  const upper = raw.toUpperCase();
  for (const prefix of prefixes) {
    const marker = `${prefix.toUpperCase()}_`;
    if (upper.startsWith(marker)) {
      return upper.slice(marker.length).toLowerCase();
    }
  }
  return raw.toLowerCase();
}

export function mapEnumNumber(
  source: unknown,
  keys: readonly string[],
  table: Readonly<Record<number, string>>,
  prefixes: readonly string[] = [],
): string | undefined {
  const raw = readValue(source, keys);
  if (typeof raw === 'number') {
    return table[raw];
  }
  return readEnum(source, keys, prefixes);
}
