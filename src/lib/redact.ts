/**
 * Credential redaction for CI variable values.
 *
 * Depot returns CI *variable* values verbatim (only secret values are withheld server-side), and
 * variables get misused as secret storage. Anything that reads like a credential is replaced with
 * a placeholder before it reaches the model, and the rule that fired is reported so the caller
 * still learns that the value exists.
 *
 * The tool exists so an agent can confirm that a variable holds what it expects, so a false
 * positive costs almost as much as a false negative. Five rules run in order, most specific first:
 *
 *   1. name      — a whole segment of the variable name is a credential word (KEY, TOKEN, PWD…),
 *                  unless the name ends in a path/flag/id-like suffix (_PATH, _URL, _TIMEOUT…).
 *   2. pattern   — a vendor token format appears anywhere in the value (ghp_, AKIA, eyJ…, PEM).
 *   3. structure — the value carries a credential syntactically: `://user:pass@host`, or a
 *                  `password=` / `token:` style assignment with a non-placeholder value.
 *   4. length    — more than 512 characters with no whitespace: a blob, not configuration.
 *   5. entropy   — an alphanumeric run of 20+ characters looks random (Shannon entropy and
 *                  character-class churn both high), and the value is not a URL, path, image
 *                  reference, semver, or digest, and not a git SHA under a SHA/COMMIT-like name.
 *
 * Every regular expression here is linear in the value length: no nested quantifiers, and every
 * variable-length run that must be followed by a literal is bounded.
 */

export type RedactionReason = 'name' | 'pattern' | 'structure' | 'length' | 'entropy';

export type RedactionResult =
  | { readonly value: string; readonly redacted: true; readonly reason: RedactionReason }
  | { readonly value: string; readonly redacted: false; readonly reason: undefined };

// ---------------------------------------------------------------------------------------------
// Rule 1: name
// ---------------------------------------------------------------------------------------------

/** Whole-segment matches: a name splits on non-alphanumerics and camelCase boundaries. */
const SECRET_NAME_SEGMENTS: ReadonlySet<string> = new Set([
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWORDS',
  'PASSWD',
  'PASS',
  'PWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'CREDS',
  'KEY',
  'KEYS',
  'APIKEY',
  'ACCESSKEY',
  'ACCOUNTKEY',
  'SECRETKEY',
  'PRIVATEKEY',
  'SSHKEY',
  'CLIENTSECRET',
  'APPSECRET',
  'AUTHTOKEN',
  'ACCESSTOKEN',
  'REFRESHTOKEN',
  'APITOKEN',
  'AUTH',
  'BEARER',
  'SIGNING',
  'CERT',
  'CERTIFICATE',
  'PEM',
  'SSH',
  'WEBHOOK',
  'DSN',
  'CONN',
  'CONNECTION',
  'CONNSTR',
  'CONNECTIONSTRING',
  'JWT',
  'SAS',
]);

/** A trailing segment that says the value is a location, a knob, or an identifier, not a secret. */
const EXEMPT_LAST_SEGMENTS: ReadonlySet<string> = new Set([
  'PATH',
  'PATHS',
  'FILE',
  'FILES',
  'FILENAME',
  'FILEPATH',
  'DIR',
  'DIRECTORY',
  'FOLDER',
  'NAME',
  'NAMES',
  'URL',
  'URLS',
  'URI',
  'ENDPOINT',
  'HOST',
  'HOSTS',
  'HOSTNAME',
  'PORT',
  'ID',
  'IDS',
  'IDENTIFIER',
  'TIMEOUT',
  'TTL',
  'EXPIRY',
  'EXPIRES',
  'EXPIRATION',
  'LIFETIME',
  'MAXAGE',
  'AGE',
  'INTERVAL',
  'ENABLED',
  'DISABLED',
  'REQUIRED',
  'OPTIONAL',
  'COUNT',
  'LENGTH',
  'MIN',
  'MAX',
  'SIZE',
  'LIMIT',
  'MODE',
  'TYPE',
  'KIND',
  'FORMAT',
  'VERSION',
  'ALG',
  'ALGORITHM',
  'ISSUER',
  'AUDIENCE',
  'SCOPE',
  'SCOPES',
  'REGION',
  'ARN',
  'PREFIX',
  'SUFFIX',
  'HEADER',
  'FLAG',
  'PROVIDER',
  'DOMAIN',
  'DOMAINS',
  'EMAIL',
  'USER',
  'USERNAME',
  'REALM',
  'METHOD',
  'STRATEGY',
  'SOCK',
  'SOCKET',
  'RATE',
  'THRESHOLD',
  'POLICY',
  'ROTATION',
]);

/** A leading segment that marks the variable as a switch rather than a credential holder. */
const EXEMPT_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'SKIP',
  'USE',
  'ENABLE',
  'DISABLE',
  'REQUIRE',
  'REQUIRES',
  'NEED',
  'NEEDS',
  'HAS',
  'IS',
  'NO',
  'ALLOW',
  'VERIFY',
  'CHECK',
  'VALIDATE',
  'WITH',
  'WITHOUT',
  'SHOULD',
  'FORCE',
  'IGNORE',
]);

/** Adjacent pairs where the credential word means something else ("cache key", "public key"). */
const EXEMPT_PAIRS: ReadonlySet<string> = new Set([
  'CACHE KEY',
  'IDEMPOTENCY KEY',
  'PARTITION KEY',
  'SORT KEY',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'ROUTING KEY',
  'SHARD KEY',
  'TRANSLATION KEY',
  'CONFIG KEY',
  'FEATURE KEY',
  'LOOKUP KEY',
  'OBJECT KEY',
  'KEY VAULT',
  'PUBLIC KEY',
]);

/** Pairs that stay secret even though the last segment is normally exempt (Vault's SECRET_ID). */
const FORCED_PAIRS: ReadonlySet<string> = new Set(['SECRET ID']);

const BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off)$/i;

function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((segment) => segment !== '');
}

function nameLooksSecret(name: string, value: string): boolean {
  if (BOOLEAN_VALUE.test(value)) {
    return false;
  }
  const segments = nameSegments(name);
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) {
    return false;
  }
  if (EXEMPT_FIRST_SEGMENTS.has(first) && segments.length > 1) {
    return false;
  }
  const beforeLast = segments[segments.length - 2];
  const lastPair = beforeLast === undefined ? undefined : `${beforeLast} ${last}`;
  if (
    EXEMPT_LAST_SEGMENTS.has(last) &&
    segments.length > 1 &&
    (lastPair === undefined || !FORCED_PAIRS.has(lastPair))
  ) {
    return false;
  }
  return segments.some((segment, index) => {
    if (!SECRET_NAME_SEGMENTS.has(segment)) {
      return false;
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    return (
      (previous === undefined || !EXEMPT_PAIRS.has(`${previous} ${segment}`)) &&
      (next === undefined || !EXEMPT_PAIRS.has(`${segment} ${next}`))
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Rule 2: pattern
// ---------------------------------------------------------------------------------------------

/**
 * Vendor credential formats, searched anywhere in the value so prefixes such as
 * "Authorization: Bearer …" or "token=…" do not hide them. Runs that must be followed by a
 * literal are bounded so a repeated prefix cannot make the scan quadratic.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub classic / OAuth / app / refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained tokens
  /\bgl(?:pat|rt|dt|ptt|ft|soat|cbt|oas|ldt|imt|agent)-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-)
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe secret / restricted keys
  /\bwhsec_[A-Za-z0-9]{20,}/, // Stripe webhook signing secrets
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/, // Slack webhooks
  /discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{16,}/, // Discord webhooks
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35,}/, // Google API keys
  /\bSG\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,}/, // SendGrid
  /\bSK[0-9a-f]{32}\b/, // Twilio API keys
  /\b[0-9a-f]{32}-us[0-9]{1,2}\b/, // Mailchimp
  /\bhf_[A-Za-z0-9]{20,}/, // Hugging Face
  /\bnpm_[A-Za-z0-9]{30,}/, // npm
  /\bpypi-[A-Za-z0-9_-]{20,}/, // PyPI
  /\bdckr_pat_[A-Za-z0-9_-]{20,}/, // Docker Hub
  /\bhv[sbr]\.[A-Za-z0-9_-]{20,}/, // HashiCorp Vault
  /\bdp_[A-Za-z0-9]{16,}/, // Depot
  /\bdepot_(?:org|project|user|pull)_[A-Za-z0-9]{16,}/, // Depot (typed tokens)
  /\bsntrys_[A-Za-z0-9+/=_-]{20,}/, // Sentry organization tokens
  /:\/\/[A-Za-z0-9]{16,128}(?::[A-Za-z0-9]{1,128})?@[A-Za-z0-9.-]{0,128}sentry\.io\b/, // Sentry DSN
  /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/, // bearer credentials
  /\b[Bb]asic\s+(?=[A-Za-z0-9+/]{0,64}[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/, // basic auth (a digit or padding rules out "Basic authentication")
  /-----BEGIN [A-Z0-9 ]{1,64}-----/, // any PEM block
];

/**
 * AWS secret access keys have no prefix: 40 base64-ish characters with mixed case and a digit.
 * Only claimed as a pattern when "aws" appears somewhere in the value; elsewhere the entropy
 * rule is what catches them.
 */
const AWS_SECRET_KEY =
  /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/;

function valueMatchesPattern(value: string): boolean {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  return /aws/i.test(value) && AWS_SECRET_KEY.test(value);
}

// ---------------------------------------------------------------------------------------------
// Rule 3: structure
// ---------------------------------------------------------------------------------------------

/** `scheme://user:password@host` — the username may be empty (redis://:pass@host). */
const URL_USERINFO = /:\/\/[^\s/@:]*:[^\s/@]+@/;

/**
 * `password=…`, `Password: …`, `"token":"…"` fragments inside connection strings, JSON, YAML
 * and query strings. The key must start at a word boundary so `token_ttl=` and `bypass=` do not
 * count, a bare colon must be followed by whitespace or a quote so `image/token:1.2` does not
 * count, and a value that starts like an interpolation (`${DB_PASSWORD}`, `%PASS%`) is a
 * reference rather than a secret.
 */
const SECRET_ASSIGNMENT =
  /(?<![A-Za-z0-9])(?:password|passwd|passphrase|pass|pwd|secret|token|api[_-]?key|api[_-]?secret|access[_-]?key|account[_-]?key|private[_-]?key|secret[_-]?key|client[_-]?secret|shared[_-]?access[_-]?key|shared[_-]?access[_-]?signature|signature|sig|credentials?|auth[_-]?token|access[_-]?token|refresh[_-]?token|sas[_-]?token)["']?[ \t]*(?:=|:(?=\s|["']))\s*["']?[^\s"';,&${%<]/i;

function valueHasCredentialStructure(value: string): boolean {
  return URL_USERINFO.test(value) || SECRET_ASSIGNMENT.test(value);
}

// ---------------------------------------------------------------------------------------------
// Rule 4: length
// ---------------------------------------------------------------------------------------------

const LENGTH_LIMIT = 512;

// ---------------------------------------------------------------------------------------------
// Rule 5: entropy
// ---------------------------------------------------------------------------------------------

/**
 * A run is a maximal stretch of alphanumerics joined by `-_+/=`, so base64 and hyphenated tokens
 * stay whole; the statistics below are taken over the alphanumerics only.
 */
const ENTROPY_MIN_RUN = 20;
const ENTROPY_WINDOW = 64;
/** Bits per character. Random hex tops out at 4, random base62 near 6; prose sits near 3.5–4. */
const ENTROPY_THRESHOLD = 3.6;
/**
 * Fraction of adjacent character pairs that change class (lower/upper/digit). Random hex churns
 * at ~0.47 and base62 at ~0.62; hyphenated build ids and camelCase words with a year in them
 * sit near 0.2. Hex cannot be camelCase, so it gets the lower bar.
 */
const CHURN_THRESHOLD = 0.3;
const CHURN_THRESHOLD_HEX = 0.25;

/** Name segments under which a bare hex value is a git SHA, digest or cache key, not a secret. */
const HASH_NAME_SEGMENTS: ReadonlySet<string> = new Set([
  'SHA',
  'SHA1',
  'SHA256',
  'SHA512',
  'COMMIT',
  'DIGEST',
  'HASH',
  'CHECKSUM',
  'REV',
  'REVISION',
  'CACHE',
  'ETAG',
  'FINGERPRINT',
  'VERSION',
  'HEAD',
  'REF',
]);

const URL_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/\S*$/;
const PATH_SHAPE = /^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])\S*$/;
/** registry/namespace/name:tag@sha256:digest — lowercase path components, one tag, one digest. */
const IMAGE_SHAPE =
  /^(?:[a-z0-9](?:[a-z0-9._-]{0,127}[a-z0-9])?(?::[0-9]{1,5})?\/){0,8}[a-z0-9](?:[a-z0-9._-]{0,127}[a-z0-9])?(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const SEMVER_SHAPE =
  /^v?[0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const DIGEST_SHAPE = /^(?:sha1|sha256|sha384|sha512|md5)[:=][A-Fa-f0-9]{16,128}$/i;
/** Subresource-integrity form: sha256-<base64>. */
const SRI_SHAPE = /^sha(?:256|384|512)-[A-Za-z0-9+/]{40,90}={0,2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_HEX = /^[A-Fa-f0-9]{7,128}$/;
const HEX_RUN = /^(?:[0-9a-f]+|[0-9A-F]+)$/;
const RUN_JOINERS = /[-_+/=]/g;

type ValueShape = 'url' | 'path' | 'image' | 'semver' | 'digest' | 'opaque';

function classifyShape(value: string): ValueShape {
  if (URL_SHAPE.test(value)) {
    return 'url';
  }
  if (PATH_SHAPE.test(value)) {
    return 'path';
  }
  if (SEMVER_SHAPE.test(value)) {
    return 'semver';
  }
  if (DIGEST_SHAPE.test(value) || SRI_SHAPE.test(value) || UUID_SHAPE.test(value)) {
    return 'digest';
  }
  // A bare lowercase word also satisfies IMAGE_SHAPE; require a registry, path or tag.
  if (/[/:]/.test(value) && IMAGE_SHAPE.test(value)) {
    return 'image';
  }
  return 'opaque';
}

const CLASS_OTHER = 0;
const CLASS_LOWER = 1;
const CLASS_UPPER = 2;
const CLASS_DIGIT = 3;

function isRunJoiner(code: number): boolean {
  return code === 0x2d || code === 0x5f || code === 0x2b || code === 0x2f || code === 0x3d;
}

function charClass(code: number): number {
  if (code >= 0x61 && code <= 0x7a) {
    return CLASS_LOWER;
  }
  if (code >= 0x41 && code <= 0x5a) {
    return CLASS_UPPER;
  }
  if (code >= 0x30 && code <= 0x39) {
    return CLASS_DIGIT;
  }
  return CLASS_OTHER;
}

/** n·log2(n) for n up to the window size, so the sliding entropy update is a table lookup. */
const N_LOG_N: readonly number[] = Array.from({ length: ENTROPY_WINDOW + 1 }, (_, n) =>
  n === 0 ? 0 : n * Math.log2(n),
);

/**
 * Slides a window over one alphanumeric run and reports whether any window has both high
 * Shannon entropy and high character-class churn, with at least one letter and one digit.
 * Counts are updated incrementally so the whole scan is linear in the run length.
 */
function runLooksRandom(run: string, churnThreshold: number): boolean {
  const end = run.length;
  const window = Math.min(end, ENTROPY_WINDOW);
  const counts = new Uint8Array(128);
  let weighted = 0;
  let letters = 0;
  let digits = 0;
  let churn = 0;

  const add = (index: number): void => {
    const code = run.charCodeAt(index);
    const count = (counts[code] ?? 0) + 1;
    counts[code] = count;
    weighted += (N_LOG_N[count] ?? 0) - (N_LOG_N[count - 1] ?? 0);
    const cls = charClass(code);
    if (cls === CLASS_DIGIT) {
      digits += 1;
    } else {
      letters += 1;
    }
    if (index > 0 && cls !== charClass(run.charCodeAt(index - 1))) {
      churn += 1;
    }
  };
  const remove = (index: number): void => {
    const code = run.charCodeAt(index);
    const count = counts[code] ?? 0;
    counts[code] = count - 1;
    weighted += (N_LOG_N[count - 1] ?? 0) - (N_LOG_N[count] ?? 0);
    const cls = charClass(code);
    if (cls === CLASS_DIGIT) {
      digits -= 1;
    } else {
      letters -= 1;
    }
    if (cls !== charClass(run.charCodeAt(index + 1))) {
      churn -= 1;
    }
  };
  const isRandom = (): boolean =>
    letters > 0 &&
    digits > 0 &&
    Math.log2(window) - weighted / window >= ENTROPY_THRESHOLD &&
    churn / (window - 1) >= churnThreshold;

  for (let index = 0; index < window; index += 1) {
    add(index);
  }
  if (isRandom()) {
    return true;
  }
  for (let head = window; head < end; head += 1) {
    remove(head - window);
    add(head);
    if (isRandom()) {
      return true;
    }
  }
  return false;
}

function isRunChar(code: number): boolean {
  return charClass(code) !== CLASS_OTHER || isRunJoiner(code);
}

function valueLooksRandom(value: string, skipHexRuns: boolean): boolean {
  const length = value.length;
  let start = 0;
  while (start < length) {
    if (!isRunChar(value.charCodeAt(start))) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < length && isRunChar(value.charCodeAt(end))) {
      end += 1;
    }
    if (end - start >= ENTROPY_MIN_RUN) {
      const run = value.slice(start, end).replace(RUN_JOINERS, '');
      const hex = HEX_RUN.test(run);
      if (
        run.length >= ENTROPY_MIN_RUN &&
        !(hex && skipHexRuns) &&
        runLooksRandom(run, hex ? CHURN_THRESHOLD_HEX : CHURN_THRESHOLD)
      ) {
        return true;
      }
    }
    start = end;
  }
  return false;
}

function entropyFires(name: string, value: string): boolean {
  const hashName = nameSegments(name).some((segment) => HASH_NAME_SEGMENTS.has(segment));
  if (hashName && BARE_HEX.test(value)) {
    return false;
  }
  // Shapes only apply to values short enough to be configuration rather than blobs; anything
  // longer without whitespace has already been caught by the length rule.
  const shape = value.length <= LENGTH_LIMIT ? classifyShape(value) : 'opaque';
  if (shape === 'path' || shape === 'image' || shape === 'semver' || shape === 'digest') {
    return false;
  }
  // Hex inside a URL is a content hash; a random base62 path segment is still a webhook token.
  return valueLooksRandom(value, hashName || shape === 'url');
}

// ---------------------------------------------------------------------------------------------

function placeholder(length: number): string {
  return `[redacted by depot-mcp — ${length} characters]`;
}

function redacted(value: string, reason: RedactionReason): RedactionResult {
  return { value: placeholder(value.length), redacted: true, reason };
}

export function redactValue(name: string, value: string): RedactionResult {
  if (value === '') {
    return { value, redacted: false, reason: undefined };
  }
  if (nameLooksSecret(name, value)) {
    return redacted(value, 'name');
  }
  if (valueMatchesPattern(value)) {
    return redacted(value, 'pattern');
  }
  if (valueHasCredentialStructure(value)) {
    return redacted(value, 'structure');
  }
  if (value.length > LENGTH_LIMIT && !/\s/.test(value)) {
    return redacted(value, 'length');
  }
  if (entropyFires(name, value)) {
    return redacted(value, 'entropy');
  }
  return { value, redacted: false, reason: undefined };
}
