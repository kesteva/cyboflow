/**
 * workflowEditorOptions — vocabulary lists for the workflow blueprint editor.
 *
 * These are the suggested option sets surfaced in the inspector (agent select,
 * MCP toggle rows) and the phase colour swatch picker. They are SUGGESTIONS,
 * not a closed enum: `agent` is free text in the data model (see
 * `WorkflowStep.agent` in shared/types/workflows.ts), so the agent <select>
 * allows arbitrary values too (rendered as an extra option when the current
 * agent is not in `AGENT_OPTIONS`).
 *
 * The agent suggestions are derived from the canonical source of truth
 * (`CANONICAL_AGENT_KEYS` in shared/types/agentIdentity.ts) plus the human gate
 * (`HUMAN_GATE_AGENT`), so they stay in sync with the agent identity registry.
 *
 * The authoritative write-path validation lives in the main-process zod schema
 * (`workflowDefinitionSchema`); these lists only shape the editing UI.
 */

import { CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT } from '../../../../shared/types/agentIdentity';

/** Suggested agent ids for the AGENT tab <select> (free text also allowed). */
export const AGENT_OPTIONS = [...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT] as const;

/** Suggested MCP / tool ids for the MCP tab toggle rows. */
export const MCP_OPTIONS = [
  'filesystem',
  'web-search',
  'context7',
  'linear',
  'bash',
  'git',
  'maestro',
  'playwright',
] as const;

/**
 * Phase colour swatches. Mirrors the protoflow phase palette; each value is a
 * 7-character hex string accepted by the write-path schema
 * (`/^#[0-9a-fA-F]{6}$/`).
 */
export const PHASE_COLORS = [
  '#3b6dd6',
  '#5a4ad6',
  '#c96442',
  '#a87a2c',
  '#8b5cf6',
  '#8a4a4a',
] as const;
