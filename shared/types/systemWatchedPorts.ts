/**
 * The TCP ports the System view's "Ports & sockets" section probes — a user
 * setting (`AppConfig.systemWatchedPorts`), edited in place via the gear on that section.
 *
 * Defaults to common local dev-server ports; a dev build also defaults in
 * cyboflow's own dev renderer / CDP ports (env-resolved — see resolveWatchedPorts
 * in main/src/systemViewComposition.ts). Once the user saves a list, that list is
 * used as-is in every build, so any of those ports can be removed.
 *
 * Lives in `shared/` because BOTH the main and frontend `AppConfig`
 * declarations carry the field (docs/CODE-PATTERNS.md → IPC / type-parity
 * rules), and the inline editor parses with the same rules the IPC boundary
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
 * Parse the inline editor's text field (ports separated by commas and/or whitespace).
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
