import { describe, expect, it } from 'vitest';
import {
  asObject,
  mapEnumNumber,
  readBoolean,
  readEnum,
  readNumber,
  readObjectArray,
  readString,
  readStringArray,
} from '../../src/depot/shape.js';

describe('asObject', () => {
  it('accepts only plain objects', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toBeUndefined();
    expect(asObject([1, 2])).toBeUndefined();
    expect(asObject('x')).toBeUndefined();
  });
});

describe('readString', () => {
  it('treats an empty string as absent, matching protobuf default semantics', () => {
    expect(readString({ name: '' }, 'name')).toBeUndefined();
    expect(readString({ name: 'api' }, 'name')).toBe('api');
  });

  it('accepts either camelCase or snake_case spelling', () => {
    expect(readString({ page_token: 'abc' }, 'pageToken')).toBe('abc');
    expect(readString({ pageToken: 'abc' }, 'page_token')).toBe('abc');
  });

  it('falls through a list of candidate keys in order', () => {
    expect(readString({ body: 'second' }, 'content', 'body')).toBe('second');
    expect(readString({ content: 'first', body: 'second' }, 'content', 'body')).toBe('first');
  });
});

describe('readNumber', () => {
  it('parses 64-bit integers that protobuf JSON encodes as strings', () => {
    expect(readNumber({ sizeBytes: '184320000' }, 'sizeBytes')).toBe(184_320_000);
    expect(readNumber({ sizeBytes: 42 }, 'sizeBytes')).toBe(42);
  });

  it('rejects values that are not numeric', () => {
    expect(readNumber({ n: 'abc' }, 'n')).toBeUndefined();
    expect(readNumber({ n: '' }, 'n')).toBeUndefined();
    expect(readNumber({ n: null }, 'n')).toBeUndefined();
  });

  it('keeps a legitimate zero', () => {
    expect(readNumber({ cachedSteps: 0 }, 'cachedSteps')).toBe(0);
  });
});

describe('readBoolean', () => {
  it('reads booleans and their string spellings', () => {
    expect(readBoolean({ t: true }, 't')).toBe(true);
    expect(readBoolean({ t: 'false' }, 't')).toBe(false);
    expect(readBoolean({ t: 'maybe' }, 't')).toBeUndefined();
  });
});

describe('readEnum', () => {
  it('strips the declaring prefix protobuf JSON includes', () => {
    expect(readEnum({ status: 'STATUS_FAILED' }, ['status'], ['status'])).toBe('failed');
    expect(readEnum({ targetType: 'TARGET_TYPE_JOB' }, ['targetType'], ['target_type'])).toBe('job');
    expect(
      readEnum({ kind: 'NEXT_COMMAND_KIND_LOGS' }, ['kind'], ['next_command_kind', 'kind']),
    ).toBe('logs');
  });

  it('lowercases an already-bare value', () => {
    expect(readEnum({ trigger: 'Push' }, ['trigger'], ['trigger'])).toBe('push');
  });

  it('returns undefined when the field is absent', () => {
    expect(readEnum({}, ['status'], ['status'])).toBeUndefined();
  });
});

describe('mapEnumNumber', () => {
  const table = { 0: 'unspecified', 1: 'running', 2: 'failed' };

  it('maps a numeric enum through its table', () => {
    expect(mapEnumNumber({ status: 2 }, ['status'], table, ['status'])).toBe('failed');
  });

  it('falls back to symbolic decoding', () => {
    expect(mapEnumNumber({ status: 'STATUS_RUNNING' }, ['status'], table, ['status'])).toBe(
      'running',
    );
  });

  it('returns undefined for a number outside the table', () => {
    expect(mapEnumNumber({ status: 99 }, ['status'], table, ['status'])).toBeUndefined();
  });
});

describe('array readers', () => {
  it('returns an empty array when protobuf omitted the repeated field', () => {
    expect(readObjectArray({}, 'runs')).toEqual([]);
    expect(readStringArray({}, 'names')).toEqual([]);
  });

  it('discards entries of the wrong shape', () => {
    expect(readObjectArray({ runs: [{ a: 1 }, 'nope', null] }, 'runs')).toEqual([{ a: 1 }]);
    expect(readStringArray({ names: ['a', 2, null] }, 'names')).toEqual(['a']);
  });
});
