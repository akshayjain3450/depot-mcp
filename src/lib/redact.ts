export interface RedactionResult {
  readonly value: string;
  readonly redacted: boolean;
  readonly reason: 'name' | 'pattern' | 'entropy' | undefined;
}

const SECRETISH_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|APIKEY|API_KEY|AUTH|SESSION|SIGNING|CERT)/i;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{16,}/,
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^sk-[A-Za-z0-9._-]{16,}/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}/,
  /^AKIA[0-9A-Z]{12,}/,
  /^ASIA[0-9A-Z]{12,}/,
  /^dp_[A-Za-z0-9]{16,}/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^glpat-[A-Za-z0-9_-]{16,}/,
  /^npm_[A-Za-z0-9]{30,}/,
];

function looksHighEntropy(value: string): boolean {
  if (value.length < 24 || /\s/.test(value)) {
    return false;
  }
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  if (!hasLetter || !hasDigit) {
    return false;
  }
  const distinct = new Set(value).size;
  return distinct / value.length >= 0.35;
}

function placeholder(length: number): string {
  return `[redacted by depot-mcp — ${length} characters]`;
}

/**
 * Depot returns CI *variable* values verbatim (only secret values are withheld server-side), and
 * variables get misused as secret storage. Scrub anything that reads like a credential before it
 * reaches the model, and say which rule fired so the caller knows the value exists.
 */
export function redactValue(name: string, value: string): RedactionResult {
  if (value === '') {
    return { value, redacted: false, reason: undefined };
  }
  if (SECRETISH_NAME.test(name)) {
    return { value: placeholder(value.length), redacted: true, reason: 'name' };
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    return { value: placeholder(value.length), redacted: true, reason: 'pattern' };
  }
  if (looksHighEntropy(value)) {
    return { value: placeholder(value.length), redacted: true, reason: 'entropy' };
  }
  return { value, redacted: false, reason: undefined };
}
