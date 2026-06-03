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
 * The authoritative write-path validation lives in the main-process zod schema
 * (`workflowDefinitionSchema`); these lists only shape the editing UI.
 */

/** Suggested agent ids for the AGENT tab <select> (free text also allowed). */
export const AGENT_OPTIONS = [
  'idea-extractor',
  'researcher',
  'human',
  'task-refiner',
  'executor',
  'test-writer',
  'code-reviewer',
  'verifier',
  'visual-verifier',
] as const;

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
