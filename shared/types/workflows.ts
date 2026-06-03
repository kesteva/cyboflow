/**
 * Shared types for the workflow registry and workflow run subsystem.
 *
 * These types are consumed by both the main process (WorkflowRegistry) and
 * the renderer (workflow picker, run-status views).  Keep this file free of
 * Node.js built-ins so it can be imported in any environment.
 */

import type { CliSubstrate } from './substrate';

/**
 * Workflow-run permission contract consumed by the SDK PreToolUse mapper
 * (`permissionModeMapper.buildPreToolUseHook`), the frontmatter extractor in
 * `WorkflowRegistry`, the run snapshot, and the blueprint editor.
 *
 * This is intentionally DISTINCT from the session/panel permission contract in
 * `./permissionMode` (`'approve' | 'ignore'`): the two surfaces have different
 * vocabularies and different consumers, and `interactiveSettingsWriter`
 * treats them as parallel (`'ignore'`/`'dontAsk'`). Do NOT collapse them.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk';

export interface WorkflowRow {
  id: string;
  project_id: number;
  name: string;
  workflow_path: string | null;
  permission_mode: PermissionMode;
  /**
   * JSON-encoded `WorkflowDefinition` for an edited or custom flow.
   * `'{}'` (or empty/invalid JSON) means "use the built-in definition".
   * See `resolveWorkflowDefinition`.
   */
  spec_json: string;
  created_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  project_id: number;
  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'awaiting_review'
    | 'stuck'
    | 'completed'
    | 'failed'
    | 'canceled';
  permission_mode_snapshot: PermissionMode;
  worktree_path: string | null;
  branch_name: string | null;
  policy_json?: string | null;
  stuck_at?: string | null;
  stuck_reason?: string | null;
  error_message?: string | null;
  /** Id of the workflow step currently executing, e.g. 'context'. Bare WorkflowStep.id from WORKFLOW_DEFINITIONS. NULL when no step is active. IDEA-026 / TASK-764. */
  current_step_id?: string | null;
  /** Native-task link: the task this run executes. One run -> one task; a task has 0..N runs. NULL for runs launched without a task (migration 014). */
  task_id?: string | null;
  /** DB-canonical close-out signal set on terminal close-out. NULL while the run is in flight (migration 014). */
  outcome?: 'merged' | 'pr_open' | 'dismissed' | 'failed' | 'canceled' | null;
  /** Base branch captured at launch — future git triage only, NOT a hot path (migration 014). */
  base_branch?: string | null;
  /** Base SHA captured at launch — future git triage only (migration 014). */
  base_sha?: string | null;
  /** step->agent map frozen at launch; stable overlay across mid-run workflow edits (migration 014). */
  steps_snapshot_json?: string | null;
  /** CLI substrate stamped at launch ('sdk' | 'interactive'). Resolved once and immutable for the run. Reads back 'sdk' for every legacy row. IDEA-013 / TASK-806. */
  substrate?: CliSubstrate;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Subset of WorkflowRunRow returned by cyboflow.runs.list (and the raw-IPC
 * cyboflow:listRuns handler). The heavy snapshot column is excluded.
 * Centralized so the tRPC procedure and the legacy cyboflowApi wrapper
 * share one shape.
 */
export interface WorkflowRunListRow {
  id: string;
  workflow_id: string;
  project_id: number;
  status: WorkflowRunRow['status'];
  worktree_path: string | null;
  branch_name: string | null;
  /**
   * CLI substrate stamped at launch ('sdk' | 'interactive'). Surfaced to the
   * renderer so the picker can show it (S7). Optional in this seam slice so the
   * field is additive only — the renderer store (ActiveRunRow) and its fixtures
   * are owned by S7 and not widened here (Out of Scope: no frontend type widening).
   * IDEA-013 / TASK-806.
   */
  substrate?: CliSubstrate;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  stuck_reason: string | null;
}

export const CYBOFLOW_WORKFLOW_NAMES = [
  'soloflow',
  'planner',
  'sprint',
  'compound',
  'prune',
] as const;

export type CyboflowWorkflowName = (typeof CYBOFLOW_WORKFLOW_NAMES)[number];

// ─── Phase / Step data model ─────────────────────────────────────────────────

/**
 * A single step within a workflow phase.
 *
 * @remarks
 * `id` must be a stable kebab-case string (not an array index) — downstream
 * tasks reference steps by id for instrumentation and loopback resolution.
 *
 * V1 loopback invariant: `loopback` MUST reference the id of another step
 * within the SAME phase (intra-phase only). Cross-phase loopbacks are not
 * supported in v1 and will be ignored by the runner.
 *
 * `agent` is typed as `string` for v1 flexibility. A future task may narrow
 * this to a typed `AgentId` union once all consumers have stabilised.
 */
export interface WorkflowStep {
  /** Stable kebab-case identifier — unique within the containing phase. */
  id: string;
  /** Human-readable display name shown in the phase editor and progress rail. */
  name: string;
  /**
   * Agent id string (e.g. 'executor', 'verifier', 'human').
   * Typed as `string` for v1; may be narrowed to an `AgentId` union later.
   */
  agent: string;
  /** List of MCP/tool identifiers available to this step. */
  mcps: string[];
  /** Maximum number of automatic retries before the step escalates. */
  retries: number;
  /** When true the step can be skipped by the runner without blocking progress. */
  optional?: boolean;
  /** When true the step pauses the run and waits for a human response. */
  human?: boolean;
  /**
   * Id of the step within the SAME phase to loop back to on failure.
   * V1 constraint: intra-phase only.
   */
  loopback?: string;
  /** Short description shown in the phase editor tooltip / right-rail feed. */
  desc?: string;
}

/**
 * A named phase grouping one or more `WorkflowStep` entries.
 * `color` is a 7-character hex string (e.g. `'#3b6dd6'`) from the protoflow
 * phase palette.
 */
export interface WorkflowPhase {
  /** Stable kebab-case identifier for this phase (e.g. `'plan'`, `'execute'`). */
  id: string;
  /** Human-readable label displayed in the phase editor and progress bar. */
  label: string;
  /**
   * 7-character hex colour from the protoflow phase palette
   * (e.g. `'#3b6dd6'`).
   */
  color: string;
  /** Ordered list of steps that make up this phase. */
  steps: WorkflowStep[];
}

/**
 * Top-level definition for a cyboflow workflow.
 *
 * `id` is a free-form `string`: for the built-ins it is the
 * `CyboflowWorkflowName`, but a user-edited or "save as new" custom flow may
 * carry any id. `WORKFLOW_DEFINITIONS` is still typed
 * `Readonly<Record<CyboflowWorkflowName, WorkflowDefinition>>`, so the literal
 * built-in ids satisfy this wider type and the Record key set still forces all
 * built-ins to be present.
 */
export interface WorkflowDefinition {
  id: string;
  phases: WorkflowPhase[];
}

/**
 * Runtime state snapshot for a single workflow step during a live run.
 * Consumed by the progress rail and the tRPC subscription (TASK-766).
 */
export interface WorkflowStepState {
  stepId: string;
  status: 'pending' | 'running' | 'done';
}

/**
 * Event payload emitted by stepTransitionEvents on the 'transition' channel.
 * Consumed by the tRPC onStepTransition subscription and the renderer's
 * useWorkflowPhaseState hook.
 */
export interface WorkflowStepTransitionEvent {
  runId: string;
  stepId: string;
  status: WorkflowStepState['status'];
  timestamp: string;
}

// ─── Built-in starter definitions ───────────────────────────────────────────
// Source of truth: docs/protoflow-design/data.js (IDEA-026).
// These are the fallback definitions used whenever a workflow row has no usable
// `spec_json`. Users may now edit a flow's graph (persisted to
// `workflows.spec_json`) or save an edited graph as a brand-new custom flow;
// `resolveWorkflowDefinition` picks the effective definition at read time.
// The v1 loopback invariant still holds: `loopback` is intra-phase only.

/**
 * The built-in workflow definitions, keyed by `CyboflowWorkflowName`.
 * `Readonly<Record<…>>` forces the compiler to flag any missing key.
 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<CyboflowWorkflowName, WorkflowDefinition>> = {

  // /soloflow — full lifecycle: idea → planner → sprint → compound
  soloflow: {
    id: 'soloflow',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          {
            id: 'context',
            name: 'Get context on user idea',
            agent: 'idea-extractor',
            mcps: ['filesystem', 'web-search'],
            retries: 0,
            human: true,
            desc: 'Parse the raw user input, scan the codebase, write IDEA-NNN.md.',
          },
          {
            id: 'research',
            name: 'Research',
            agent: 'researcher',
            mcps: ['web-search', 'context7'],
            retries: 1,
            optional: true,
            desc: 'Optional. Pulls in docs, prior art, and library references.',
          },
          {
            id: 'approve-idea',
            name: 'Approve idea spec',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You read the IDEA-NNN.md and approve, edit, or reject.',
          },
        ],
      },
      {
        id: 'refine',
        label: 'Refine',
        color: '#5a4ad6',
        steps: [
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'task-refiner',
            mcps: ['filesystem', 'linear'],
            retries: 0,
            desc: 'Group the idea into epics with file ownership and dependency edges.',
          },
          {
            id: 'tasks',
            name: 'Fill out task details',
            agent: 'task-refiner',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Write each TASK-NNN.md with acceptance criteria and test plan.',
          },
          {
            id: 'approve-plan',
            name: 'Approve task plan',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You confirm scope, ordering, and acceptance criteria before sprint.',
          },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'implement',
            name: 'Implement task',
            agent: 'executor',
            mcps: ['filesystem', 'bash', 'git'],
            retries: 3,
            desc: 'Reads CODE-PATTERNS.md, writes the diff, runs local checks.',
          },
          {
            id: 'write-tests',
            name: 'Write tests',
            agent: 'test-writer',
            mcps: ['filesystem', 'bash'],
            retries: 1,
            desc: 'Adds unit / integration tests covering the new diff before verification.',
          },
          {
            id: 'code-review',
            name: 'Code review',
            agent: 'code-reviewer',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Inline review of the diff — naming, layering, pattern compliance.',
          },
          {
            id: 'task-verify',
            name: 'Task verification',
            agent: 'verifier',
            mcps: ['filesystem', 'bash'],
            retries: 3,
            loopback: 'implement',
            desc: 'Checks acceptance criteria. Bounces back up to 3× before escalating.',
          },
          {
            id: 'visual-verify',
            name: 'Visual verification',
            agent: 'visual-verifier',
            mcps: ['maestro', 'playwright'],
            retries: 1,
            optional: true,
            desc: 'Maestro / Playwright snapshot diff. Off unless enabled in config.',
          },
        ],
      },
      {
        id: 'verify',
        label: 'Sprint review',
        color: '#a87a2c',
        steps: [
          {
            id: 'sprint-verify',
            name: 'Sprint verification',
            agent: 'verifier',
            mcps: ['filesystem', 'bash', 'playwright'],
            retries: 1,
            desc: 'Runs the full suite once after every task is archived.',
          },
          {
            id: 'sprint-review',
            name: 'Code review',
            agent: 'code-reviewer',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Taste pass — naming, layering, CLAUDE.md drift.',
          },
          {
            id: 'human-review',
            name: 'Human review',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You do the taste-level review. All functional checks already passed.',
          },
        ],
      },
      {
        id: 'compound',
        label: 'Compound',
        color: '#8b5cf6',
        steps: [
          {
            id: 'extract',
            name: 'Extract learnings',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Reads sprint diffs + verifier reports, drafts solution files.',
          },
          {
            id: 'approve-learnings',
            name: 'Review and approve learnings',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You decide which learnings get merged into shared docs.',
          },
        ],
      },
    ],
  },

  // /soloflow:planner — idea → tasks only (no execute, no compound)
  planner: {
    id: 'planner',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          {
            id: 'context',
            name: 'Get context on user idea',
            agent: 'idea-extractor',
            mcps: ['filesystem', 'web-search'],
            retries: 0,
            human: true,
            desc: "Parse the user's prompt, scan the codebase, write IDEA-NNN.md.",
          },
          {
            id: 'research',
            name: 'Research',
            agent: 'researcher',
            mcps: ['web-search', 'context7'],
            retries: 1,
            optional: true,
            desc: 'Optional research pass before the idea is locked.',
          },
          {
            id: 'approve-idea',
            name: 'Approve idea spec',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You approve, edit, or reject the idea spec.',
          },
        ],
      },
      {
        id: 'refine',
        label: 'Refine',
        color: '#5a4ad6',
        steps: [
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'task-refiner',
            mcps: ['filesystem', 'linear'],
            retries: 0,
            desc: 'Decompose the idea into epics with dependency edges.',
          },
          {
            id: 'tasks',
            name: 'Fill out task details',
            agent: 'task-refiner',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Write each TASK-NNN.md with acceptance criteria.',
          },
          {
            id: 'approve-plan',
            name: 'Approve task plan',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You sign off on scope before tasks queue for sprint.',
          },
        ],
      },
    ],
  },

  // /soloflow:sprint — execute the queued tasks
  sprint: {
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'implement',
            name: 'Implement task',
            agent: 'executor',
            mcps: ['filesystem', 'bash', 'git'],
            retries: 3,
            desc: 'Implements one task. Reads CODE-PATTERNS.md, writes diff, runs checks.',
          },
          {
            id: 'write-tests',
            name: 'Write tests',
            agent: 'test-writer',
            mcps: ['filesystem', 'bash'],
            retries: 1,
            desc: 'Adds unit / integration tests for the diff before verification.',
          },
          {
            id: 'code-review',
            name: 'Code review',
            agent: 'code-reviewer',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Inline review of the diff — naming, layering, pattern compliance.',
          },
          {
            id: 'task-verify',
            name: 'Task verification',
            agent: 'verifier',
            mcps: ['filesystem', 'bash'],
            retries: 3,
            loopback: 'implement',
            desc: 'Checks acceptance criteria. Loops back to executor up to 3×.',
          },
          {
            id: 'visual-verify',
            name: 'Visual verification',
            agent: 'visual-verifier',
            mcps: ['maestro', 'playwright'],
            retries: 1,
            optional: true,
            desc: 'Snapshot diff via Maestro or Playwright.',
          },
        ],
      },
      {
        id: 'verify',
        label: 'Sprint review',
        color: '#a87a2c',
        steps: [
          {
            id: 'sprint-verify',
            name: 'Sprint verification',
            agent: 'verifier',
            mcps: ['filesystem', 'bash', 'playwright'],
            retries: 1,
            desc: 'Runs the full suite after the last task is archived.',
          },
          {
            id: 'sprint-review',
            name: 'Code review',
            agent: 'code-reviewer',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Taste pass over the whole sprint diff.',
          },
          {
            id: 'human-review',
            name: 'Human review',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'Final taste check before the sprint is sealed.',
          },
        ],
      },
    ],
  },

  // /soloflow:compound — pull learnings out of the most recent sprint
  compound: {
    id: 'compound',
    phases: [
      {
        id: 'compound',
        label: 'Compound',
        color: '#8b5cf6',
        steps: [
          {
            id: 'load-sprint',
            name: 'Load sprint artifacts',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Reads the sprint diff, verifier reports, and stuck-task notes.',
          },
          {
            id: 'extract',
            name: 'Extract learnings',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Drafts solution files for future sessions.',
          },
          {
            id: 'approve-learnings',
            name: 'Review and approve learnings',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You decide which learnings get merged into shared docs.',
          },
          {
            id: 'write-back',
            name: 'Write to solution files',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Persists approved learnings into CLAUDE.md / CODE-PATTERNS.md / backlog.',
          },
        ],
      },
    ],
  },

  // /soloflow:prune — sweep stale ideas, archived sprints, orphan tasks
  prune: {
    id: 'prune',
    phases: [
      {
        id: 'prune',
        label: 'Prune',
        color: '#8a4a4a',
        steps: [
          {
            id: 'scan',
            name: 'Scan .soloflow state',
            agent: 'pruner',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Walks .soloflow/ for archived sprints, stale ideas, orphan tasks.',
          },
          {
            id: 'propose',
            name: 'Propose deletions',
            agent: 'pruner',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Drafts a deletion plan with reasons. Nothing is removed yet.',
          },
          {
            id: 'approve-prune',
            name: 'Approve deletions',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You confirm what gets deleted. Default is keep everything.',
          },
          {
            id: 'execute-prune',
            name: 'Execute deletions',
            agent: 'pruner',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Removes approved entries and commits the cleanup.',
          },
        ],
      },
    ],
  },
};

// ─── Effective-definition resolution helpers ─────────────────────────────────
// Pure functions consumed on READ paths in both processes. Intentionally free
// of zod and of Node built-ins (fs/path/os) so they import in any environment;
// the STRICT write-path validation lives in
// main/src/orchestrator/workflowDefinitionSchema.ts (zod, main-only).

/**
 * Type guard: is `name` one of the built-in `CyboflowWorkflowName`s?
 */
export function isCyboflowWorkflowName(name: string): name is CyboflowWorkflowName {
  return (CYBOFLOW_WORKFLOW_NAMES as readonly string[]).includes(name);
}

/**
 * Narrow an unknown value to a structurally-valid `WorkflowStep`.
 * Lenient on optional fields; only the required `id`/`name`/`agent` are checked.
 */
function isValidStep(value: unknown): value is WorkflowStep {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.id === 'string' &&
    step.id.length > 0 &&
    typeof step.name === 'string' &&
    step.name.length > 0 &&
    typeof step.agent === 'string' &&
    step.agent.length > 0
  );
}

/**
 * Narrow an unknown value to a structurally-valid `WorkflowPhase`
 * (id/label/color present and at least one valid step).
 */
function isValidPhase(value: unknown): value is WorkflowPhase {
  if (typeof value !== 'object' || value === null) return false;
  const phase = value as Record<string, unknown>;
  if (typeof phase.id !== 'string' || phase.id.length === 0) return false;
  if (typeof phase.label !== 'string' || phase.label.length === 0) return false;
  if (typeof phase.color !== 'string' || phase.color.length === 0) return false;
  if (!Array.isArray(phase.steps) || phase.steps.length === 0) return false;
  return phase.steps.every(isValidStep);
}

/**
 * Defensively parse a `spec_json` column into a `WorkflowDefinition`.
 *
 * Runs on READ paths, so it is lenient and never throws. Returns `null` for
 * `null`/`undefined`/`''`/`'{}'`, for non-object or invalid JSON, and for any
 * structurally-invalid definition (no phases, or a phase/step missing required
 * fields). A non-null result is a structurally-valid `WorkflowDefinition`.
 *
 * NOTE: this is intentionally weaker than the zod write-path schema (which also
 * enforces kebab-case ids, hex colours, unique-id and loopback invariants).
 * Authoritative validation happens on the write path before persistence.
 */
export function parseWorkflowDefinition(
  specJson: string | null | undefined,
): WorkflowDefinition | null {
  if (specJson === null || specJson === undefined) return null;
  const trimmed = specJson.trim();
  if (trimmed === '' || trimmed === '{}') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (!Array.isArray(candidate.phases) || candidate.phases.length === 0) return null;
  if (!candidate.phases.every(isValidPhase)) return null;

  return candidate as unknown as WorkflowDefinition;
}

/**
 * Resolve the effective `WorkflowDefinition` for a workflow row.
 *
 * Resolution order:
 *   1. `spec_json` parses to a valid non-empty definition -> use it.
 *   2. else if `name` is a built-in -> `WORKFLOW_DEFINITIONS[name]`.
 *   3. else -> `null` (a custom flow whose spec is missing/broken is an error).
 */
export function resolveWorkflowDefinition(
  name: string,
  specJson: string | null | undefined,
): WorkflowDefinition | null {
  return (
    parseWorkflowDefinition(specJson) ??
    (isCyboflowWorkflowName(name) ? WORKFLOW_DEFINITIONS[name] : null)
  );
}
