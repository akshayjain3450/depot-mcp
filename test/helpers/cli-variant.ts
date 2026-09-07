/**
 * Rewrites a recorded Connect document the way `depot ci ... --output json` spells it: snake_case
 * keys and fully prefixed protobuf enum names. Every parser must read both forms identically.
 */
export function cliVariant(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cliVariant);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
        cliVariant(entry),
      ]),
    );
  }
  if (value === 'failed') return 'JOB_STATUS_FAILED';
  if (value === 'failure') return 'JOB_CONCLUSION_FAILURE';
  if (value === 'finished') return 'STATUS_FINISHED';
  if (value === 'running') return 'WORKFLOW_STATUS_RUNNING';
  if (value === 'push') return 'TRIGGER_PUSH';
  return value;
}
