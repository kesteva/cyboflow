/**
 * Shared types for the workflow registry and workflow run subsystem.
 *
 * These types are consumed by both the main process (WorkflowRegistry) and
 * the renderer (workflow picker, run-status views).  Keep this file free of
 * Node.js built-ins so it can be imported in any environment.
 */

import type { CliSubstrate } from './substrate';
import type { WorkflowRunStatus } from './cyboflow';

/**
 * Workflow-run permission contract consumed by the SDK PreToolUse mapper
 * (`permissionModeMapper.buildPreToolUseHook`), the frontmatter extractor in
 * `WorkflowRegistry`, the run snapshot, and the blueprint editor.
 *
 * This is intentionally DISTINCT from the session/panel permission contract in
 * `./permissionMode` (`'approve' | 'ignore'`): the two surfaces have different
 * vocabularies and different consumers, and `interactiveSettingsWriter`
 * treats them as parallel (`'ignore'`/`'dontAsk'`). Do NOT collapse them.
 *
 * Mode semantics:
 *  - 'default'     → ask before edits (every PreToolUse routed for approval)
 *  - 'acceptEdits' → auto-allow Edit/Write/MultiEdit; route the rest
 *  - 'auto'        → NATIVE Claude auto-mode (the model classifier owns gating
 *                    via `--permission-mode auto` / `sdkOptions.permissionMode`);
 *                    NO PreToolUse approval hook participates
 *  - 'dontAsk'     → run unrestricted (no hook; --dangerously-skip-permissions)
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk';

/**
 * Canonical ordered list of the four user-facing permission modes.
 * Single source of truth for the union above; imported by the
 * permissionModeResolver and any UI that needs to enumerate modes.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk'] as const;

/** Runtime guard for an untyped value (config row, IPC payload) being a PermissionMode. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

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
  /**
   * Single source of truth: `WorkflowRunStatus` in ./cyboflow (10 values incl.
   * 'awaiting_input' and 'paused'). Previously a hand-mirrored inline union that
   * had drifted (it lacked 'awaiting_input'); importing the canonical type kills
   * the duplicate and keeps this in lockstep with the DB CHECK + state machine.
   */
  status: WorkflowRunStatus;
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
  /** Soft polymorphic link to the idea injected as the planner's first input at launch (migration 017). NULL for non-planner runs / free-launch. NOT a stage-derivation source — distinct from task_id. */
  seed_idea_id?: string | null;
  /** SDK conversation id captured from the run's first system/init event (migration 018). Used by nudgeRunHandler to re-spawn with `--resume` so an idle-chat nudge continues the same conversation. NULL until the first init event / for runs that never spawned. */
  claude_session_id?: string | null;
  /** Parent session (migration 019) — soft link to sessions.id, NULL for legacy parentless flow runs. */
  session_id?: string | null;
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
  /** Parent session (migration 019) — soft link to sessions.id, NULL for legacy parentless flow runs. The left-rail will group runs by session_id in Phase 3. */
  session_id?: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  stuck_reason: string | null;
}

/**
 * All built-in flow names in cyboflow v1 — the two user-facing flows
 * (`planner` / `sprint`) PLUS the three scheduler-internal parallel-sprint flows
 * (`task` / `sprint-init` / `sprint-finalize`, the `feat/parallel-sprint` epic).
 *
 * Narrowed from the historical SoloFlow set of five (the dropped
 * `soloflow` / `compound` / `prune` flows have their prose preserved under
 * `docs/workflows-future/` for a future cyboflow-native rebuild). The internal
 * `__quick__` sentinel is NOT a member here — it is filtered out of the picker
 * and handled separately by the quick-session pipeline.
 *
 * The three parallel-sprint flows are kept in this set (so `WORKFLOW_DEFINITIONS`
 * typing stays honest and the registry seeds DB rows the scheduler can launch by
 * `wf-<projectId>-<name>`), but are marked `internal: true` on their definition
 * and filtered out of the user-facing picker via `isInternalWorkflowName` (see
 * `WorkflowRegistry.listByProject`). They are launched by the
 * `SprintBatchScheduler`, never selected by hand. See
 * `docs/parallel-sprint-design.md` §5.
 */
export const CYBOFLOW_WORKFLOW_NAMES = [
  'planner',
  'sprint',
  'task',
  'sprint-init',
  'sprint-finalize',
] as const;

export type CyboflowWorkflowName = (typeof CYBOFLOW_WORKFLOW_NAMES)[number];

/**
 * The user-facing subset of `CYBOFLOW_WORKFLOW_NAMES` — the flows a human may
 * launch by hand from the `WorkflowPicker`. The remaining names are
 * scheduler-internal (`internal: true`) and never appear in the picker.
 *
 * This is the AUTHORITATIVE allowlist of pickable flows; the runtime filter
 * (`isInternalWorkflowName`) is derived from `WORKFLOW_DEFINITIONS[*].internal`
 * so the two can never drift — adding a flow with `internal: true` removes it
 * from the picker automatically.
 */
export const CYBOFLOW_USER_WORKFLOW_NAMES = ['planner', 'sprint'] as const;

export type CyboflowUserWorkflowName = (typeof CYBOFLOW_USER_WORKFLOW_NAMES)[number];

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
  /**
   * When true this flow is scheduler-internal and MUST NOT appear in the
   * user-facing workflow picker — it is launched programmatically (e.g. by the
   * `SprintBatchScheduler` for the parallel-sprint `task` / `sprint-init` /
   * `sprint-finalize` flows), never selected by hand. Defaults to `false`
   * (omitted) for the user-facing built-ins and all custom flows. The picker
   * filter (`WorkflowRegistry.listByProject`) is derived from this flag via
   * `isInternalWorkflowName` so the two never drift.
   */
  internal?: boolean;
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
 * The two built-in workflow definitions, keyed by `CyboflowWorkflowName`.
 * `Readonly<Record<…>>` forces the compiler to flag any missing key.
 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<CyboflowWorkflowName, WorkflowDefinition>> = {

  // planner — idea → epics → tasks (board stages 1-6); writes via cyboflow_* MCP tools
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
            desc: "Parse the user's prompt, scan the codebase, capture the idea in the DB.",
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
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Decompose the idea into epics with dependency edges.',
          },
          {
            id: 'tasks',
            name: 'Fill out task details',
            agent: 'task-refiner',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Capture each task via cyboflow_create_task with acceptance criteria.',
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

  // sprint — execute ready tasks (board stages 7-10); emits findings via cyboflow_report_finding
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
            desc: 'Taste pass over the whole sprint diff; emit issues via cyboflow_report_finding.',
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

  // ── Parallel-sprint internal flows (feat/parallel-sprint, internal: true) ──
  // Launched programmatically by the SprintBatchScheduler — never shown in the
  // user-facing picker. See docs/parallel-sprint-design.md §5.

  // task — a single batch task's Phase-1 execution (no verify phase, no human
  // gate, no session). A trimmed copy of sprint's `execute` phase: same five
  // step ids/agents. Clean drain → awaiting_review, which the scheduler treats
  // as "ready to integrate".
  task: {
    id: 'task',
    internal: true,
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
    ],
  },

  // sprint-init — batch planning. A single-step flow whose orchestrator delegates
  // to cyboflow-dependency-analyzer and writes the returned blocking edges via
  // cyboflow_add_task_dependency. Clean drain → awaiting_review flips the batch
  // planning → running.
  'sprint-init': {
    id: 'sprint-init',
    internal: true,
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#5a4ad6',
        steps: [
          {
            id: 'analyze-dependencies',
            name: 'Analyze dependencies',
            agent: 'dependency-analyzer',
            mcps: ['filesystem'],
            retries: 1,
            desc: 'Proposes task→task blocking edges across the batch; orchestrator writes them via cyboflow_add_task_dependency.',
          },
        ],
      },
    ],
  },

  // sprint-finalize — batch Phase-2: the single human gate for the whole sprint.
  // The `verify` phase lifted out of sprint, operating over the integration
  // branch's aggregate diff. human-review parks the run at awaiting_input.
  'sprint-finalize': {
    id: 'sprint-finalize',
    internal: true,
    phases: [
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
            desc: 'Runs the full suite over the integration branch after every task is integrated.',
          },
          {
            id: 'sprint-review',
            name: 'Code review',
            agent: 'code-reviewer',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Taste pass over the whole sprint diff; emit issues via cyboflow_report_finding.',
          },
          {
            id: 'human-review',
            name: 'Human review',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'The single human gate for the whole sprint before merge to main.',
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
 * Is `name` a scheduler-INTERNAL built-in flow (`internal: true` on its
 * `WORKFLOW_DEFINITIONS` entry)?
 *
 * Derived from the definition flag rather than a hand-maintained list, so the
 * picker filter (`WorkflowRegistry.listByProject`) can never drift from the
 * definitions. A non-built-in name (custom flow) is never internal — custom
 * flows are always user-launchable. Returns `false` for unknown names.
 */
export function isInternalWorkflowName(name: string): boolean {
  return isCyboflowWorkflowName(name) && WORKFLOW_DEFINITIONS[name].internal === true;
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
