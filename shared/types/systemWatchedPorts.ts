/**
 * The TCP ports the System view's "Ports & sockets" section probes — a user
 * setting (`AppConfig.systemWatchedPorts`, Settings → General → Advanced).
 *
 * Defaults to common local dev-server ports rather than cyboflow's own: the
 * section answers "what is bound on this machine that I care about", and
 * cyboflow's dev renderer / CDP ports only exist in a dev build (the system
 * view composition adds them there, env-resolved, on top of this list).
 *
 * Lives in `shared/` because BOTH the main and frontend `AppConfig`
 * declarations carry the field (docs/CODE-PATTERNS.md → IPC / type-parity
 * rules), and the Settings form parses with the same rules the IPC boundary
 * enforces.
 */

export const DEFAULT_SYSTEM_WATCHED_PORTS: readonly number[] = [3000, 5000, 8080];

/** More than this is a typo or a paste accident, and each port costs a connect probe per refresh. */
export const SYSTEM_WATCHED_PORTS_MAX = 32;

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Validate a stored/IPC value: an array of valid ports, deduplicated in first-seen
 * order. Returns null for anything malformed (not an array, a non-port member, or
 * more than {@link SYSTEM_WATCHED_PORTS_MAX} distinct ports).
 */
export function normalizeSystemWatchedPorts(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const value of raw) {
    if (!isValidPort(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > SYSTEM_WATCHED_PORTS_MAX ? null : out;
}

/**
 * The effective list: an absent or malformed value (config.json is hand-editable)
 * floors to the defaults; an explicit empty array means "watch nothing".
 */
export function resolveSystemWatchedPorts(raw: unknown): number[] {
  return normalizeSystemWatchedPorts(raw) ?? [...DEFAULT_SYSTEM_WATCHED_PORTS];
}

export function isDefaultSystemWatchedPorts(ports: readonly number[]): boolean {
  return (
    ports.length === DEFAULT_SYSTEM_WATCHED_PORTS.length &&
    ports.every((p, i) => p === DEFAULT_SYSTEM_WATCHED_PORTS[i])
  );
}

/**
 * Parse the Settings text field (ports separated by commas and/or whitespace).
 * `invalid` lists every token that is not a port, so the form can name them.
 */
export function parseSystemWatchedPortsText(text: string): { ports: number[]; invalid: string[] } {
  const ports: number[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (token === '') continue;
    const value = /^\d+$/.test(token) ? Number(token) : NaN;
    if (!isValidPort(value)) {
      invalid.push(token);
      continue;
    }
    if (!ports.includes(value)) ports.push(value);
  }
  return { ports, invalid };
}
