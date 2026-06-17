/**
 * agentEditorTokens — shared constants for the Agent editor modal.
 *
 * Re-exports the canonical CLI tool vocabulary (the 8 tools an agent's
 * frontmatter `tools:` line may list — `cyboflow_*` MCP write tools are
 * deliberately excluded) and maps a workflow ROLE to an EXISTING repo
 * `--color-phase-*` design token. There is NO `--color-phase-planner` /
 * `-sprint` var, so the planner/sprint/compound roles fold onto the closest
 * phase color (plan / execute / compound respectively); any other role string
 * falls back to a neutral text token.
 *
 * `estimateTokens` is the front-end prompt-length heuristic used for the
 * "~N tokens" stat (the authoritative `estPromptTokens` is server-computed on
 * `AgentEntry.stats`; this is the live-editing echo as the textarea changes).
 */
import { CLI_TOOLS } from '../../../../../shared/types/cliTools';
import type { CliTool } from '../../../../../shared/types/cliTools';

export { CLI_TOOLS };
export type { CliTool };

/**
 * Map a workflow role to an existing repo phase color CSS var. planner→plan,
 * sprint→execute, compound→compound. Anything else (custom-agent roles, the
 * raw canonical-key fallbacks) gets a neutral text color.
 */
export function roleColorVar(role: string): string {
  switch (role) {
    case 'planner':
      return 'var(--color-phase-plan)';
    case 'sprint':
      return 'var(--color-phase-execute)';
    case 'compound':
      return 'var(--color-phase-compound)';
    default:
      return 'var(--color-text-tertiary)';
  }
}

/** Lookup-style alias for `roleColorVar` (kept for the documented ROLE_COLOR name). */
export const ROLE_COLOR = {
  planner: 'var(--color-phase-plan)',
  sprint: 'var(--color-phase-execute)',
  compound: 'var(--color-phase-compound)',
} as const;

/** Rough token estimate from a prompt string: ~4 chars per token. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
