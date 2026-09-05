import { describe, expect, it } from 'vitest';
import {
  decodeBuildRequestForInspection,
  decodeGetBuildStepLogsResponse,
  decodeGetBuildStepsResponse,
  encodeGetBuildStepLogsRequest,
  encodeGetBuildStepsRequest,
} from '../../src/depot/build-proto.js';
import {
  decodeMessage,
  fieldBool,
  fieldInt,
  fieldMessages,
  fieldString,
  fieldTimestamp,
  ProtobufDecodeError,
  ProtobufWriter,
} from '../../src/depot/protobuf.js';

function timestamp(seconds: number, nanos = 0): ProtobufWriter {
  return new ProtobufWriter().int32(1, seconds).int32(2, nanos);
}

describe('protobuf wire codec', () => {
  it('round-trips strings, ints, bools and nested messages', () => {
    const bytes = new ProtobufWriter()
      .string(1, 'hello')
      .int32(2, 300)
      .bool(3, true)
      .message(4, new ProtobufWriter().string(1, 'inner'))
      .finish();

    const message = decodeMessage(bytes);
    expect(fieldString(message, 1)).toBe('hello');
    expect(fieldInt(message, 2)).toBe(300);
    expect(fieldBool(message, 3)).toBe(true);
    expect(fieldString(fieldMessages(message, 4)[0] ?? new Map(), 1)).toBe('inner');
  });

  it('encodes the canonical varint examples', () => {
    expect([...new ProtobufWriter().int32(1, 1).finish()]).toEqual([0x08, 0x01]);
    expect([...new ProtobufWriter().int32(1, 300).finish()]).toEqual([0x08, 0xac, 0x02]);
    expect([...new ProtobufWriter().string(2, 'testing').finish()]).toEqual([
      0x12, 0x07, 0x74, 0x65, 0x73, 0x74, 0x69, 0x6e, 0x67,
    ]);
  });

  it('encodes a negative int32 as a ten-byte varint and reads it back', () => {
    const bytes = new ProtobufWriter().int32(1, -1).finish();
    expect(bytes.byteLength).toBe(1 + 10);
    expect(fieldInt(decodeMessage(bytes), 1)).toBe(-1);
  });

  it('omits undefined fields entirely', () => {
    expect(new ProtobufWriter().string(1, undefined).int32(2, undefined).finish().byteLength).toBe(0);
  });

  it('applies last-one-wins for repeated scalars and keeps every repeated message', () => {
    const bytes = new ProtobufWriter()
      .string(1, 'first')
      .string(1, 'second')
      .message(2, new ProtobufWriter().string(1, 'a'))
      .message(2, new ProtobufWriter().string(1, 'b'))
      .finish();
    const message = decodeMessage(bytes);
    expect(fieldString(message, 1)).toBe('second');
    expect(fieldMessages(message, 2).map((m) => fieldString(m, 1))).toEqual(['a', 'b']);
  });

  it('skips unknown fields of every supported wire type', () => {
    const bytes = Uint8Array.from([
      0x08, 0x05, // field 1 varint 5
      0x11, 1, 2, 3, 4, 5, 6, 7, 8, // field 2 fixed64
      0x1d, 1, 2, 3, 4, // field 3 fixed32
      0x22, 0x02, 0x68, 0x69, // field 4 bytes "hi"
    ]);
    const message = decodeMessage(bytes);
    expect(fieldInt(message, 1)).toBe(5);
    expect(fieldString(message, 4)).toBe('hi');
    expect(fieldString(message, 2)).toBeUndefined();
  });

  it('converts google.protobuf.Timestamp to RFC 3339', () => {
    const bytes = new ProtobufWriter().message(3, timestamp(1_757_110_147, 41_000_000)).finish();
    expect(fieldTimestamp(decodeMessage(bytes), 3)).toBe('2025-09-05T22:09:07.041Z');
  });

  it.each([
    ['truncated varint', [0x08, 0x80]],
    ['truncated length-delimited field', [0x12, 0x05, 0x61]],
    ['truncated fixed64', [0x11, 0x01]],
    ['group wire type', [0x0b]],
    ['field number zero', [0x00, 0x00]],
  ])('rejects malformed input: %s', (_label, bytes) => {
    expect(() => decodeMessage(Uint8Array.from(bytes))).toThrow(ProtobufDecodeError);
  });
});

describe('Depot build-step messages', () => {
  it('encodes GetBuildStepsRequest with the published field numbers', () => {
    const bytes = encodeGetBuildStepsRequest({ projectId: 'proj', buildId: 'bld', pageSize: 50 });
    expect([...bytes]).toEqual([
      0x0a, 0x04, 0x70, 0x72, 0x6f, 0x6a, // 1: "proj"
      0x12, 0x03, 0x62, 0x6c, 0x64, // 2: "bld"
      0x18, 0x32, // 3: 50
    ]);
    expect(decodeBuildRequestForInspection('GetBuildSteps', bytes)).toEqual({
      projectId: 'proj',
      buildId: 'bld',
      pageSize: 50,
    });
  });

  it('encodes GetBuildStepLogsRequest with the digest in field 3 and paging in 4 and 5', () => {
    const bytes = encodeGetBuildStepLogsRequest({
      projectId: 'p',
      buildId: 'b',
      buildStepDigest: 'sha256:1',
      pageToken: 'next',
    });
    expect(decodeBuildRequestForInspection('GetBuildStepLogs', bytes)).toEqual({
      projectId: 'p',
      buildId: 'b',
      buildStepDigest: 'sha256:1',
      pageToken: 'next',
    });
  });

  it('decodes GetBuildStepsResponse into the JSON-binding shape', () => {
    const step = new ProtobufWriter()
      .string(1, '[2/2] RUN exit 1')
      .string(2, 'sha256:abc')
      .message(3, timestamp(1_757_110_147))
      .message(4, timestamp(1_757_110_150, 500_000_000))
      .int32(5, 1)
      .string(6, 'process did not complete successfully: exit code: 1')
      .bool(7, true);
    const cached = new ProtobufWriter().string(1, '[1/2] FROM alpine').string(2, 'sha256:def').int32(5, 2);
    const bytes = new ProtobufWriter().message(1, step).message(1, cached).string(2, 'tok').finish();

    expect(decodeGetBuildStepsResponse(bytes)).toEqual({
      buildSteps: [
        {
          name: '[2/2] RUN exit 1',
          digest: 'sha256:abc',
          startedAt: '2025-09-05T22:09:07.000Z',
          completedAt: '2025-09-05T22:09:10.500Z',
          cacheState: 'CACHE_STATE_UNCACHED',
          error: 'process did not complete successfully: exit code: 1',
          hasLogs: true,
        },
        { name: '[1/2] FROM alpine', digest: 'sha256:def', cacheState: 'CACHE_STATE_CACHED', hasLogs: false },
      ],
      nextPageToken: 'tok',
    });
  });

  it('decodes GetBuildStepLogsResponse with its next_page_token in field 6', () => {
    const bytes = new ProtobufWriter()
      .message(1, new ProtobufWriter().string(1, 'line one').message(2, timestamp(1_757_110_147)))
      .message(1, new ProtobufWriter().string(1, 'line two'))
      .string(6, 'more')
      .finish();
    expect(decodeGetBuildStepLogsResponse(bytes)).toEqual({
      logs: [{ message: 'line one', timestamp: '2025-09-05T22:09:07.000Z' }, { message: 'line two' }],
      nextPageToken: 'more',
    });
  });

  it('decodes the real response shape captured from Depot (step with unknown enum value)', () => {
    const bytes = new ProtobufWriter()
      .message(1, new ProtobufWriter().string(1, 'x').string(2, 'sha256:y').int32(5, 9).bool(7, false))
      .finish();
    const decoded = decodeGetBuildStepsResponse(bytes);
    expect((decoded.buildSteps as Array<Record<string, unknown>>)[0]?.cacheState).toBe(9);
  });
});
