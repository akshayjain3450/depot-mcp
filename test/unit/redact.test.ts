import { describe, expect, it } from 'vitest';
import { redactValue, type RedactionReason } from '../../src/lib/redact.js';

const HARMLESS = 'BUILD_SETTING';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const HEX_40 = 'e83c5163316f89bfbde7d9ab23ca2e25604af290';
const HEX_64 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

/** Deterministic pseudo-random text over an alphabet, so long-value cases need no fixtures. */
function pseudoRandom(alphabet: string, length: number, seed: number): string {
  let state = seed;
  let out = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    // The low bits of a power-of-two LCG cycle quickly; take the high ones.
    out += alphabet[Math.floor(state / 65536) % alphabet.length];
  }
  return out;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PEM_BODY_LINES = Array.from({ length: 9 }, (_, line) => pseudoRandom(BASE64, 64, line + 7));

const SSH_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  ...PEM_BODY_LINES,
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

interface Case {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  /** undefined means the value must come back untouched. */
  readonly reason: RedactionReason | undefined;
}

const cases: readonly Case[] = [
  // --- name rule -------------------------------------------------------------------------
  { label: 'auth token name', name: 'SENTRY_AUTH_TOKEN', value: 'anything', reason: 'name' },
  { label: 'PASS stem', name: 'DB_PASS', value: 'hunter2', reason: 'name' },
  { label: 'PWD stem', name: 'DB_PWD', value: 'correct horse battery staple', reason: 'name' },
  {
    label: 'WEBHOOK stem',
    name: 'SLACK_WEBHOOK',
    value: 'https://hooks.slack.com/services/T000/B000/XXXX',
    reason: 'name',
  },
  { label: 'KEY stem', name: 'AWS_DEPLOY_KEY', value: 'short', reason: 'name' },
  { label: 'DSN stem', name: 'SENTRY_DSN', value: 'https://o0.ingest.sentry.io/1', reason: 'name' },
  { label: 'CONN stem', name: 'DB_CONN', value: 'Server=db;Database=app', reason: 'name' },
  { label: 'CONNECTION stem', name: 'DATABASE_CONNECTION', value: 'db.internal', reason: 'name' },
  { label: 'SSH stem', name: 'DEPLOY_SSH', value: 'short', reason: 'name' },
  { label: 'PEM stem', name: 'TLS_PEM', value: 'short', reason: 'name' },
  { label: 'BEARER stem', name: 'GH_BEARER', value: 'short', reason: 'name' },
  { label: 'ACCOUNTKEY stem', name: 'AZURE_ACCOUNTKEY', value: 'short', reason: 'name' },
  { label: 'ACCESS_KEY stem', name: 'MINIO_ACCESS_KEY', value: 'short', reason: 'name' },
  { label: 'CLIENT_SECRET stem', name: 'OAUTH_CLIENT_SECRET', value: 'short', reason: 'name' },
  { label: 'PRIVATE_KEY stem', name: 'SSH_PRIVATE_KEY', value: 'short', reason: 'name' },
  { label: 'camelCase apiKey', name: 'apiKey', value: 'short', reason: 'name' },
  { label: 'lower-case api_key', name: 'api_key', value: 'x', reason: 'name' },
  { label: 'APIKEY as one word', name: 'APIKEY', value: 'x', reason: 'name' },
  { label: 'PASSWD stem', name: 'DB_PASSWD', value: 'x', reason: 'name' },
  { label: 'PASSWORD stem', name: 'DATABASE_PASSWORD', value: 'x', reason: 'name' },
  { label: 'CERT stem', name: 'TLS_CERT', value: 'x', reason: 'name' },
  { label: 'CREDENTIALS stem', name: 'GOOGLE_CREDENTIALS', value: 'x', reason: 'name' },
  { label: 'SECRET stem', name: 'COOKIE_SECRET', value: 'x', reason: 'name' },
  { label: 'fixture credentials name', name: 'GH_APP_CREDENTIALS', value: 'x', reason: 'name' },
  { label: 'Vault SECRET_ID overrides the _ID exemption', name: 'VAULT_SECRET_ID', value: 'x', reason: 'name' },
  { label: 'name wins over pattern', name: 'API_TOKEN', value: `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`, reason: 'name' },

  // --- name rule: word-boundary and suffix exemptions -------------------------------------
  { label: 'AUTHOR is not AUTH', name: 'AUTHOR_NAME', value: 'Jane Doe', reason: undefined },
  { label: 'AUTHOR alone', name: 'AUTHOR', value: 'alice', reason: undefined },
  { label: 'CERTAINTY is not CERT', name: 'CERTAINTY', value: 'alice', reason: undefined },
  { label: 'SESSION_TIMEOUT', name: 'SESSION_TIMEOUT', value: '3600', reason: undefined },
  { label: 'SESSION_ID is an identifier', name: 'SESSION_ID', value: 'x', reason: undefined },
  { label: 'CERT_PATH', name: 'CERT_PATH', value: '/etc/ssl/certs/server.pem', reason: undefined },
  { label: 'CERTIFICATE_PATH', name: 'CERTIFICATE_PATH', value: '/etc/ssl/certs', reason: undefined },
  { label: 'PRIVATE_SUBNET_CIDR', name: 'PRIVATE_SUBNET_CIDR', value: '10.0.1.0/24', reason: undefined },
  { label: 'PRIVATE_REGISTRY is a host', name: 'PRIVATE_REGISTRY', value: 'registry.internal', reason: undefined },
  { label: 'CONCERT_MODE', name: 'CONCERT_MODE', value: 'live', reason: undefined },
  { label: 'AUTHORIZED_DOMAINS', name: 'AUTHORIZED_DOMAINS', value: 'example.com,acme.dev', reason: undefined },
  { label: 'KEYBOARD_LAYOUT', name: 'KEYBOARD_LAYOUT', value: 'us', reason: undefined },
  { label: 'PASSTHROUGH_MODE', name: 'PASSTHROUGH_MODE', value: 'enabled', reason: undefined },
  { label: 'MONKEY_PATCH', name: 'MONKEY_PATCH', value: 'true', reason: undefined },
  { label: 'CACHE_KEY is a cache key', name: 'CACHE_KEY', value: 'v3-node20-linux-x64-npm-lockfile', reason: undefined },
  { label: 'SIGNING_KEY_ID is an identifier', name: 'SIGNING_KEY_ID', value: 'x', reason: undefined },
  { label: 'TOKEN_URL', name: 'TOKEN_URL', value: 'https://auth.example.com/oauth/token', reason: undefined },
  { label: 'TOKEN_TTL', name: 'TOKEN_TTL', value: '900', reason: undefined },
  { label: 'PASSWORD_FILE', name: 'DB_PASSWORD_FILE', value: '/run/secrets/db_password', reason: undefined },
  { label: 'CONNECTION_TIMEOUT', name: 'CONNECTION_TIMEOUT', value: '30s', reason: undefined },
  { label: 'SSH_AUTH_SOCK', name: 'SSH_AUTH_SOCK', value: '/tmp/ssh-agent.sock', reason: undefined },
  { label: 'boolean under a flag-like name', name: 'REQUIRE_AUTH', value: 'true', reason: undefined },
  { label: 'KEY_VAULT is a vault name', name: 'AZURE_KEY_VAULT', value: 'acme-prod-kv', reason: undefined },

  // --- pattern rule: prefixed credentials (the old anchored patterns missed these) ---------
  {
    label: 'Bearer + GitHub token',
    name: HARMLESS,
    value: 'Authorization: Bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
    reason: 'pattern',
  },
  {
    label: 'Bearer + JWT',
    name: HARMLESS,
    value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    reason: 'pattern',
  },
  { label: 'JWT with leading whitespace', name: HARMLESS, value: ` ${JWT}`, reason: 'pattern' },
  { label: 'HTTP Basic header value', name: HARMLESS, value: 'Basic dXNlcjpwYXNzd29yZA==', reason: 'pattern' },

  // --- pattern rule: vendor formats ----------------------------------------------------------
  { label: 'GitHub classic token', name: HARMLESS, value: `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`, reason: 'pattern' },
  { label: 'GitHub OAuth token', name: HARMLESS, value: `gho_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`, reason: 'pattern' },
  { label: 'GitHub server token', name: HARMLESS, value: `ghs_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`, reason: 'pattern' },
  { label: 'GitHub fine-grained token', name: HARMLESS, value: `github_pat_${'11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOP'}`, reason: 'pattern' },
  { label: 'GitLab personal token', name: HARMLESS, value: `glpat-${'abcdefghijklmnopqrst'}`, reason: 'pattern' },
  { label: 'GitLab runner token', name: HARMLESS, value: `glrt-${'AbCdEfGhIjKlMnOpQrSt'}`, reason: 'pattern' },
  { label: 'GitLab deploy token', name: HARMLESS, value: `gldt-${'AbCdEfGhIjKlMnOpQrSt'}`, reason: 'pattern' },
  { label: 'OpenAI key', name: HARMLESS, value: `sk-proj-${'abcdefghijklmnopqrstuvwxyz'}`, reason: 'pattern' },
  { label: 'Anthropic key', name: HARMLESS, value: `sk-ant-${'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'}`, reason: 'pattern' },
  // Vendor-shaped sample values are split at runtime so GitHub push protection does not
  // mistake test fixtures for real credentials; the value under test is unchanged.
  { label: 'Stripe live key', name: HARMLESS, value: `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`, reason: 'pattern' },
  { label: 'Stripe key without digits', name: HARMLESS, value: `sk_live_${'abcdefghijklmnopqrstuvwxyz'}`, reason: 'pattern' },
  { label: 'Stripe test key', name: HARMLESS, value: `sk_test_${'4eC39HqLyjWDarjtT1zdp7dc'}`, reason: 'pattern' },
  { label: 'Stripe restricted key', name: HARMLESS, value: `rk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`, reason: 'pattern' },
  { label: 'Slack bot token', name: HARMLESS, value: `xoxb-${'123456789012-abcdefghijkl'}`, reason: 'pattern' },
  { label: 'Slack user token', name: HARMLESS, value: `xoxp-${'1-2-3-abcdefghij'}`, reason: 'pattern' },
  {
    label: 'Slack webhook URL under a harmless name',
    name: HARMLESS,
    value: 'https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    reason: 'pattern',
  },
  {
    label: 'Discord webhook URL',
    name: HARMLESS,
    value: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    reason: 'pattern',
  },
  { label: 'AWS access key id', name: HARMLESS, value: `AKIA${'IOSFODNN7EXAMPLE'}`, reason: 'pattern' },
  { label: 'AWS temporary key id', name: HARMLESS, value: `ASIA${'IOSFODNN7EXAMPLE'}`, reason: 'pattern' },
  {
    label: 'AWS secret access key in context',
    name: HARMLESS,
    value: `aws_secret_access_key = ${AWS_SECRET}`,
    reason: 'pattern',
  },
  { label: 'Google API key', name: HARMLESS, value: `AIza${'SyA-abcdefghijklmnopqrstuvwxyz0123456'}`, reason: 'pattern' },
  {
    label: 'SendGrid key',
    name: HARMLESS,
    value: `SG.${'ngeVfQFYQlKU0ufo8x5d1A'}.TwL2iGABf9DHoTf-09kqeF8tAMLVtQoBM3KJJ7oM6hA`,
    reason: 'pattern',
  },
  { label: 'Twilio API key', name: HARMLESS, value: `SK${'abcdef0123456789abcdef0123456789'}`, reason: 'pattern' },
  { label: 'Mailchimp key', name: HARMLESS, value: `${'abcdef0123456789abcdef0123456789'}-us21`, reason: 'pattern' },
  { label: 'Hugging Face token', name: HARMLESS, value: `hf_${'AbCdEfGhIjKlMnOpQrStUvWxYz012345'}`, reason: 'pattern' },
  { label: 'npm token', name: HARMLESS, value: `npm_${'abcdefghijklmnopqrstuvwxyz0123456789'}`, reason: 'pattern' },
  { label: 'PyPI token', name: HARMLESS, value: `pypi-${'AgEIcHlwaS5vcmcCJDAwMDAwMDAw'}`, reason: 'pattern' },
  { label: 'Docker Hub token', name: HARMLESS, value: `dckr_pat_${'AbCdEfGhIjKlMnOpQrStUvWx'}`, reason: 'pattern' },
  { label: 'Vault token', name: HARMLESS, value: `hvs.${'CAESIJAbCdEfGhIjKlMnOpQrStUvWx'}`, reason: 'pattern' },
  { label: 'Depot token', name: HARMLESS, value: `dp_${'abcdefghijklmnopqrstuvwxyz'}`, reason: 'pattern' },
  { label: 'Sentry organization token', name: HARMLESS, value: `sntrys_${'9f8e7d6c5b4a39281706f5e4d3c2b1a0'}`, reason: 'pattern' },
  {
    label: 'Sentry DSN',
    name: HARMLESS,
    value: 'https://1234567890abcdef1234567890abcdef@o123456.ingest.sentry.io/4504800',
    reason: 'pattern',
  },
  { label: 'JWT', name: HARMLESS, value: JWT, reason: 'pattern' },
  { label: 'PEM private key', name: HARMLESS, value: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...', reason: 'pattern' },
  { label: 'PEM RSA key', name: HARMLESS, value: '-----BEGIN RSA PRIVATE KEY-----', reason: 'pattern' },
  { label: 'PEM EC key', name: HARMLESS, value: '-----BEGIN EC PRIVATE KEY-----', reason: 'pattern' },
  { label: 'full OpenSSH private key', name: HARMLESS, value: SSH_PRIVATE_KEY, reason: 'pattern' },
  { label: 'PEM embedded after other text', name: HARMLESS, value: 'key:\n-----BEGIN PRIVATE KEY-----\nabc', reason: 'pattern' },
  { label: 'any PEM block, including certificates', name: HARMLESS, value: '-----BEGIN CERTIFICATE-----\nMIIB', reason: 'pattern' },

  // --- structure rule --------------------------------------------------------------------
  {
    label: 'connection string with Password=',
    name: 'DB',
    value: 'Server=db;User Id=app;Password=P@ssw0rd123;',
    reason: 'structure',
  },
  { label: 'key=value password', name: HARMLESS, value: 'password=hunter2', reason: 'structure' },
  { label: 'URL with basic auth', name: HARMLESS, value: 'https://user:pass@host.example.com/path', reason: 'structure' },
  { label: 'database URL with password', name: HARMLESS, value: 'postgres://user:s3cretpass@db.example.com:5432/app', reason: 'structure' },
  { label: 'URL with empty user and a password', name: HARMLESS, value: 'redis://:s3cret@cache:6379/0', reason: 'structure' },
  {
    label: 'Azure connection string with AccountKey=',
    name: HARMLESS,
    value: `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${pseudoRandom(BASE64, 86, 3)}==;EndpointSuffix=core.windows.net`,
    reason: 'structure',
  },
  { label: 'JSON token field', name: HARMLESS, value: '{"token":"abc123"}', reason: 'structure' },
  { label: 'YAML password key', name: HARMLESS, value: 'password: hunter2', reason: 'structure' },
  { label: 'api_key query parameter', name: HARMLESS, value: 'https://api.example.com/v1?api_key=abc123', reason: 'structure' },
  { label: 'SAS signature', name: HARMLESS, value: '?sv=2020-08-04&ss=b&sig=AbC1dEf2', reason: 'structure' },

  // --- length rule -----------------------------------------------------------------------
  { label: '600-character base64 blob', name: HARMLESS, value: pseudoRandom(BASE64, 600, 11), reason: 'length' },
  { label: 'PEM body without headers or newlines', name: HARMLESS, value: PEM_BODY_LINES.join(''), reason: 'length' },

  // --- entropy rule ----------------------------------------------------------------------
  { label: 'mixed-case alphanumeric secret', name: 'BUILD_ARG', value: 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6', reason: 'entropy' },
  { label: '64-character hex secret', name: HARMLESS, value: HEX_64, reason: 'entropy' },
  { label: '40-character hex secret', name: HARMLESS, value: 'a3f9c2e17b4d5e6f0918a7b6c5d4e3f2a1b0c9d8', reason: 'entropy' },
  { label: 'AWS secret access key without context', name: HARMLESS, value: AWS_SECRET, reason: 'entropy' },
  { label: 'base64 blob', name: HARMLESS, value: 'U2VjcmV0S2V5VmFsdWVUaGF0SXNMb25nRW5vdWdoMTIz', reason: 'entropy' },
  { label: 'base64 blob with padding', name: HARMLESS, value: 'c2VjcmV0LXZhbHVlLXRoYXQtaXMtbG9uZyBlbm91Z2gxMjM0NQ==', reason: 'entropy' },
  { label: 'PEM body lines with newlines', name: HARMLESS, value: PEM_BODY_LINES.join('\n'), reason: 'entropy' },
  {
    label: 'generic webhook URL with a random path segment',
    name: 'HOOK',
    value: 'https://hooks.example.com/v1/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    reason: 'entropy',
  },
  { label: 'random run inside prose', name: HARMLESS, value: `use the key ${AWS_SECRET} for now`, reason: 'entropy' },

  // --- benign values ---------------------------------------------------------------------
  { label: 'node flag', name: 'NODE_OPTIONS', value: '--max-old-space-size=4096', reason: undefined },
  { label: 'plain URL', name: 'API', value: 'https://api.example.com/v2/customers', reason: undefined },
  { label: 'plain URL with a digit', name: HARMLESS, value: 'https://api.example.com/v1/items', reason: undefined },
  { label: 'S3 URL', name: 'BUCKET', value: 's3://acme-artifacts-prod-2024', reason: undefined },
  { label: 'OCI image reference', name: 'IMAGE', value: 'ghcr.io/acme/api:1.42.0-alpine3.19', reason: undefined },
  { label: 'OCI image with digest', name: 'IMAGE', value: `ghcr.io/acme/api@sha256:${HEX_64}`, reason: undefined },
  { label: 'image digest', name: 'IMAGE_DIGEST', value: `sha256:${HEX_64}`, reason: undefined },
  { label: 'PYTHONPATH', name: 'PYTHONPATH', value: '/app/src:/app/lib/python3.11/site-packages', reason: undefined },
  { label: 'cache key under another name', name: 'BUILD_ID', value: 'v3-node20-linux-x64-npm-lockfile', reason: undefined },
  { label: 'git SHA under GIT_SHA', name: 'GIT_SHA', value: HEX_40, reason: undefined },
  { label: 'sha256 git object under COMMIT_SHA', name: 'COMMIT_SHA', value: HEX_64, reason: undefined },
  { label: 'hashed asset URL', name: 'ASSET_URL', value: 'https://cdn.example.com/assets/app.a3f9c2e1b7d4058f6e2a1c9b0d7e4f3a.js', reason: undefined },
  { label: 'semver with build metadata', name: 'VERSION', value: '1.42.0-rc.1+build.20240905', reason: undefined },
  { label: 'UUID', name: 'PROJECT_ID', value: '550e8400-e29b-41d4-a716-446655440000', reason: undefined },
  { label: 'key=value with a non-secret key', name: HARMLESS, value: 'token_ttl=3600;mode=strict', reason: undefined },
  { label: 'interpolated password reference', name: HARMLESS, value: 'password=${DB_PASSWORD}', reason: undefined },
  { label: 'image tag named token', name: 'IMAGE', value: 'ghcr.io/acme/token:1.2', reason: undefined },
  { label: 'auth mode', name: 'AUTH_MODE', value: 'auth=basic', reason: undefined },
  { label: 'Basic authentication as prose', name: 'DOCS', value: 'Basic authentication is enabled', reason: undefined },
  { label: 'bucket name', name: HARMLESS, value: 'acme-artifacts-prod-us-east-1-bucket', reason: undefined },
  { label: 'feature flag list', name: HARMLESS, value: 'new-billing,fast-checkout,dark-mode-2', reason: undefined },
  { label: 'repository path', name: HARMLESS, value: 'github.com/acme/very-long-repository-name-v2', reason: undefined },
  { label: 'sentence without spaces', name: HARMLESS, value: 'thequickbrownfoxjumpsoverthelazydog1', reason: undefined },
  { label: 'production', name: 'NODE_ENV', value: 'production', reason: undefined },
  { label: 'true', name: 'FLAG', value: 'true', reason: undefined },
  { label: 'false', name: 'FLAG', value: 'false', reason: undefined },
  { label: 'count', name: 'COUNT', value: '42', reason: undefined },
  { label: 'MAX_CONNECTIONS', name: 'MAX_CONNECTIONS', value: '20', reason: undefined },
  { label: 'semver', name: 'VERSION', value: '1.2.3', reason: undefined },
  { label: 'prerelease semver', name: 'VERSION', value: 'v2.10.0-rc.1', reason: undefined },
  { label: 'region', name: 'REGION', value: 'us-east-1', reason: undefined },
  { label: 'region (eu)', name: 'REGION', value: 'eu-central-1', reason: undefined },
  { label: 'log level', name: 'LOG_LEVEL', value: 'debug', reason: undefined },
  { label: 'docs URL', name: 'DOCS', value: 'https://example.com/docs', reason: undefined },
  { label: 'short image', name: 'IMAGE', value: 'ghcr.io/acme/api:1.4.0', reason: undefined },
  { label: 'bucket', name: 'BUCKET', value: 'acme-artifacts-prod', reason: undefined },
  { label: 'feature flags', name: 'FEATURE_FLAGS', value: 'new-billing,fast-checkout', reason: undefined },
  { label: 'motto', name: 'MOTTO', value: 'move fast and fix things 2026', reason: undefined },
  { label: 'letters only', name: 'LETTERS_ONLY', value: 'a'.repeat(100), reason: undefined },
  { label: 'digits only', name: 'DIGITS_ONLY', value: '1'.repeat(100), reason: undefined },
  { label: 'low entropy', name: 'LOW_ENTROPY', value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaa1', reason: undefined },
  { label: 'long prose with whitespace', name: 'DESCRIPTION', value: 'The nightly job rebuilds every image and pushes to the staging registry. '.repeat(10), reason: undefined },
  { label: 'empty value', name: 'EMPTY', value: '', reason: undefined },
  { label: 'empty value under a secret name', name: 'API_TOKEN', value: '', reason: undefined },
];

describe('redactValue', () => {
  it.each(cases)('$label: $name -> $reason', ({ name, value, reason }) => {
    const result = redactValue(name, value);

    if (reason === undefined) {
      expect(result).toEqual({ value, redacted: false, reason: undefined });
      return;
    }
    expect(result.redacted).toBe(true);
    expect(result.reason).toBe(reason);
    expect(result.value).toBe(`[redacted by depot-mcp — ${value.length} characters]`);
  });

  it('covers every rule with at least one case', () => {
    const reasons = new Set(cases.map((entry) => entry.reason));
    expect([...reasons].sort()).toEqual(['entropy', 'length', 'name', 'pattern', 'structure', undefined]);
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it('reports the original length and nothing else about the value', () => {
    const value = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const result = redactValue(HARMLESS, value);

    expect(result.value).toBe(`[redacted by depot-mcp — ${value.length} characters]`);
    for (let index = 0; index + 4 <= value.length; index += 4) {
      expect(result.value).not.toContain(value.slice(index, index + 4));
    }
  });

  it('applies rules in the order name, pattern, structure, length, entropy', () => {
    const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    expect(redactValue('API_TOKEN', token).reason).toBe('name');
    expect(redactValue(HARMLESS, token).reason).toBe('pattern');
    expect(redactValue(HARMLESS, `password=${token}`).reason).toBe('pattern');
    expect(redactValue(HARMLESS, 'password=x'.repeat(60)).reason).toBe('structure');
    expect(redactValue(HARMLESS, pseudoRandom(BASE64, 600, 5)).reason).toBe('length');
    expect(redactValue(HARMLESS, pseudoRandom(BASE64, 40, 5)).reason).toBe('entropy');
  });

  it.each([
    ['repeated character', 'a'.repeat(1 << 20)],
    ['random base64 without whitespace', pseudoRandom(BASE64, 1 << 20, 17)],
    ['random base62 with whitespace', pseudoRandom(`${BASE64.slice(0, 62)} `, 1 << 20, 19)],
    ['prose', 'lorem ipsum dolor sit amet, consectetur adipiscing elit '.repeat(18725)],
    ['repeated pattern prefixes', 'eyJeyJeyJ aws://a:b:c:d://password_x=1 SG.SG.SG. '.repeat(21500)],
  ])('scans a 1 MB value (%s) in linear time', (_label, value) => {
    expect(value.length).toBeGreaterThanOrEqual(1 << 20);
    redactValue(HARMLESS, value.slice(0, 1024)); // warm up the regexes
    const started = performance.now();
    redactValue(HARMLESS, value);
    // Linear scanning finishes in tens of milliseconds; catastrophic backtracking would take
    // seconds. The bound is loose so shared CI runners (observed 50-85 ms) do not flake.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
