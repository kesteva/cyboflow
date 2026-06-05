/**
 * workflowMeta — pure metadata helper for the landing-experience workflow
 * picker (the "warm paper / monospace terminal" wizard).
 *
 * Projects the two tRPC list queries the wizard already fetches —
 * `cyboflow.workflows.list` (workflow rows: id / name / spec_json) and
 * `cyboflow.runs.list` (run-list rows: id / workflow_id / created_at) — into a
 * flat per-workflow card model the React wizard renders. No React, no tRPC
 * calls, no Node built-ins: a single pure function over the two row arrays so it
 * is trivially unit-testable.
 *
 * Step / phase counts come from `resolveWorkflowDefinition` (the same READ-path
 * resolver the canvas and the active-runs rail use): a row's `spec_json` wins,
 * else the built-in fallback for a `CyboflowWorkflowName`, else null → zero
 * counts (a custom flow with a missing/broken spec).
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../../shared/types/trpc';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Types inferred from the router output — never a local mirror.
// (Mirrors the alias pattern in stores/activeRunsStore.ts.)
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** A workflow row from `cyboflow.workflows.list` (has id, name, spec_json). */
export type WorkflowListRow = RouterOutputs['cyboflow']['workflows']['list'][number];

/** A run-list row from `cyboflow.runs.list` (has id, workflow_id, created_at). */
export type RunListRow = RouterOutputs['cyboflow']['runs']['list'][number];

/**
 * Flat card model for one workflow, consumed by the wizard's picker cards.
 */
export interface WorkflowCardMeta {
  /** Workflow row id (`workflows.id`). */
  id: string;
  /** Raw workflow name (e.g. `'sprint'`). */
  name: string;
  /** Display title (tight-cased), e.g. `'Sprint'`. */
  title: string;
  /** One-line description of what the flow does. `''` for unknown custom flows. */
  subtitle: string;
  /** Slash-command form shown as an eyebrow, e.g. `'/sprint'`. */
  slashCommand: string;
  /** True for the single default workflow ({@link DEFAULT_WORKFLOW_NAME}). */
  isDefault: boolean;
  /** Total step count across all phases of the effective definition (0 if none). */
  stepCount: number;
  /** Phase count of the effective definition (0 if none). */
  phaseCount: number;
  /** ISO timestamp of the most recent run of this workflow, or null if never run. */
  lastUsedAt: string | null;
}

/** The workflow pre-selected by the wizard on open. */
export const DEFAULT_WORKFLOW_NAME = 'sprint';

/**
 * Static one-line subtitles keyed by built-in workflow name. Custom flows fall
 * back to `''` (no canned description).
 */
const SUBTITLE_BY_NAME: Record<string, string> = {
  planner: 'Idea → epics → tasks (plan + refine, no execute)',
  sprint: 'Executor ↔ verifier loop → sprint review',
};

/**
 * Static display titles keyed by built-in workflow name. Custom flows fall back
 * to a title-cased rendering of the raw name.
 */
const TITLE_BY_NAME: Record<string, string> = {
  planner: 'Planner',
  sprint: 'Sprint',
};

/** Title-case a raw workflow name for display when no static title exists. */
function titleCase(name: string): string {
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Build the per-workflow card models for the wizard.
 *
 * For each workflow row:
 *   - Resolve its effective definition (`spec_json` → built-in fallback → null).
 *   - `phaseCount` = number of phases; `stepCount` = total steps across phases;
 *     both 0 when resolution is null (custom flow, missing/broken spec).
 *   - `subtitle` / `title` come from the static maps (title falls back to
 *     title-cased name; subtitle falls back to `''`).
 *   - `lastUsedAt` = the newest `created_at` among runs whose `workflow_id`
 *     matches this row's id, or null when the workflow has no runs.
 */
export function buildWorkflowMeta(
  rows: WorkflowListRow[],
  runs: RunListRow[],
): WorkflowCardMeta[] {
  return rows.map((row) => {
    const def = resolveWorkflowDefinition(row.name, row.spec_json);
    const phaseCount = def ? def.phases.length : 0;
    const stepCount = def
      ? def.phases.reduce((sum, phase) => sum + phase.steps.length, 0)
      : 0;

    let lastUsedAt: string | null = null;
    for (const run of runs) {
      if (run.workflow_id !== row.id) continue;
      if (lastUsedAt === null || run.created_at > lastUsedAt) {
        lastUsedAt = run.created_at;
      }
    }

    return {
      id: row.id,
      name: row.name,
      title: TITLE_BY_NAME[row.name] ?? titleCase(row.name),
      subtitle: SUBTITLE_BY_NAME[row.name] ?? '',
      slashCommand: `/${row.name}`,
      isDefault: row.name === DEFAULT_WORKFLOW_NAME,
      stepCount,
      phaseCount,
      lastUsedAt,
    };
  });
}
