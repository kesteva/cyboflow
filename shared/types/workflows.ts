/**
 * Shared types for the workflow registry and workflow run subsystem.
 *
 * These types are consumed by both the main process (WorkflowRegistry) and
 * the renderer (workflow picker, run-status views).  Keep this file free of
 * Node.js built-ins so it can be imported in any environment.
 */

import type { CliSubstrate } from './substrate';
import type { ExecutionModel } from './executionModel';
import type { WorkflowRunStatus } from './cyboflow';
import type { ArtifactType } from './artifacts';
import type { ExperimentArm } from './experiments';

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
  /**
   * Scope of the workflow (migration 030): NULL ⇒ GLOBAL (a `wf-global-<name>`
   * built-in or a `wf-global-custom-<hex>` custom flow, shown across all
   * projects); an integer ⇒ project-scoped (a `wf-<projectId>-custom-<hex>` flow,
   * an edited per-project built-in preserved by 030, or the `wf-<projectId>-__quick__`
   * sentinel). There is no separate scope column.
   */
  project_id: number | null;
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
  /** Sprint lane batch (migration 022) — soft link to sprint_batches.id. Stamped at launch on a session-hosted 'sprint' run seeded with taskIds (SprintLaneStore.createForRun); NULL for every other run. */
  batch_id?: string | null;
  /** Selected finding ids (review_items.id) seeded into a compound run at launch,
   *  JSON-encoded string array (migration 034). NULL for non-compound runs.
   *  Parsed + injected by RunExecutor.getPrompt buildSelectedFindingsBlock,
   *  and read by the terminal-seam close-out to clear selected on un-resolved
   *  findings. Mirrors seed_idea_id (017). */
  seed_finding_ids?: string | null;
  /** sha256 hex of the workflow's spec_json frozen at run creation (computeSpecHash; migration 026). Lets Insights bucket runs by the exact workflow revision they executed even after the workflow's spec_json is edited. NULL for historic runs / runs created before 026. */
  spec_hash?: string | null;
  /**
   * DB-canonical close-out signal set on terminal close-out. NULL while the run
   * is in flight (migration 014). `'integrated'` (migration 022 / feat/parallel-sprint)
   * is the per-task close-out outcome: the run's branch was merged into the batch
   * integration branch (not main). The plain TEXT column has no SQL CHECK, so this
   * is a TypeScript-union-only addition.
   */
  outcome?: 'merged' | 'integrated' | 'pr_open' | 'dismissed' | 'failed' | 'canceled' | null;
  /** Base branch captured at launch — future git triage only, NOT a hot path (migration 014). */
  base_branch?: string | null;
  /** Base SHA captured at launch — future git triage only (migration 014). */
  base_sha?: string | null;
  /** step->agent map frozen at launch; stable overlay across mid-run workflow edits (migration 014). */
  steps_snapshot_json?: string | null;
  /** CLI substrate stamped at launch ('sdk' | 'interactive'). Resolved once and immutable for the run. Reads back 'sdk' for every legacy row. IDEA-013 / TASK-806. */
  substrate?: CliSubstrate;
  /**
   * Execution model stamped at launch ('orchestrated' | 'programmatic') — the
   * sibling immutable stamp to `substrate` (migration 032). Decides WHO walks the
   * run's DAG: the orchestrator agent ('orchestrated', today's behavior + the
   * only model the interactive substrate can run) or host code ('programmatic',
   * SDK only). Resolved once and immutable; reads back 'orchestrated' for every
   * legacy row. Stamped-but-dormant until the programmatic consumer lands.
   */
  execution_model?: ExecutionModel;
  /**
   * Per-run Claude model alias pinned at launch ('fable' | 'opus' | 'opus-250k' |
   * 'sonnet' | 'haiku' | 'auto'), resolved to a concrete snapshot at the spawn seam
   * (modelContext.resolveModelAlias). Stamped once at createRun, immutable for the
   * run (migration 037). NULL — and the migrated state of every legacy row — means
   * "no pin": RunExecutor passes no `model` to the spawner so the bundled Agent SDK
   * uses its own default. 'auto' resolves identically to NULL at the seam. Read
   * FRESH per spawn by RunExecutor.buildOptionsOverrides.
   */
  model?: string | null;
  /**
   * Per-run code-review-eval override pinned at launch (migration 044): 1 = force
   * ON, 0 = force OFF, NULL (the migrated state of every legacy row) = INHERIT the
   * global `codeReviewEvalEnabled` app-config toggle. Stamped once at createRun,
   * immutable for the run. Read at the trigger seam (snapshotRunForEval) to decide
   * whether the K=3 Opus jury pass fires; a per-run ON does NOT bypass the
   * built-ins-only isCyboflowWorkflowName gate.
   */
  eval_enabled?: number | null;
  /**
   * Side-by-side experiment id (migration 046) — soft link to experiments.id
   * (slice B owns that table). NULL for every non-experiment run. Stamped once at
   * createRun and immutable for the run. Sandboxes the arm's entity writes.
   */
  experiment_id?: string | null;
  /** Which arm of the experiment this run drives ('A' | 'B'; migration 046). NULL for non-experiment runs. */
  experiment_arm?: ExperimentArm | null;
  /**
   * Variant assignment (migration 046) — a SOFT link (no FK) to workflow_variants.id,
   * so a retired/deleted variant never orphans a historical run. NULL = baseline
   * (live-spec) run. Stamped once at createRun and immutable; the run froze the
   * variant's spec into spec_hash + workflow_revisions at the same time.
   */
  variant_id?: string | null;
  /** Denormalized variant label (migration 046) that survives variant rename/delete. NULL for baseline runs. */
  variant_label?: string | null;
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
  /** Sprint lane batch (migration 022) — soft link to sprint_batches.id; stamped on seeded 'sprint' runs, NULL for every other run. */
  batch_id?: string | null;
  /**
   * Per-run pinned model alias (migration 037) — the user-facing alias stamped
   * onto workflow_runs.model at launch (Configure surface), resolved to a concrete
   * snapshot at the spawn seam. Surfaced on the list row so the run composer can
   * show a READ-ONLY model pill. NULL/'auto' → no pin (SDK default), so the pill
   * is omitted. Optional + additive, mirroring `substrate?` (fixtures unaffected).
   */
  model?: string | null;
  /**
   * Execution model stamped at creation (migration 032): 'programmatic' runs are
   * host-driven DAG walks, 'orchestrated' runs are single agent turns. Surfaced on
   * the list row so the failed-run summary can gate its "Retry failed step" CTA
   * (runs.retryStep is programmatic-only). Optional + additive, mirroring
   * `substrate?` (fixtures unaffected). NULL on legacy pre-032 rows.
   */
  execution_model?: 'orchestrated' | 'programmatic' | null;
  /**
   * Per-run agent permission mode (resolved + stamped at creation by
   * permissionModeResolver, mutable at runtime via runs.setPermissionMode — ISSUE
   * #2). Surfaced on the list row so the run composer's PermissionModePill can
   * show the current value; the executor re-reads it FRESH per spawn so a change
   * governs the next turn.
   */
  permission_mode_snapshot: PermissionMode;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  stuck_reason: string | null;
  /**
   * Failure reason stamped by the `failed` transition (transitionToFailed) — e.g. a
   * terminal SDK Session Error like "You've hit your limit · resets 7:10pm". NULL on
   * any non-failed run. Surfaced so the end-of-workflow panel can show WHY a run
   * failed (WorkflowSummaryPanel). Optional + additive (fixtures unaffected).
   */
  error_message?: string | null;
}

/**
 * The four user-facing built-in flows in cyboflow v1.
 *
 * Narrowed from the historical SoloFlow set of five: `planner`, `sprint`,
 * `compound`, and `ship` are cyboflow-native flows that write via the
 * `cyboflow_*` MCP tools, never `.soloflow/` files. The dropped `prune` flow
 * keeps its prose under `docs/workflows-future/` for a future rebuild. The
 * internal `__quick__` sentinel is NOT a member here — it is filtered out of the
 * picker and handled separately by the quick-session pipeline.
 *
 * A parallel sprint is a SINGLE session-hosted `sprint` run seeded with N task
 * ids: the sprint ORCHESTRATOR AGENT analyzes the task dependency DAG itself,
 * then fans out per-task subagents with bounded concurrency in the shared
 * session worktree. Per-task progress is tracked as "lanes" in the
 * `sprint_batch_tasks` table (migration 022) via the
 * `cyboflow_update_sprint_task` MCP tool and rendered in the run progress rail.
 * The former scheduler-internal trio (`task` / `sprint-init` /
 * `sprint-finalize`) is gone — stale `wf-<pid>-<trio>` rows in existing DBs are
 * hidden by the `resolveWorkflowDefinition` filter in
 * `WorkflowRegistry.listByProject`.

 */
export const CYBOFLOW_WORKFLOW_NAMES = ['planner', 'sprint', 'compound', 'ship'] as const;

export type CyboflowWorkflowName = (typeof CYBOFLOW_WORKFLOW_NAMES)[number];

// ─── Phase / Step data model ─────────────────────────────────────────────────

/**
 * One inner step of a fan-out chain. The host walks EACH resolved item through
 * the inner chain sequentially; `id` becomes the lane `currentStepId` vocabulary
 * for the owning fanOut step (generalizing SPRINT_LANE_STEP_IDS).
 */
export interface FanOutInnerStep {
  /** Stable kebab-case id — becomes a lane currentStepId value. */
  id: string;
  /** Agent id string (delegates to cyboflow-<agent>); same contract as WorkflowStep.agent. */
  agent: string;
  /** When true a failed inner step is skipped (lane continues) rather than failing the item. */
  optional?: boolean;
  /** Intra-chain loopback target id (v1: reserved/simple — see controller note). */
  loopback?: string;
  /** Human-readable name for prompts/UI; falls back to id when absent. */
  name?: string;
}

/**
 * Declares an OUTER step as a parallel per-item fan-out. The host resolves the
 * runtime item set keyed by `over` (e.g. 'tasks' → the run's batch lane task ids)
 * and walks each item through `inner` with bounded concurrency, driving a lane
 * per item. ONLY honored on the programmatic plane; ignored (the step runs as a
 * normal single agent step) on the orchestrated plane and whenever no item set
 * resolves.
 */
export interface FanOutSpec {
  /** Runtime item-source key. v1 recognizes 'tasks' (→ batch lane task ids). */
  over: string;
  /** Ordered inner chain each item walks; ids form the lane step vocabulary. */
  inner: FanOutInnerStep[];
}

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
  /**
   * Optional parallel fan-out. When present AND the run is programmatic AND an
   * item set resolves, the host walks each item through `fanOut.inner` driving a
   * per-item lane. Additive — absent ⇒ a normal step (today's behavior).
   */
  fanOut?: FanOutSpec;
  /**
   * When set, this step produces a run artifact on completion. The orchestrator
   * auto-mints an artifact of `atype` (re-derived from the entity DB for
   * templated types) when the step finishes, and the Flow/Workflow-steps views
   * render a "creates ⟨artifact⟩" footer chip. See shared/types/artifacts.ts.
   */
  outputArtifact?: {
    atype: ArtifactType;
    label: string;
  };
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
 * The status a step REPORTS to the live timeline — every step status except the
 * initial 'pending' placeholder (a step is never reported back to 'pending').
 * Shared by the three programmatic reporter layers so they can't drift:
 * `ControllerHost.reportStep` → `StepReporter.report` → the
 * `buildStepTransitionEvent` adapter. 'failed' / 'skipped' are the terminal
 * markers surfaced in the step timeline (migration 033 outcomes 'rejected' /
 * 'canceled' intentionally still report 'done' — see WorkflowController).
 */
export type WorkflowStepReportStatus = 'running' | 'done' | 'failed' | 'skipped';

/**
 * Runtime state snapshot for a single workflow step during a live run.
 * Consumed by the progress rail and the tRPC subscription (TASK-766).
 */
export interface WorkflowStepState {
  stepId: string;
  status: 'pending' | WorkflowStepReportStatus;
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
 * The three built-in workflow definitions, keyed by `CyboflowWorkflowName`.
 * `Readonly<Record<…>>` forces the compiler to flag any missing key.
 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<CyboflowWorkflowName, WorkflowDefinition>> = {

  // planner — idea → epics → tasks (board stages 1-6), terminal decompose archives the idea; writes via cyboflow_* MCP tools
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
            agent: 'context',
            mcps: ['filesystem', 'web-search'],
            retries: 0,
            desc: "Parse the user's prompt, scan the codebase, capture the idea in the DB.",
            outputArtifact: { atype: 'idea-spec', label: 'Idea spec' },
          },
          {
            id: 'research',
            name: 'Research',
            agent: 'research',
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
            id: 'ui-prototype',
            name: 'UI prototype',
            agent: 'ui-prototype',
            mcps: ['filesystem'],
            retries: 1,
            optional: true,
            desc: 'Optional interactive mockup when the idea has meaningful UI surface.',
            outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
          },
          {
            id: 'architecture',
            name: 'Architecture design',
            agent: 'architecture',
            mcps: ['filesystem'],
            retries: 1,
            optional: true,
            desc: 'Optional architecture proposal when the change is structurally complex.',
            outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
          },
          {
            id: 'approve-design',
            name: 'Approve design',
            agent: 'human',
            mcps: [],
            retries: 0,
            optional: true,
            human: true,
            desc: 'You review the prototype and/or architecture before decomposition. Skipped when neither ran.',
          },
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'epics',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Decompose the idea into epics with dependency edges.',
          },
          {
            id: 'tasks',
            name: 'Fill out task details',
            agent: 'tasks',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Capture each task via cyboflow_create_task with acceptance criteria.',
            outputArtifact: { atype: 'decomposed-stories', label: 'Decomposed stories' },
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
          {
            id: 'decompose',
            name: 'Archive idea',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'Confirm archiving the idea(s) to Decomposed; ends the run.',
          },
        ],
      },
    ],
  },

  // sprint — execute N ready tasks (board stages 7-10) in ONE session-hosted
  // run. The orchestrator agent analyzes the dependency DAG, fans out per-task
  // subagents with bounded concurrency, and reports per-task lane progress via
  // cyboflow_update_sprint_task. One holistic verify/review/human gate at the
  // end; N=1 degenerates to a normal single-task sprint. No loopback fields —
  // re-delegation to a fresh subagent is prose-driven, not runner-driven.
  sprint: {
    id: 'sprint',
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
            desc: 'Maps task→task blocking edges across the batch to derive the fan-out order.',
          },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: ['filesystem'],
            retries: 3,
            desc: 'Parallel per-task fan-out — per-task progress in sprint lanes',
            // Inert on the orchestrated plane (the agent reads sprint.md and drives lanes
            // via the cyboflow_update_sprint_task MCP; host.fanOut is undefined). On the
            // programmatic plane the host walks each task through this inner chain, driving
            // one sprint lane per task. The 5 inner ids EQUAL SPRINT_LANE_STEP_IDS in order
            // so the lane vocabulary + swimlane UI render identically.
            fanOut: {
              over: 'tasks',
              inner: [
                { id: 'implement', agent: 'implement', name: 'Implement' },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests' },
                { id: 'code-review', agent: 'code-review', name: 'Code review' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify' },
                { id: 'visual-verify', agent: 'visual-verify', name: 'Visual check', optional: true },
              ],
            },
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
            agent: 'sprint-verify',
            mcps: ['filesystem', 'bash', 'playwright'],
            retries: 1,
            desc: 'Runs the full suite after the last task is archived.',
          },
          {
            id: 'sprint-review',
            name: 'Code review',
            agent: 'sprint-review',
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

  // compound — mine recently merged runs for durable learnings and fold them
  // back as clean-up tasks (cyboflow_create_task) + review-queue items
  // (cyboflow_report_finding: 'finding' observations, 'decision' doc edits).
  // Single 'Compound' phase; the approve-learnings human gate sits between the
  // draft and the write-back so nothing lands without sign-off.
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
            name: 'Load merged work',
            agent: 'compounder',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Gather the session diff + raw run data for recently merged/completed runs.',
          },
          {
            id: 'extract',
            name: 'Extract learnings',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Draft durable learnings with computed impact (token deltas, recurrence counts).',
          },
          {
            id: 'approve-learnings',
            name: 'Approve learnings',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You decide which learnings become tasks / doc edits before any write-back.',
          },
          {
            id: 'write-back',
            name: 'Write back',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Apply only approved items: create tasks + emit findings via cyboflow_*.',
          },
        ],
      },
    ],
  },

  // ship — planner (idea → epics → tasks) concatenated with sprint (execute
  // every task to integration) in ONE continuous orchestrated run. The existing
  // approve-plan human gate doubles as the pre-execution gate: the human
  // approves the plan AND selects which tasks execute now. At materialize-batch
  // the orchestrator calls cyboflow_create_sprint_batch to mint the sprint batch
  // + lanes and stamp workflow_runs.batch_id (the handoff seam). The original
  // idea is retired to the terminal Decomposed board stage at the FINAL
  // human-review gate (on Approve), prose-driven via cyboflow_set_task_stage —
  // not earlier. Planner's terminal 'decompose' step is dropped; sprint's 'plan'
  // phase id is renamed 'sprint-plan' to avoid colliding with planner's 'plan'.
  ship: {
    id: 'ship',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          {
            id: 'context',
            name: 'Get context on user idea',
            agent: 'context',
            mcps: ['filesystem', 'web-search'],
            retries: 0,
            desc: "Parse the user's prompt, scan the codebase, capture the idea in the DB.",
          },
          {
            id: 'research',
            name: 'Research',
            agent: 'research',
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
            id: 'ui-prototype',
            name: 'UI prototype',
            agent: 'ui-prototype',
            mcps: ['filesystem'],
            retries: 1,
            optional: true,
            desc: 'Optional interactive mockup when the idea has meaningful UI surface.',
            outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
          },
          {
            id: 'architecture',
            name: 'Architecture design',
            agent: 'architecture',
            mcps: ['filesystem'],
            retries: 1,
            optional: true,
            desc: 'Optional architecture proposal when the change is structurally complex.',
            outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
          },
          {
            id: 'approve-design',
            name: 'Approve design',
            agent: 'human',
            mcps: [],
            retries: 0,
            optional: true,
            human: true,
            desc: 'You review the prototype and/or architecture before decomposition. Skipped when neither ran.',
          },
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'epics',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Decompose the idea into epics with dependency edges.',
          },
          {
            id: 'tasks',
            name: 'Fill out task details',
            agent: 'tasks',
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
            desc: 'You sign off on scope and select which tasks execute now before they queue for the sprint.',
          },
        ],
      },
      {
        id: 'materialize',
        label: 'Materialize',
        color: '#8a6d3b',
        steps: [
          {
            id: 'materialize-batch',
            name: 'Materialize sprint batch',
            agent: 'implement',
            mcps: ['filesystem'],
            retries: 1,
            desc: 'Mint the sprint batch + lanes from the approved tasks; stamp batch_id.',
          },
        ],
      },
      {
        id: 'sprint-plan',
        label: 'Sprint plan',
        color: '#5a4ad6',
        steps: [
          {
            id: 'analyze-dependencies',
            name: 'Analyze dependencies',
            agent: 'dependency-analyzer',
            mcps: ['filesystem'],
            retries: 1,
            desc: 'Maps task→task blocking edges across the batch to derive the fan-out order.',
          },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: ['filesystem'],
            retries: 3,
            desc: 'Parallel per-task fan-out — per-task progress in sprint lanes',
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
            agent: 'sprint-verify',
            mcps: ['filesystem', 'bash', 'playwright'],
            retries: 1,
            desc: 'Runs the full suite after the last task is archived.',
          },
          {
            id: 'sprint-review',
            name: 'Code review',
            agent: 'sprint-review',
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
            desc: 'Final taste check; on approve, retire the idea to Decomposed and seal the sprint.',
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
