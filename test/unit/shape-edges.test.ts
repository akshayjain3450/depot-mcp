import { describe, expect, it } from 'vitest';
import {
  asObject,
  mapEnumNumber,
  readArray,
  readBoolean,
  readEnum,
  readNumber,
  readObject,
  readObjectArray,
  readString,
  readStringArray,
} from '../../src/depot/shape.js';

describe('key spelling', () => {
  it('finds a snake_case field through its camelCase name and vice versa, digits included', () => {
    expect(readString({ build_step_digest: 'x' }, 'buildStepDigest')).toBe('x');
    expect(readString({ buildStepDigest: 'x' }, 'build_step_digest')).toBe('x');
    expect(readString({ v2_id: 'y' }, 'v2Id')).toBe('y');
    expect(readString({ v2Id: 'y' }, 'v2_id')).toBe('y');
    expect(readString({ next_page_token: 't' }, 'nextPageToken')).toBe('t');
  });

  it('does not treat PascalCase or unrelated spellings as matches', () => {
    expect(readString({ BuildStep: 'x' }, 'buildStep')).toBeUndefined();
    expect(readString({ buildstep: 'x' }, 'buildStep')).toBeUndefined();
    expect(readString({ 'build-step': 'x' }, 'buildStep')).toBeUndefined();
  });

  it('prefers the exact spelling when both spellings are present', () => {
    expect(readString({ page_token: 'snake', pageToken: 'camel' }, 'pageToken')).toBe('camel');
    expect(readString({ page_token: 'snake', pageToken: 'camel' }, 'page_token')).toBe('snake');
  });

  it('prefers an earlier candidate key over a later one regardless of spelling', () => {
    expect(readString({ body: 'b', content: 'c' }, 'content', 'body')).toBe('c');
    expect(readString({ body: 'b', run_id: 'r' }, 'runId', 'body')).toBe('r');
  });

  it('has no dotted-path support: nested values are reached by chaining readObject', () => {
    const source = { run: { status: { code: 'ok' } } };

    expect(readString(source, 'run.status.code')).toBeUndefined();
    expect(readString(readObject(readObject(source, 'run'), 'status'), 'code')).toBe('ok');
  });
});

describe('absent versus falsy', () => {
  it('treats null and undefined as absent and falls through to the next key', () => {
    expect(readString({ a: null, b: 'B' }, 'a', 'b')).toBe('B');
    expect(readString({ a: undefined, b: 'B' }, 'a', 'b')).toBe('B');
    expect(readNumber({ a: null }, 'a')).toBeUndefined();
    expect(readBoolean({ a: null }, 'a')).toBeUndefined();
    expect(readObject({ a: null }, 'a')).toBeUndefined();
    expect(readArray({ a: null }, 'a')).toEqual([]);
  });

  it('keeps legitimate falsy values', () => {
    expect(readNumber({ n: 0 }, 'n')).toBe(0);
    expect(readNumber({ n: 0, m: 5 }, 'n', 'm')).toBe(0);
    expect(readBoolean({ b: false, c: true }, 'b', 'c')).toBe(false);
  });

  // Pinned: an empty string counts as present for key selection (so it does not fall through to
  // the next key) but is reported as absent, which differs from null.
  it('treats an empty string as present-but-empty rather than falling through (pinned)', () => {
    expect(readString({ s: '', t: 'T' }, 's', 't')).toBeUndefined();
    expect(readString({ s: null, t: 'T' }, 's', 't')).toBe('T');
    expect(readEnum({ s: '' }, ['s'], [])).toBeUndefined();
  });

  it('reads nothing from a non-object source', () => {
    expect(readString(undefined, 'a')).toBeUndefined();
    expect(readString(null, 'a')).toBeUndefined();
    expect(readString('text', 'length')).toBeUndefined();
    expect(readString(['a'], '0')).toBeUndefined();
    expect(readObjectArray(42, 'x')).toEqual([]);
  });
});

describe('readNumber and int64 strings', () => {
  it('parses decimal int64 strings, including negatives', () => {
    expect(readNumber({ n: '184320000' }, 'n')).toBe(184_320_000);
    expect(readNumber({ n: '-5' }, 'n')).toBe(-5);
    expect(readNumber({ n: '0' }, 'n')).toBe(0);
    expect(readNumber({ n: '3.5' }, 'n')).toBe(3.5);
  });

  it('rejects non-finite and non-numeric values', () => {
    expect(readNumber({ n: 'Infinity' }, 'n')).toBeUndefined();
    expect(readNumber({ n: '-Infinity' }, 'n')).toBeUndefined();
    expect(readNumber({ n: Number.NaN }, 'n')).toBeUndefined();
    expect(readNumber({ n: Number.POSITIVE_INFINITY }, 'n')).toBeUndefined();
    expect(readNumber({ n: true }, 'n')).toBeUndefined();
    expect(readNumber({ n: [1] }, 'n')).toBeUndefined();
    expect(readNumber({ n: '12abc' }, 'n')).toBeUndefined();
  });

  // Pinned: Number() is more lenient than protobuf's int64 JSON encoding. Hex, exponent and
  // padded spellings are accepted, and values above 2^53 lose precision silently.
  it('accepts hex, exponent and whitespace-padded strings (pinned leniency)', () => {
    expect(readNumber({ n: '0x10' }, 'n')).toBe(16);
    expect(readNumber({ n: '1e3' }, 'n')).toBe(1000);
    expect(readNumber({ n: ' 42 ' }, 'n')).toBe(42);
  });

  it('rounds int64 values beyond 2^53 (pinned precision loss)', () => {
    expect(readNumber({ n: '9007199254740993' }, 'n')).toBe(9_007_199_254_740_992);
  });
});

describe('readBoolean', () => {
  it('accepts only real booleans and the lowercase string spellings', () => {
    expect(readBoolean({ b: 'true' }, 'b')).toBe(true);
    expect(readBoolean({ b: 'false' }, 'b')).toBe(false);
    expect(readBoolean({ b: 'TRUE' }, 'b')).toBeUndefined();
    expect(readBoolean({ b: 1 }, 'b')).toBeUndefined();
    expect(readBoolean({ b: 'yes' }, 'b')).toBeUndefined();
  });
});

describe('readEnum prefix stripping', () => {
  it('is case-insensitive and tries prefixes in order', () => {
    expect(readEnum({ s: 'status_failed' }, ['s'], ['status'])).toBe('failed');
    expect(readEnum({ s: 'RUN_STATUS_FAILED' }, ['s'], ['status', 'run_status'])).toBe('failed');
    expect(readEnum({ s: 'RUN_STATUS_FAILED' }, ['s'], ['run', 'run_status'])).toBe(
      'status_failed',
    );
  });

  it('lowercases when no prefix matches and when no prefixes are given', () => {
    expect(readEnum({ s: 'Failed' }, ['s'], ['status'])).toBe('failed');
    expect(readEnum({ s: 'CONCLUSION_SUCCESS' }, ['s'])).toBe('conclusion_success');
  });

  it('reads through alternative keys and spellings', () => {
    expect(readEnum({ attempt_status: 'ATTEMPT_STATUS_RUNNING' }, ['status', 'attemptStatus'], ['attempt_status'])).toBe('running');
  });

  it('ignores non-string values', () => {
    expect(readEnum({ s: 2 }, ['s'], ['status'])).toBeUndefined();
    expect(readEnum({ s: null }, ['s'], ['status'])).toBeUndefined();
    expect(readEnum({ s: { nested: true } }, ['s'], ['status'])).toBeUndefined();
  });

  // Pinned: a value that is nothing but the prefix collapses to an empty string rather than
  // undefined, so callers doing `?? 'unknown'` will render nothing.
  it('returns an empty string for a bare prefix (pinned)', () => {
    expect(readEnum({ s: 'STATUS_' }, ['s'], ['status'])).toBe('');
  });
});

describe('mapEnumNumber', () => {
  const table = { 0: 'unspecified', 1: 'running', 2: 'failed' };

  it('maps numbers through the table and strings through the prefix stripper', () => {
    expect(mapEnumNumber({ s: 0 }, ['s'], table, ['status'])).toBe('unspecified');
    expect(mapEnumNumber({ s: 'STATUS_FAILED' }, ['s'], table, ['status'])).toBe('failed');
    expect(mapEnumNumber({}, ['s'], table, ['status'])).toBeUndefined();
  });

  // Pinned: a numeric enum arriving as a string ("2") is not looked up in the table and comes
  // back as the literal "2".
  it('does not table-look-up numeric strings (pinned)', () => {
    expect(mapEnumNumber({ s: '2' }, ['s'], table, ['status'])).toBe('2');
  });
});

describe('object and array readers', () => {
  it('returns nested objects and rejects non-objects', () => {
    expect(readObject({ a: { b: 1 } }, 'a')).toEqual({ b: 1 });
    expect(readObject({ a: [1] }, 'a')).toBeUndefined();
    expect(readObject({ a: 'x' }, 'a')).toBeUndefined();
  });

  it('returns an empty array for anything that is not an array', () => {
    expect(readArray({ a: 'x' }, 'a')).toEqual([]);
    expect(readArray({ a: { length: 1 } }, 'a')).toEqual([]);
    expect(readArray({ a: [1, 'two', null] }, 'a')).toEqual([1, 'two', null]);
  });

  it('keeps only well-shaped entries', () => {
    expect(readObjectArray({ a: [{ x: 1 }, [2], 'three', null, 4] }, 'a')).toEqual([{ x: 1 }]);
    expect(readStringArray({ a: ['', 'b', 1, null] }, 'a')).toEqual(['', 'b']);
  });

  it('accepts class instances as objects', () => {
    expect(asObject(new Date(0))).toBeDefined();
    expect(asObject(Object.create(null) as object)).toEqual({});
  });
});
