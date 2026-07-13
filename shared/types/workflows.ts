/**
 * Shared types for the workflow registry and workflow run subsystem.
 *
 * These types are consumed by both the main process (WorkflowRegistry) and
 * the renderer (workflow picker, run-status views).  Keep this file free of
 * Node.js built-ins so it can be imported in any environment.
 */

import type { CliSubstrate } from './substrate';
import type { ExecutionModel } from './executionModel';
import type { VerificationType } from './visualVerification';
import type { WorkflowRunStatus } from './cyboflow';
import type { ArtifactType } from './artifacts';
import type { ExperimentArm } from './experiments';
import type { AgentModelAlias } from './agents';
import type { CliTool } from './cliTools';
import { SPRINT_BATCH_CAP } from './sprintBatch';

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
   * Side-by-side experiment id (migration 048) — soft link to experiments.id
   * (slice B owns that table). NULL for every non-experiment run. Stamped once at
   * createRun and immutable for the run. Sandboxes the arm's entity writes.
   */
  experiment_id?: string | null;
  /** Which arm of the experiment this run drives ('A' | 'B'; migration 048). NULL for non-experiment runs. */
  experiment_arm?: ExperimentArm | null;
  /**
   * Variant assignment (migration 048) — a SOFT link (no FK) to workflow_variants.id,
   * so a retired/deleted variant never orphans a historical run. NULL = baseline
   * (live-spec) run. Stamped once at createRun and immutable; the run froze the
   * variant's spec into spec_hash + workflow_revisions at the same time.
   */
  variant_id?: string | null;
  /** Denormalized variant label (migration 048) that survives variant rename/delete. NULL for baseline runs. */
  variant_label?: string | null;
  /**
   * The merge commit SHA where this run's code landed (migration 049), stamped at
   * merge close-out (stampSessionRunsOutcome 'merged'). NULL until merged (or when
   * the SHA read fails, fail-soft). Read by slice C's post-merge bug attribution.
   */
  merge_sha?: string | null;
  /**
   * Rotation-experiment attribution (migration 058) — the resolver stamps this at
   * pick time when a genuine weighted rotation assigns the run. SEPARATE from
   * experiment_id (the side-by-side sandbox tag) per the migration's CRITICAL
   * INVARIANT: rotation runs are normal runs. NULL for pins, baseline pins,
   * restarts, and non-rotation launches.
   */
  rotation_experiment_id?: string | null;
  /**
   * Layered visual-verification posture stamped at launch (migration 055) — the
   * third immutable run-stamp sibling to substrate / execution_model. Resolved
   * ONCE by visualVerificationResolver and never updated (a run can't change
   * posture mid-flight). 1 when this run participates in visual verification, 0
   * otherwise (the SQLite INTEGER 0/1 boolean). Reads back 0 for every legacy
   * row via the migration default (zero-behavior-change).
   */
  verify_enabled?: number;
  /**
   * Resolved VerificationType for the run, or NULL when verify_enabled=0
   * (migration 055). Stamped-but-dormant until the VerificationScheduler lands.
   */
  verify_type?: VerificationType | null;
  /**
   * JSON-encoded VisualBackendId[] — the live easy→hard fall-forward chain
   * (FALLBACK_CHAINS[type] ∩ host-available backends) resolved at launch, or
   * NULL when verify_enabled=0 (migration 055). The scheduler reads + walks it;
   * it is never rewritten on the row.
   */
  verify_chain?: string | null;
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
  /**
   * Denormalized variant label (migration 048) that survives variant
   * rename/delete — see `WorkflowRunRow.variant_label`. Surfaced on the list row
   * so the left-rail run chip and any other list-driven surface can render a
   * "Variant: <label>" tag without a second query. NULL for baseline
   * (non-variant) runs. Optional + additive, mirroring `model?`.
   */
  variant_label?: string | null;
  /**
   * A/B experiment membership (migration 048, slice B) surfaced on the list row
   * so list-driven surfaces (RunCenterPane experiment chip, left rail) can mark
   * side-by-side arm runs without a second query. NULL for non-experiment runs.
   * Optional + additive, mirroring `variant_label?`; the frontend `ActiveRunRow`
   * already declares the matching optional fields.
   */
  experiment_id?: string | null;
  experiment_arm?: ExperimentArm | null;
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
 * per item. Honored on BOTH planes: the programmatic host walks each resolved
 * item through `inner` mechanically with bounded concurrency (host-driven), and
 * the orchestrated plane derives a runtime-generated prompt instruction block
 * from this spec (see `main/src/orchestrator/prompts/fan-out-instructions.ts`)
 * that tells the orchestrator AGENT how to fan out and drive lanes itself. On
 * the programmatic plane an empty resolved item set still falls through to a
 * normal single step.
 */
export interface FanOutSpec {
  /** Runtime item-source key. v1 recognizes 'tasks' (→ batch lane task ids). */
  over: string;
  /** Ordered inner chain each item walks; ids form the lane step vocabulary. */
  inner: FanOutInnerStep[];
  /**
   * Max items dispatched concurrently for this step. Absent ⇒ DEFAULT
   * (SPRINT_BATCH_CAP = 5); `1` ⇒ serial per-item (one lane at a time, full
   * inner chain per item before the next starts). Integer ≥ 1.
   */
  maxConcurrency?: number;
}

/**
 * Resolve the effective per-step fan-out concurrency cap: the spec's explicit
 * `maxConcurrency` when set, else the SPRINT_BATCH_CAP default. Single source
 * of truth for both planes (programmatic wave sizing, orchestrated prompt
 * instructions) so neither can drift from the other.
 *
 * Hardened against invalid READ-path values: the editor's zod schema
 * (workflowDefinitionSchema.ts) rejects a non-positive/fractional cap on save,
 * but `parseWorkflowDefinition` only shape-checks phases/steps, so a frozen
 * spec_json written outside the editor (import, direct registry write, old
 * variant) can still carry e.g. `maxConcurrency: 0` — which, passed through
 * raw, makes the programmatic controller slice an empty wave and spin forever
 * (`ready.slice(0, 0)` never shrinks `remaining`). A non-finite value falls
 * back to the default cap; anything below 1 clamps to serial.
 */
export function effectiveMaxConcurrency(fanOut: FanOutSpec): number {
  const raw = fanOut.maxConcurrency;
  if (raw === undefined || !Number.isFinite(raw)) return SPRINT_BATCH_CAP;
  return Math.max(1, Math.floor(raw));
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
   * Optional parallel fan-out. When present AND an item set resolves, both
   * planes honor it — the programmatic host walks each item through
   * `fanOut.inner` driving a per-item lane, and the orchestrated agent receives
   * a derived prompt instruction block to fan out and drive lanes itself.
   * Additive — absent ⇒ a normal step (today's behavior), unchanged.
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
 * A workflow-scoped custom agent — a full embedded replacement for the base
 * agent's editable fields (mirrors `AgentEntry`'s description/systemPrompt/
 * tools/enabledMcps in `./agents`). Carrying its own copy rather than a
 * reference means editing the base agent later does NOT retroactively change
 * what this workflow runs.
 */
export interface WorkflowAgentCustomCopy {
  description: string;
  /** Non-empty — the full system prompt this workflow's agent runs with. */
  systemPrompt: string;
  tools: CliTool[];
  /** MCP server names this agent may call; mirrors `AgentEntry.enabledMcps`. */
  enabledMcps: string[];
}

/**
 * Per-workflow-agent override, keyed by agent key in
 * `WorkflowDefinition.agentConfigs` — the SAME vocabulary as `WorkflowStep.agent`
 * (e.g. `'sprint-review'`).
 *
 * Scope is per WORKFLOW-AGENT, not per step: every step (including fan-out
 * inner steps) binding this agent key shares the one config. Absence of a key
 * means the agent fully inherits from lower layers.
 *
 * Precedence (run side, low -> high): builtin -> project `agent_overrides` ->
 * this workflow's `agentConfigs` -> an A/B variant's agent delta. So this
 * layer beats the Agents-pane pin/body, but a variant delta still wins over it.
 *
 * An empty `{}` config (neither `model` nor `custom` set) carries no signal
 * and must NEVER be persisted — the workflow editor prunes it before write.
 */
export interface WorkflowAgentConfig {
  /**
   * Per-workflow model override for this agent. Beats the agent's own
   * Agents-pane pin; a variant agent delta still beats this.
   */
  model?: AgentModelAlias;
  /**
   * Full embedded copy of the base agent — a workflow-scoped custom agent.
   * When present it REPLACES the base body for runs of this workflow.
   */
  custom?: WorkflowAgentCustomCopy;
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
   * Optional per-workflow-agent config overlay, keyed by agent key (see
   * `WorkflowAgentConfig`). Absent -> no overlay, every agent this workflow
   * binds resolves purely from the builtin/agent_overrides/variant layers.
   */
  agentConfigs?: Record<string, WorkflowAgentConfig>;
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
  // end; N=1 degenerates to a normal single-task sprint. The inner chain's
  // `loopback: 'implement'` fields encode today's "on failure, re-delegate to
  // implement" behavior as data, consumed by the orchestrated prompt generator;
  // the programmatic controller does not yet re-drive on them in v1.
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
            // Honored on BOTH planes (consolidated — was programmatic-only). On the
            // programmatic plane the host walks each task through this inner chain,
            // driving one sprint lane per task. On the orchestrated plane the runtime
            // prompt generator (fan-out-instructions.ts) derives an instruction block
            // from this spec telling the orchestrator agent how to fan out and drive
            // lanes itself via cyboflow_update_sprint_task. The 5 inner ids EQUAL
            // SPRINT_LANE_STEP_IDS in order so the lane vocabulary + swimlane UI
            // render identically regardless of which plane drove them.
            fanOut: {
              over: 'tasks',
              inner: [
                { id: 'implement', agent: 'implement', name: 'Implement' },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
                { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
                {
                  id: 'visual-verify',
                  agent: 'visual-verify',
                  name: 'Visual check',
                  optional: true,
                  loopback: 'implement',
                },
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

  // compound — mine recently merged runs for durable learnings and fold the
  // approved ones back as PROPOSED IMPROVEMENTS in three buckets: quick (an
  // in-place fix), doc (a CLAUDE.md/CODE-PATTERNS.md edit applied in-place at
  // write-back), and task (cyboflow_create_task). It NEVER emits 'finding' items
  // — a finding is Compound's input, not its output. The 'extract' step publishes
  // a 'compound-recommendations' artifact (the summary doc the human reads at the
  // approve-learnings gate). FIVE steps in a single 'Compound' phase with exactly
  // TWO human gates: approve-learnings (approve the PLAN) sits between extract and
  // write-back, and a terminal 'human-review' step is the final "merge in changes"
  // gate over the applied diff — modelled on sprint/ship's human-review, EXCEPT it
  // is eval-exempt (snapshotRunForEval skips 'compound' by name, so the
  // human-review trigger never rubric-grades a compound diff). write-back applies
  // every approved change in-place + commits and emits NO review items; the
  // human-review step is the only final gate. No per-edit or per-drop decisions.
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
            desc: 'Gather the session diff + raw run data for recently merged/completed runs; the compounder returns ONLY a Merged work summary here — no learnings and no discarded list yet (those come at extract), and nothing is filed as a review item.',
          },
          {
            id: 'extract',
            name: 'Extract learnings',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            outputArtifact: { atype: 'compound-recommendations', label: 'Recommendations' },
            desc: 'Draft durable learnings (quick / doc / task, NEVER findings) plus a discarded list, then publish ONE compound-recommendations doc with an Act on section and a Discarded section — the single surface the gate reviews. Discarded candidates go in the doc, never the review queue.',
          },
          {
            id: 'approve-learnings',
            name: 'Approve learnings',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'Review the recommendations doc; decide which quick fixes / doc edits / tasks apply before write-back.',
          },
          {
            id: 'write-back',
            name: 'Write back',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            desc: "Apply EVERY approved item in-place (quick fixes AND approved CLAUDE.md/CODE-PATTERNS.md doc edits) + create approved tasks + commit + post a concise summary of what was applied. Emits NO review items — the terminal human-review step is the final gate. NEVER a decision per edit, NEVER per discarded candidate, NEVER kind:'finding'.",
          },
          {
            id: 'human-review',
            name: 'Human review',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'Final "merge in changes" gate over the applied compound diff — review the committed quick fixes + doc edits and the recommendations doc, then approve to make the branch mergeable or reject to leave it unadopted. Same as a sprint/ship human-review, but does not trigger an eval.',
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
            // Mirrors sprint's execute-tasks fanOut block byte-for-byte — ship's
            // Execute phase IS the sprint execute phase, just concatenated after
            // planning + materialize. See the sprint definition above for the full
            // both-planes contract note.
            fanOut: {
              over: 'tasks',
              inner: [
                { id: 'implement', agent: 'implement', name: 'Implement' },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
                { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
                {
                  id: 'visual-verify',
                  agent: 'visual-verify',
                  name: 'Visual check',
                  optional: true,
                  loopback: 'implement',
                },
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
