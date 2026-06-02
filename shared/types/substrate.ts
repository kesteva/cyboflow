/**
 * Shared type for the dual-substrate CLI choice (IDEA-013 / TASK-806).
 *
 * A workflow run executes under exactly one substrate, resolved once at launch
 * and stamped immutably onto the workflow_runs row (see substrateResolver.ts
 * and migration 013_workflow_run_substrate.sql):
 *
 *   'sdk'         — the in-process Claude Agent SDK substrate (default).
 *   'interactive' — the interactive PTY substrate (lands in TASK-808/S3).
 *
 * This file is consumed by both the main process (resolver, registry,
 * ConfigManager) and the renderer (substrate picker in S7). Keep it free of
 * Node.js built-ins so it can be imported in any environment.
 *
 * CONTRACT NOTE: the CliSubstrate union and the CHECK domain in
 * migration 013_workflow_run_substrate.sql are a single contract split across
 * TypeScript + SQL — if a new substrate is ever added, widen BOTH together.
 */

export type CliSubstrate = 'sdk' | 'interactive';

/** The substrate every run falls back to when nothing overrides it. */
export const DEFAULT_SUBSTRATE: CliSubstrate = 'sdk';

/**
 * Runtime guard for an unknown override value. Returns true only for a value
 * that is a member of the CliSubstrate union, so the resolver can reject and
 * skip past unrecognized config/frontmatter/env values without casts.
 */
export function isCliSubstrate(v: unknown): v is CliSubstrate {
  return v === 'sdk' || v === 'interactive';
}
