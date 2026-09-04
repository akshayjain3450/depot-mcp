import { describe, expect, it } from 'vitest';
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

  it('rejects an API URL that is not http(s)', () => {
    expect(() => loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'api.depot.dev' })).toThrow(
      /must be an http\(s\) URL/,
    );
    expect(loadConfig({ DEPOT_TOKEN: 't', DEPOT_API_URL: 'http://localhost:8080' }).apiUrl).toBe(
      'http://localhost:8080',
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
});
