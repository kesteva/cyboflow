/**
 * Shared type for the workflow EXECUTION MODEL — the axis that decides WHO walks
 * a workflow's DAG (its `WorkflowDefinition`). Sibling to the dual-substrate
 * choice in `./substrate.ts`, resolved once at launch and stamped immutably onto
 * the `workflow_runs` row (see executionModelResolver.ts and
 * migration 032_workflow_run_execution_model.sql):
 *
 *   'orchestrated' — an ORCHESTRATOR AGENT reads and manages the DAG. The model
 *                    sequences phases/steps, delegates each to a subagent, and is
 *                    itself the single writer + human seam. This is today's
 *                    behavior for every run, and the ONLY model the interactive
 *                    (PTY) substrate can run — there is no in-process control
 *                    channel over a REPL to drive a code loop. (default)
 *   'programmatic' — CODE (a host-side WorkflowController) walks the same DAG. It
 *                    sequences phases deterministically, invokes each phase agent
 *                    as a discrete unit, validates structured output, and performs
 *                    the writes. A repurposed orchestrating agent runs alongside
 *                    as MONITOR + human seam + triage (it no longer sequences).
 *                    SDK substrate only.
 *
 * The DAG itself is NOT new and NOT model-specific: both models consume the SAME
 * `WorkflowDefinition` (phases → steps, with per-step `agent` / `human` /
 * `retries` / `loopback`) from `./workflows.ts`. The execution model only changes
 * who walks it — the model (orchestrated) or the host code (programmatic). See
 * `docs/sdk-program-driven-workflows.md` for the full two-plane architecture.
 *
 * This file is consumed by both the main process (resolver, registry,
 * ConfigManager) and the renderer. Keep it free of Node.js built-ins so it can
 * be imported in any environment.
 *
 * CONTRACT NOTE: the ExecutionModel union and the CHECK domain in
 * migration 032_workflow_run_execution_model.sql are a single contract split
 * across TypeScript + SQL — if a new model is ever added, widen BOTH together
 * (exactly as the CliSubstrate / migration 013 contract is paired).
 */

import type { CliSubstrate } from './substrate';

export type ExecutionModel = 'orchestrated' | 'programmatic';

/**
 * The model every run falls back to when nothing overrides it. 'orchestrated'
 * is today's behavior, so with no override at any level every run resolves
 * 'orchestrated' and is byte-identical — the zero-behavior-change floor.
 */
export const DEFAULT_EXECUTION_MODEL: ExecutionModel = 'orchestrated';

/**
 * Runtime guard for an unknown override value. Returns true only for a value
 * that is a member of the ExecutionModel union, so the resolver can reject and
 * skip past unrecognized config/frontmatter/env values without casts (mirrors
 * isCliSubstrate).
 */
export function isExecutionModel(v: unknown): v is ExecutionModel {
  return v === 'orchestrated' || v === 'programmatic';
}

/**
 * The hard binding between substrate and execution model: the interactive (PTY)
 * substrate can ONLY run the orchestrated model. There is no in-process control
 * channel over a `claude` REPL for a host loop to drive (no streaming-input
 * `query()`, no `interrupt()`/`setModel()`), so 'programmatic' is structurally
 * unavailable there. The SDK substrate can run either model.
 *
 * Exposed as a pure predicate so both the resolver (which hard-pins) and any UI
 * (which should disable the picker) derive the constraint from one place.
 */
export function isExecutionModelAvailable(
  model: ExecutionModel,
  substrate: CliSubstrate,
): boolean {
  if (model === 'programmatic') {
    return substrate === 'sdk';
  }
  return true;
}
