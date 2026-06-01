/**
 * step-reporting-instructions.ts
 *
 * Pure, side-effect-free generator for the per-run system-prompt APPEND that
 * instructs the MAIN orchestrating session to call the `cyboflow_report_step`
 * MCP tool at each phase boundary.
 *
 * ── Dynamic step-id model (post main-merge) ──────────────────────────────────
 * Step ids are NOT a static constant. Every `workflows` row carries a
 * `spec_json`, and `resolveWorkflowDefinition(name, spec_json)` (in
 * shared/types/workflows.ts) is the RUNTIME source of truth — a full override
 * of `WORKFLOW_DEFINITIONS`, which is now only the seed/fallback. Step ids are
 * arbitrary, user-editable, per-row data for custom flows.
 *
 * Therefore this generator takes the ALREADY-RESOLVED `WorkflowDefinition`
 * (never a name keyed into `WORKFLOW_DEFINITIONS`) and flattens its
 * `phases[].steps[].id` list in declaration order. The caller (the index.ts
 * promptReader adapter) is responsible for calling `resolveWorkflowDefinition`
 * first, so this module stays a pure string builder with no DB/IPC/fs imports.
 *
 * Fail-soft: a `null` definition (a custom flow whose spec is missing/broken,
 * or a non-SoloFlow workflow) yields the empty string — never a throw — so the
 * wiring injects nothing rather than garbage. This mirrors
 * `resolveInitialStepId`'s null branch.
 *
 * No DB, IPC, or Electron imports — intentional; keep this module testable in
 * plain Node/vitest without bootstrapping the full app.
 */

import {
  resolveWorkflowDefinition,
  type WorkflowDefinition,
} from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Step-id derivation
// ---------------------------------------------------------------------------

/**
 * Flatten a resolved `WorkflowDefinition` into its ordered list of step ids.
 *
 * The order is `phases` order, then `steps` order within each phase — the same
 * traversal `getPhaseState` / `resolveInitialStepId` use, so the ids emitted in
 * the prompt match the ids the runner reports against (parity by construction).
 *
 * `null` (no resolvable definition) yields an empty array.
 */
export function flattenStepIds(def: WorkflowDefinition | null): string[] {
  if (def === null) return [];
  return def.phases.flatMap((phase) => phase.steps).map((step) => step.id);
}

// ---------------------------------------------------------------------------
// Append-text generator
// ---------------------------------------------------------------------------

/**
 * Build the system-prompt APPEND block that tells the MAIN session to call
 * `cyboflow_report_step` at each phase boundary, using the flat step ids of the
 * given RESOLVED definition (in declaration order).
 *
 * @param def The already-resolved `WorkflowDefinition` for this run, as returned
 *   by `resolveWorkflowDefinition(name, spec_json)`. Pass `null` when the run's
 *   workflow has no resolvable definition (non-SoloFlow / broken custom spec):
 *   the generator returns `''` (fail-soft, never throws).
 * @returns The append text, or `''` when `def` is null or has no steps.
 */
export function buildStepReportingAppend(def: WorkflowDefinition | null): string {
  const stepIds = flattenStepIds(def);
  if (stepIds.length === 0) return '';

  const idList = stepIds.map((id) => `\`${id}\``).join(', ');

  return [
    '## Step reporting (cyboflow)',
    '',
    'This run is tracked by cyboflow. As you work through the workflow, call the',
    '`cyboflow_report_step` MCP tool to report which step is currently active.',
    '',
    'This call is OBSERVATIONAL ONLY: it updates the cyboflow progress UI and does',
    'not gate, branch, or alter your work in any way. Never wait on its result.',
    '',
    'Call `cyboflow_report_step` with `step_id` set to each of the following ids, in',
    'order, AS that step begins:',
    '',
    idList,
    '',
    'v1 limitation: only THIS main session can report. Agent-tool sub-sessions you',
    'spawn do not inherit the cyboflow `mcpServers` config, so they cannot call',
    '`cyboflow_report_step`. Report each step from the main session yourself, even',
    'when the actual work is delegated to a subagent.',
  ].join('\n');
}

/**
 * Name-keyed convenience overload for the built-in fallback path: resolves the
 * built-in definition for a `SoloFlowWorkflowName` (or any name) via
 * `resolveWorkflowDefinition(name, '{}')` and delegates to
 * `buildStepReportingAppend`.
 *
 * NOTE: this intentionally resolves with an EMPTY spec (`'{}'`), so it only ever
 * reaches the built-in seed definition — it MUST NOT be used for a live run,
 * where the row's real `spec_json` may carry user edits. The authoritative id
 * source for a run is always the resolved def passed to
 * `buildStepReportingAppend` directly. Unknown / non-SoloFlow names resolve to
 * `null` and yield `''` (fail-soft).
 */
export function buildStepReportingAppendForName(workflowName: string): string {
  return buildStepReportingAppend(resolveWorkflowDefinition(workflowName, '{}'));
}
