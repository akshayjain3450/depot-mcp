import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  DEFAULT_API_URL,
  DEFAULT_MAX_LOG_PAGES,
  DEFAULT_OUTPUT_CHAR_BUDGET,
  loadConfig,
} from '../../src/config.js';

describe('loadConfig', () => {
  it('fails fast with actionable guidance when DEPOT_TOKEN is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);

    try {
      loadConfig({});
      expect.unreachable('expected loadConfig to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('DEPOT_TOKEN is not set');
      expect(message).toContain('Organization Settings -> API Tokens');
      expect(message).toContain('DEPOT_ORG_ID');
      expect(message).toContain('Project tokens will not work');
    }
  });

  it('treats a blank token as missing', () => {
    expect(() => loadConfig({ DEPOT_TOKEN: '   ' })).toThrow(/DEPOT_TOKEN is not set/);
  });

  it('applies sensible defaults', () => {
    const config = loadConfig({ DEPOT_TOKEN: 'dp_abc' });

    expect(config).toEqual({
      token: 'dp_abc',
      apiUrl: DEFAULT_API_URL,
      orgId: undefined,
      projectId: undefined,
      allowWrites: false,
      maxLogPages: DEFAULT_MAX_LOG_PAGES,
      outputCharBudget: DEFAULT_OUTPUT_CHAR_BUDGET,
    });
  });

  it('trims surrounding whitespace from values', () => {
    const config = loadConfig({ DEPOT_TOKEN: ' dp_abc \n', DEPOT_ORG_ID: ' org_1 ' });

    expect(config.token).toBe('dp_abc');
    expect(config.orgId).toBe('org_1');
  });

  it('accepts the documented truthy spellings for the write gate', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_ALLOW_WRITES: value }).allowWrites, value).toBe(
        true,
      );
    }
    for (const value of ['0', 'false', 'no', '', 'maybe']) {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_ALLOW_WRITES: value }).allowWrites, value).toBe(
        false,
      );
    }
  });

  it('rejects a token with a line break or space without echoing it', () => {
    for (const token of ['dp_abc\r\ndef', 'dp_abc\ndef', 'dp_abc def', 'dp_abc\tdef', 'dp_\u0000abc']) {
      let message = '';
      try {
        loadConfig({ DEPOT_TOKEN: token });
        expect.unreachable('expected loadConfig to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('whitespace or control characters');
      expect(message).not.toContain('dp_abc');
      expect(message).not.toContain('def');
    }
  });

  it('accepts the full printable-ASCII range in a token', () => {
    const token = 'dp_A1~!@#$%^&*()_+-=[]{}|;:\'",.<>/?`';
    expect(loadConfig({ DEPOT_TOKEN: token }).token).toBe(token);
  });

  it('rejects an API URL that is not an absolute http(s) URL', () => {
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'api.depot.dev' })).toThrow(
      /is not an absolute URL/,
    );
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'ftp://api.depot.dev' })).toThrow(
      /must be an http\(s\) URL/,
    );
  });

  it('allows plain http only for loopback hosts', () => {
    for (const url of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
      'http://depot.localhost',
    ]) {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: url }).apiUrl, url).toBe(url);
    }
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'http://api.depot.dev' })).toThrow(
      /must use https:/,
    );
    expect(() =>
      loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'http://localhost.evil.example' }),
    ).toThrow(/must use https:/);
  });

  it('rejects credentials, query strings and fragments in the API URL', () => {
    expect(() =>
      loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://user:pw@api.depot.dev' }),
    ).toThrow(/username or password/);
    expect(() =>
      loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://api.depot.dev/?token=x' }),
    ).toThrow(/query string or fragment/);
    expect(() =>
      loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://api.depot.dev/#frag' }),
    ).toThrow(/query string or fragment/);
  });

  it('never repeats the API URL value in a rejection, in case it is a pasted secret', () => {
    for (const value of ['dp_pasted_token_xyz', 'http://dp_pasted_token_xyz.example', 'https://dp_pasted_token_xyz@api.depot.dev']) {
      let message = '';
      try {
        loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: value });
        expect.unreachable('expected loadConfig to throw');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, value).not.toContain('dp_pasted_token_xyz');
      expect(message, value).toContain(DEFAULT_API_URL);
    }
  });

  it('normalises the API URL by stripping trailing slashes', () => {
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://api.depot.dev///' }).apiUrl).toBe(
      'https://api.depot.dev',
    );
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://depot.internal/v1/' }).apiUrl).toBe(
      'https://depot.internal/v1',
    );
  });

  it('rejects non-positive integers for the numeric limits', () => {
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: 'lots' })).toThrow(
      /positive integer/,
    );
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_OUTPUT_BUDGET: '-5' })).toThrow(
      /positive integer/,
    );
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_OUTPUT_BUDGET: '5000' }).outputCharBudget).toBe(
      5_000,
    );
  });

  it('echoes a rejected numeric value only when it is short and plain', () => {
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: 'lots' })).toThrow(
      /got "lots"/,
    );
    const long = 'x'.repeat(41);
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: long })).not.toThrow(
      new RegExp(long),
    );
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: 'a b' })).not.toThrow(
      /a b/,
    );
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: 'a b' })).toThrow(
      /positive integer/,
    );
  });
});

describe('loadConfig: remaining variables and edge cases', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses DEPOT_PROJECT_ID and treats a blank value as unset', () => {
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_PROJECT_ID: ' proj_1 ' }).projectId).toBe('proj_1');
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_PROJECT_ID: '   ' }).projectId).toBeUndefined();
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_ORG_ID: '' }).orgId).toBeUndefined();
  });

  it('accepts whitespace around the write flag', () => {
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_ALLOW_WRITES: ' TRUE ' }).allowWrites).toBe(true);
  });

  it('reads process.env by default and only the supplied object when one is given', () => {
    vi.stubEnv('DEPOT_TOKEN', 'from-process');
    vi.stubEnv('DEPOT_ORG_ID', 'org_from_process');

    expect(loadConfig().token).toBe('from-process');
    expect(loadConfig({ DEPOT_TOKEN: 't' }).orgId).toBeUndefined();
  });

  it('exposes a named ConfigError that is a real Error', () => {
    const error = (() => {
      try {
        loadConfig({});
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).name).toBe('ConfigError');
  });

  describe('DEPOT_API_URL', () => {
    it('trims whitespace and a trailing slash, and keeps a path prefix', () => {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: ' https://api.depot.dev/ ' }).apiUrl).toBe(
        'https://api.depot.dev',
      );
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://proxy.example/depot' }).apiUrl).toBe(
        'https://proxy.example/depot',
      );
    });

    it('falls back to the default when blank', () => {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: '  ' }).apiUrl).toBe(DEFAULT_API_URL);
    });

    it('rejects a host-less https:// prefix', () => {
      expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'https://' })).toThrow(
        /is not an absolute URL/,
      );
    });

    it.each(['ftp://proxy.example', '//proxy.example', 'proxy.example/depot'])(
      'rejects %s with a message naming the variable but not the value',
      (value) => {
        let message = '';
        try {
          loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: value });
          expect.unreachable('expected loadConfig to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/^DEPOT_API_URL /);
        expect(message).not.toContain(value);
      },
    );

    // The WHATWG parser lower-cases the scheme and tolerates a single slash after it, so these
    // spellings normalise to the canonical form rather than being rejected.
    it.each(['HTTPS://api.depot.dev', 'https:/api.depot.dev'])('normalises %s', (value) => {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: value }).apiUrl).toBe(
        'https://api.depot.dev',
      );
    });

    it('accepts plain http for loopback only, since the token travels in clear text', () => {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'http://127.0.0.1:8080' }).apiUrl).toBe(
        'http://127.0.0.1:8080',
      );
      expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'http://proxy.example' })).toThrow(
        /must use https:/,
      );
    });
  });

  describe('numeric limits', () => {
    it.each(['1.5', '1_000', 'Infinity', 'NaN', '-1', '0', 'lots', '1e400'])(
      'rejects DEPOT_MCP_OUTPUT_BUDGET=%s',
      (value) => {
        expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_OUTPUT_BUDGET: value })).toThrow(
          `DEPOT_MCP_OUTPUT_BUDGET must be a positive integer, got ${JSON.stringify(value)}.`,
        );
      },
    );

    it('falls back to the defaults when blank', () => {
      const config = loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: '', DEPOT_MCP_OUTPUT_BUDGET: ' ' });

      expect(config.maxLogPages).toBe(DEFAULT_MAX_LOG_PAGES);
      expect(config.outputCharBudget).toBe(DEFAULT_OUTPUT_CHAR_BUDGET);
    });

    // Pinned: Number() leniency. These are all accepted although none is a plain positive integer
    // spelling; "1e2" and "0x10" in particular are surprising for an environment variable.
    it.each([
      ['1e2', 100],
      ['0x10', 16],
      ['+3', 3],
      ['007', 7],
      [' 7 ', 7],
      ['99999999999999999999', 100_000_000_000_000_000_000],
    ])('accepts DEPOT_MCP_MAX_LOG_PAGES=%s as %i (pinned leniency)', (value, expected) => {
      expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_MCP_MAX_LOG_PAGES: value }).maxLogPages).toBe(expected);
    });
  });
});
