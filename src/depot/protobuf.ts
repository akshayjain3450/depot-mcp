/**
 * A minimal protobuf wire-format codec, just enough for Depot's build-step RPCs.
 *
 * Why this exists: Depot's Connect JSON binding of `depot.build.v1.BuildService/GetBuildSteps`
 * is broken server-side (observed 2026-09-06: the server fails to encode its own response,
 * "cannot encode field ... has_logs to JSON: expected boolean, got 0"), while the same RPC over
 * the binary protobuf encoding works. The messages involved are tiny (strings, int32, bool, an
 * enum, and google.protobuf.Timestamp), so a dependency-free codec is smaller and safer than
 * pulling in a protobuf runtime plus generated code.
 *
 * Only the wire types that appear in those messages are supported: varint (0), 64-bit (1),
 * length-delimited (2) and 32-bit (5). Groups (3, 4) are rejected.
 */

export interface VarintField {
  readonly wire: 0;
  readonly value: bigint;
}
export interface BytesField {
  readonly wire: 1 | 2 | 5;
  readonly value: Uint8Array;
}
export type WireField = VarintField | BytesField;

/** A decoded message: field number -> every occurrence, in wire order. */
export type DecodedMessage = ReadonlyMap<number, readonly WireField[]>;

export class ProtobufDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufDecodeError';
  }
}

const MAX_VARINT_BYTES = 10;

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let position = offset;
  for (let count = 0; count < MAX_VARINT_BYTES; count += 1) {
    const byte = bytes[position];
    if (byte === undefined) {
      throw new ProtobufDecodeError(`truncated varint at byte ${offset}`);
    }
    position += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: position };
    }
    shift += 7n;
  }
  throw new ProtobufDecodeError(`varint longer than ${MAX_VARINT_BYTES} bytes at byte ${offset}`);
}

function slice(bytes: Uint8Array, start: number, length: number, what: string): Uint8Array {
  if (start + length > bytes.byteLength) {
    throw new ProtobufDecodeError(`truncated ${what} at byte ${start}`);
  }
  return bytes.subarray(start, start + length);
}

export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const fields = new Map<number, WireField[]>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.next;
    const fieldNumber = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (fieldNumber === 0) {
      throw new ProtobufDecodeError(`field number 0 at byte ${offset}`);
    }

    let field: WireField;
    if (wire === 0) {
      const varint = readVarint(bytes, offset);
      offset = varint.next;
      field = { wire: 0, value: varint.value };
    } else if (wire === 1) {
      field = { wire: 1, value: slice(bytes, offset, 8, 'fixed64') };
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.next;
      const size = Number(length.value);
      field = { wire: 2, value: slice(bytes, offset, size, 'length-delimited field') };
      offset += size;
    } else if (wire === 5) {
      field = { wire: 5, value: slice(bytes, offset, 4, 'fixed32') };
      offset += 4;
    } else {
      throw new ProtobufDecodeError(`unsupported wire type ${wire} at byte ${offset}`);
    }

    const existing = fields.get(fieldNumber);
    if (existing === undefined) {
      fields.set(fieldNumber, [field]);
    } else {
      existing.push(field);
    }
  }
  return fields;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function last(message: DecodedMessage, field: number): WireField | undefined {
  const values = message.get(field);
  return values === undefined ? undefined : values[values.length - 1];
}

/** proto3 "last one wins" for scalars. */
export function fieldString(message: DecodedMessage, field: number): string | undefined {
  const value = last(message, field);
  return value !== undefined && value.wire === 2 ? utf8.decode(value.value) : undefined;
}

export function fieldBool(message: DecodedMessage, field: number): boolean | undefined {
  const value = last(message, field);
  return value !== undefined && value.wire === 0 ? value.value !== 0n : undefined;
}

/** Varint read as a signed 64-bit integer, then narrowed to a JS number. */
export function fieldInt(message: DecodedMessage, field: number): number | undefined {
  const value = last(message, field);
  if (value === undefined || value.wire !== 0) {
    return undefined;
  }
  return Number(BigInt.asIntN(64, value.value));
}

export function fieldMessages(message: DecodedMessage, field: number): DecodedMessage[] {
  return (message.get(field) ?? [])
    .filter((value): value is BytesField => value.wire === 2)
    .map((value) => decodeMessage(value.value));
}

export function fieldMessage(message: DecodedMessage, field: number): DecodedMessage | undefined {
  const value = last(message, field);
  return value !== undefined && value.wire === 2 ? decodeMessage(value.value) : undefined;
}

/** google.protobuf.Timestamp { int64 seconds = 1; int32 nanos = 2; } as an RFC 3339 string. */
export function fieldTimestamp(message: DecodedMessage, field: number): string | undefined {
  const timestamp = fieldMessage(message, field);
  if (timestamp === undefined) {
    return undefined;
  }
  const seconds = fieldInt(timestamp, 1) ?? 0;
  const nanos = fieldInt(timestamp, 2) ?? 0;
  const millis = seconds * 1000 + Math.floor(nanos / 1_000_000);
  if (!Number.isFinite(millis)) {
    return undefined;
  }
  return new Date(millis).toISOString();
}

/** Builds a message from scalar fields and nested messages; unset (undefined) values are omitted. */
export class ProtobufWriter {
  private readonly parts: number[] = [];

  private varint(value: bigint): this {
    let remaining = BigInt.asUintN(64, value);
    for (;;) {
      const byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining === 0n) {
        this.parts.push(byte);
        return this;
      }
      this.parts.push(byte | 0x80);
    }
  }

  private tag(field: number, wire: number): this {
    return this.varint(BigInt((field << 3) | wire));
  }

  private lengthDelimited(field: number, bytes: Uint8Array): this {
    this.tag(field, 2).varint(BigInt(bytes.byteLength));
    for (const byte of bytes) {
      this.parts.push(byte);
    }
    return this;
  }

  string(field: number, value: string | undefined): this {
    return value === undefined ? this : this.lengthDelimited(field, new TextEncoder().encode(value));
  }

  int32(field: number, value: number | undefined): this {
    if (value === undefined) {
      return this;
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(`field ${field}: ${value} is not an integer`);
    }
    return this.tag(field, 0).varint(BigInt(value));
  }

  bool(field: number, value: boolean | undefined): this {
    return value === undefined ? this : this.tag(field, 0).varint(value ? 1n : 0n);
  }

  message(field: number, value: ProtobufWriter | undefined): this {
    return value === undefined ? this : this.lengthDelimited(field, value.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}
