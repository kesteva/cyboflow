/**
 * Parser for the context-usage string the SDK substrate already produces in
 * main/src/events.ts (e.g. "54k/200k tokens (27%)"). Surfaced onto the Claude
 * panel state and (for flow runs) onto the active-run row, then rendered by
 * ChatMetaStrip's context meter.
 *
 * Returns null for the empty/placeholder forms ("-- tokens (--%)", null) and
 * for any string that doesn't match the expected shape — the meter then renders
 * its empty "--%" state. This is the single guard against NaN% in the UI.
 */
export interface ParsedContextUsage {
  /** tokens currently in context, pre-formatted (e.g. "54k"). */
  used: string;
  /** the model's context window, pre-formatted (e.g. "200k"). */
  total: string;
  /** 0–100, already clamped by the producer. */
  percent: number;
}

const CONTEXT_RE = /^\s*(\S+)\s*\/\s*(\S+)\s+tokens\s+\((\d+)%\)\s*$/;

export function parseContextUsage(raw: string | null | undefined): ParsedContextUsage | null {
  if (raw == null) return null;
  const m = CONTEXT_RE.exec(raw);
  if (m === null) return null;
  const percent = Number.parseInt(m[3], 10);
  if (!Number.isFinite(percent)) return null;
  return { used: m[1], total: m[2], percent };
}

/**
 * Meter fill tier matching the design: >80% rust (terracotta/interactive),
 * >50% amber (warning), otherwise green (success). Returns a Tailwind bg class.
 */
export function contextMeterClass(percent: number): string {
  if (percent > 80) return 'bg-interactive';
  if (percent > 50) return 'bg-status-warning';
  return 'bg-status-success';
}
