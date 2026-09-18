/**
 * Shared types for the workflow registry and workflow run subsystem.
 *
 * These types are consumed by both the main process (WorkflowRegistry) and
 * the renderer (workflow picker, run-status views).  Keep this file free of
 * Node.js built-ins so it can be imported in any environment.
 */

import type { CliSubstrate } from './substrate';
import type {
  AgentProvider,
  WorkflowLaunchableRuntime,
  WorkflowRunStorableRuntime,
} from './agentRuntime';
import type { ExecutionModel } from './executionModel';
import type { VerificationType } from './visualVerification';
import type { WorkflowRunStatus } from './cyboflow';
import type { ArtifactType } from './artifacts';
import type { ExperimentArm } from './experiments';
import type { AgentModelAlias } from './agents';
import type { ReasoningEffort } from './reasoningEffort';
import type { CliTool } from './cliTools';
import { SPRINT_BATCH_CAP } from './sprintBatch';
// Type-only, so the shared/tuning -> shared/types edge stays one-directional at
// runtime (workflowTuning imports the definitions from here; this import is
// erased at compile time and creates no cycle).
import type { TuningLevel } from '../tuning/workflowTuning';
// Same one-directional-at-runtime discipline as the TuningLevel import above:
// runtimeMix.ts imports the definitions from here, and this type-only import is
// erased at compile time.
import type { RuntimeMix } from '../tuning/runtimeMix';

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
   *
   * Since migration 122 this doubles as the dedicated CUSTOM SLOT: it is
   * written only by the Advanced editor / MCP writer, never by the tuning dial,
   * and it is what `tuning_level === 'custom'` resolves. See
   * {@link hasCustomSpecSlot}.
   */
  spec_json: string;
  /**
   * Tuning level (migration 122): which definition this workflow resolves.
   * `'standard'` = the as-authored built-in (the identity — today's behaviour
   * byte for byte), `'efficient'`/`'thorough'` = the calibrated presets applied
   * to the built-in at READ time, `'custom'` = {@link spec_json}.
   *
   * Required (not optional), for the same reason `archived_at` is: every
   * `WorkflowRow`-producing SELECT must project it explicitly or an omitted
   * column would silently resolve to `undefined` and read as "not custom".
   */
  tuning_level: TuningLevel;
  /**
   * Runtime mix (migration 128): WHICH PROVIDER runs each step — `'claude'` (the
   * identity: Claude executes and verifies, today's behaviour byte for byte),
   * `'claude-primary'` / `'codex-primary'` (one provider executes, the other
   * verifies), `'codex'` (everything on Codex). Orthogonal to
   * {@link tuning_level}, which decides which steps run and at what tier·effort.
   *
   * Unlike the level, the mix is materialized ONLY at `createRun`'s spec freeze
   * (`materializeForLevelAndMix`) and never on the read path — see
   * `shared/tuning/runtimeMix.ts`. An Advanced-editor spec save therefore does
   * NOT touch it (it flips `tuning_level` to `'custom'` and leaves the mix alone).
   *
   * REQUIRED rather than optional for the same reason `tuning_level` is: every
   * `WorkflowRow`-producing SELECT must project it explicitly, or the omitted
   * column silently reads as `undefined`.
   */
  runtime_mix: RuntimeMix;
  created_at: string;
  /**
   * Soft-archive stamp (migration 078, mirrors the entity `archived_at`
   * pattern from migration 024): NULL = active, an ISO timestamp = archived.
   * Archiving is a single UPDATE — no cascade to `workflow_runs` /
   * `workflow_revisions` / Insights history. Required (not optional) so every
   * `WorkflowRow`-producing SELECT must project it explicitly — an omitted
   * column would otherwise silently resolve to `undefined` at runtime.
   */
  archived_at: string | null;
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
  /** Selected idea ids seeded into a planner run at launch (IDEA-009 "Planner should
   *  accept multiple ideas"), JSON-encoded string array (migration 061). NULL for
   *  runs launched with a single idea / non-planner runs. Mirrors seed_finding_ids (034). */
  seed_idea_ids?: string | null;
  /** Free-text "what are you trying to build?" grounding text seeded into a
   *  'launch' run at launch time (migration 100). NULL for every non-launch run.
   *  Parsed + injected by RunExecutor.getPrompt's `# What you are building` block.
   *  Mirrors seed_idea_id (017) / seed_finding_ids (034) — a direct workflow_runs
   *  write, no entity link. */
  seed_prompt?: string | null;
  /** sha256 hex of the workflow's spec_json frozen at run creation (computeSpecHash; migration 026). Lets Insights bucket runs by the exact workflow revision they executed even after the workflow's spec_json is edited. NULL for historic runs / runs created before 026. */
  spec_hash?: string | null;
  /**
   * DB-canonical close-out signal set on terminal close-out. NULL while the run
   * is in flight (migration 014). `'integrated'` (migration 022 / feat/parallel-sprint)
   * is the per-task close-out outcome: the run's branch was merged into the batch
   * integration branch (not main). `'interrupted'` (app-restart boot recovery) is the
   * why-category for a run that was force-failed because an app restart orphaned it and
   * it could not be auto-resumed — it pairs with `status='failed'` + the
   * `error_message='app_restart'` sentinel, and marks infrastructure interruption (NOT an
   * agent/logic bug) so insights + the assistant can exclude it from the real-failure rate.
   * `'completed'` is the human's "this landed, but not through our merge path" stamp (the
   * agent merged it in chat, or the branch was merged outside the app), set only by the
   * explicit Mark-complete action and a member of DELIVERED_RUN_OUTCOMES so the session's
   * findings survive its archive.
   * The plain TEXT column has no SQL CHECK, so this is a TypeScript-union-only addition.
   */
  outcome?:
    | 'merged'
    | 'integrated'
    | 'pr_open'
    | 'completed'
    | 'dismissed'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | null;
  /** Base branch captured at launch — future git triage only, NOT a hot path (migration 014). */
  base_branch?: string | null;
  /** Base SHA captured at launch — future git triage only (migration 014). */
  base_sha?: string | null;
  /** step->agent map frozen at launch; stable overlay across mid-run workflow edits (migration 014). */
  steps_snapshot_json?: string | null;
  /** CLI substrate stamped at launch ('sdk' | 'interactive'). Resolved once and immutable for the run. Reads back 'sdk' for every legacy row. IDEA-013 / TASK-806. */
  substrate?: CliSubstrate;
  /**
   * Provider/runtime stamps (migrations 051-052). These supersede the Claude-only
   * substrate concept for new integrations. Existing substrate remains a
   * compatibility projection during migration.
   */
  agent_provider?: AgentProvider;
  agent_runtime?: WorkflowRunStorableRuntime;
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
   * Per-run provider-scoped model alias pinned at launch ('fable' | 'opus' |
   * 'sonnet' | 'gpt-*' | 'auto'), normalized against agent_provider at createRun
   * and resolved to a runtime-specific spawn value at the spawn seam. Stamped once
   * at createRun, immutable for the run (migration 037). NULL means "no pin".
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
   * The tuning level this run FROZE at (migration 122) — the immutable-snapshot
   * sibling of `spec_hash` / `variant_id`, stamped once at createRun from the
   * per-run wizard override if given, else the workflow's own stamp.
   *
   * NULL means UNATTRIBUTED, never `'standard'`: a pre-feature run, a
   * non-built-in flow (outside the level system), or a VARIANT run — a variant
   * carries its own frozen graph, so crediting a level to it would poison the
   * per-level estimate buckets. Every reader must treat NULL that way.
   */
  tuning_level?: TuningLevel | null;
  /**
   * The runtime mix this run FROZE at (migration 128) — the immutable-snapshot
   * sibling of `tuning_level`, stamped once at createRun from the per-run
   * override if given, else the workflow's own stamp (a restart replays the
   * failed run's stamp, which outranks both).
   *
   * NULL means UNATTRIBUTED, never `'claude'`: a pre-feature run, a VARIANT run
   * (its graph is the variant's, not a mix's), a non-built-in flow, or an
   * omp/pi run — single-provider lanes the mix does not describe.
   */
  runtime_mix?: RuntimeMix | null;
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
  /** Provider/runtime stamps surfaced additively for migrations 051-052. */
  agent_provider?: AgentProvider;
  agent_runtime?: WorkflowRunStorableRuntime;
  /** Parent session (migration 019) — soft link to sessions.id, NULL for legacy parentless flow runs. The left-rail will group runs by session_id in Phase 3. */
  session_id?: string | null;
  /** Sprint lane batch (migration 022) — soft link to sprint_batches.id; stamped on seeded 'sprint' runs, NULL for every other run. */
  batch_id?: string | null;
  /**
   * Multi-idea planner seed (migration 061) — the JSON-encoded string array of ALL
   * idea ids seeded into a planner batch run. Surfaced on the list row so the
   * frontend can read the multi-idea signal (e.g. the Workflow Progress idea-spec
   * chip routing to the combined approve-ideas review) without a second query.
   * NULL for single-idea / non-planner runs. Optional + additive, mirroring
   * `batch_id?`; the frontend `ActiveRunRow` already declares the matching field.
   */
  seed_idea_ids?: string | null;
  /**
   * Per-run pinned provider-scoped model alias (migration 037) — the user-facing
   * alias stamped onto workflow_runs.model at launch (Configure surface), resolved
   * to a runtime-specific spawn value at the spawn seam. Surfaced on the list row
   * so the run composer can
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
  /**
   * Explicit-completion rail stamp (migration 075). Set when the user hits
   * "Complete workflow" on a run's completion summary (runs.end). The left-rail
   * retention (activeRunsStore.buildActiveRunRows) drops a terminal run whose
   * rail_dismissed_at is set from its parent session's retained-history slot, so
   * an explicitly-completed run leaves the sidebar. NULL = never dismissed → the
   * pre-075 "newest terminal per session stays reachable" behaviour. Optional +
   * additive, mirroring `ended_at`.
   */
  rail_dismissed_at?: string | null;
}

/**
 * The five user-facing built-in flows in cyboflow v1.
 *
 * Narrowed from the historical SoloFlow set of five: `planner`, `sprint`,
 * `compound`, `ship`, `verify-setup`, and `launch` are cyboflow-native flows that
 * write via the `cyboflow_*` MCP tools, never `.soloflow/` files. `launch` is the
 * super-planner for a brand-new project — an in-depth interview produces a
 * project brief, the brief decomposes into an idea set, and the foundation
 * ideas become execution-ready epics and tasks; it ends at the approved
 * backlog and never materializes a sprint itself. The dropped `prune` flow
 * keeps its prose under `docs/workflows-future/` for a future rebuild. The
 * internal `__quick__` sentinel is NOT a member here — it is filtered out of the
 * picker and handled separately by the quick-session pipeline.
 *
 * THIS TUPLE IS AN APP-WIDE EXHAUSTIVE DISCRIMINANT, not a list. Adding a member
 * is a compile-time tripwire on every `Record<CyboflowWorkflowName, …>` — today
 * `WORKFLOW_DEFINITIONS` (below), `INITIAL_STEP_IDS`
 * (`main/src/orchestrator/stepTransitionBridge.ts`), and the renderer's
 * `WORKFLOW_LABEL` (`frontend/src/components/agentRail/ProposalCardBodies.tsx`) —
 * and it silently widens every derived surface that iterates it: the seeded
 * built-in rows (`buildBuiltInWorkflows`), the built-in agent catalogue
 * (`agentCatalogue.loadBuiltInAgents`), the reserved-name guard in
 * `WorkflowRegistry`, and the `TelemetryFlow` union. A new member therefore also
 * needs its flow `.md` + agent bundle on disk and a decision on the
 * code-review-eval auto-entry posture (`snapshotRunForEval`). See
 * `docs/proposals/verification-setup-flow.md` §5.1, which costs this out.
 *
 * ORDER MATTERS: `agentCatalogue.loadBuiltInAgents` walks this tuple and dedupes
 * bundled agent basenames FIRST-WINS, so `launch` — whose bundle copies several
 * planner/sprint agents verbatim (context/research/ui-prototype/architecture/
 * adversarial-review/epics/tasks) — must stay LAST so those originating
 * workflows stay the canonical `role` owner.
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
export const CYBOFLOW_WORKFLOW_NAMES = [
  'planner',
  'sprint',
  'compound',
  'ship',
  'verify-setup',
  // LAST on purpose — see "ORDER MATTERS" above (first-wins agent dedup).
  'launch',
] as const;

export type CyboflowWorkflowName = (typeof CYBOFLOW_WORKFLOW_NAMES)[number];

/**
 * The verification-bootstrap flow's name, as a single constant rather than a
 * literal re-spelled per seam. Two independent authorities key on this identity
 * and MUST agree: `WorkflowRegistry.createRun` (which stamps such a run
 * verify-enabled regardless of the master switch — the flow that makes
 * verification usable cannot be gated behind it) and the MCP `setup_proof`
 * authorization gate (which grants the degrade-gate + budget exemption only to
 * a run whose FROZEN workflow identity is this one). A typo in either used to
 * be a silent no-op on one side of that pair.
 */
export const VERIFY_SETUP_WORKFLOW_NAME: CyboflowWorkflowName = 'verify-setup';

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
  /** Intra-chain loopback target id, re-driven by both execution planes on required failure. */
  loopback?: string;
  /** Human-readable name for prompts/UI; falls back to id when absent. */
  name?: string;
  /**
   * When true this stage is a FIRM GATE: the orchestrator must regain control
   * before the item may advance past it, so the stage can never be folded into a
   * batch of stages delegated elsewhere.
   *
   * Only meaningful under `fanOutDispatch: 'workflow'`, where consecutive
   * NON-gated stages are dispatched to a single dynamic workflow that runs each
   * item's whole sub-chain (implement → tests → verify) without returning to the
   * orchestrator between stages. That is the efficiency of the workflow path,
   * and the deliberate trade is that lane `current_step` does not tick per stage
   * inside a batch — the orchestrator backfills the stage trail from the
   * returned results.
   *
   * A firm gate ENDS such a batch. `visual-verify` is the canonical one: it has
   * no subagent at all (the orchestrator fires `cyboflow_request_verification`
   * and parks the lane on an async external verdict), so it is both unscriptable
   * and a real gate. Absent ⇒ not a gate ⇒ batchable, which is the default for
   * ordinary implementation stages.
   */
  firmGate?: boolean;
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
  /**
   * When true this step's prompt carries the FINAL TEXT of the most recent
   * preceding agent step (human gates are skipped when looking back), rendered
   * by `composeStepPrompt` as a `## Previous step output` section.
   *
   * Needed because each PROGRAMMATIC step is a fresh agent turn with no memory
   * of the last one. On the orchestrated plane a single agent holds every
   * subagent's return value in its own context, so a chain like Compound's
   * load → extract works implicitly; run the same chain programmatically and
   * the load step's summary reaches nobody, while the extract agent's prompt
   * still says it was handed one. Set this on the CONSUMING step.
   *
   * Opt-in per step rather than always-on: most steps re-derive their inputs
   * from the repo and the database, and prepending the previous agent's prose
   * to all of them would spend context on text they must not treat as
   * authoritative.
   *
   * Best-effort by design. A substrate that cannot capture a turn's final text
   * (codex / interactive) yields nothing to forward, and the section then says
   * so explicitly rather than being silently omitted — the same
   * channel-unavailable degradation task-verify's verdict channel takes.
   */
  consumesPriorStepOutput?: boolean;
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
 * An empty `{}` config (none of `model`, `custom`, `runtime`, `providerModel`
 * (nor its deprecated alias `codexModel`), `effort`, nor `promptAddendum` set)
 * carries no signal and must NEVER be persisted — the workflow editor prunes it
 * before write.
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
  /**
   * Per-workflow CLI runtime/provider override for this agent — which
   * substrate this agent runs on. Absent -> inherit the run-level
   * provider/runtime; `'codex-sdk'` runs this agent on Codex instead of Claude.
   */
  runtime?: WorkflowLaunchableRuntime;
  /**
   * The model id for this agent's resolved NON-CLAUDE provider (e.g.
   * `'gpt-5.2-codex'` when `runtime === 'codex-sdk'`). Free-form string rather
   * than an enum: a non-Claude provider's model ids are discovered dynamically
   * from its own catalogue, not a fixed union like {@link AgentModelAlias}.
   * Ignored for Claude runtimes, which keep using `model`. A future provider
   * reuses this same field — it is keyed by "resolved non-Claude provider",
   * not by any one provider's name.
   */
  providerModel?: string;
  /**
   * @deprecated Read-compat alias of {@link providerModel}. Persisted workflow
   * definitions and the MCP `cyboflow_update_workflow`/`cyboflow_create_variant`
   * writers may still write this key; every read seam normalizes via
   * `providerModel ?? codexModel` (an explicit `providerModel` wins). New
   * writers should set `providerModel` instead.
   */
  codexModel?: string;
  /**
   * Per-workflow reasoning-effort override for this agent (IDEA-029). The valid
   * scale depends on the resolved provider — Claude accepts `low..max`, Codex
   * `none..xhigh` (see {@link ReasoningEffort}); a value outside the effective
   * provider's scale is dropped at resolve/spawn time rather than forwarded.
   * Absent -> inherit the run/CLI default effort.
   */
  effort?: ReasoningEffort;
  /**
   * Extra instructions APPENDED to whatever system prompt the
   * builtin -> project-override -> workflow-config -> variant merge resolved for
   * this agent. Unlike `custom` it replaces nothing: tools, MCP grants, model,
   * and the project's own hardened body all survive, so it composes with a
   * project's agent policy instead of clobbering it.
   *
   * Written by the tuning presets (`shared/tuning/workflowTuning.ts`) to fold a
   * removed lane step's work into the step that remains; the run-side append
   * lives at the end of `resolveRunEffectiveAgents`.
   */
  promptAddendum?: string;
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
 * The built-in workflow definitions, keyed by `CyboflowWorkflowName`.
 * `Readonly<Record<…>>` forces the compiler to flag any missing key.
 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<CyboflowWorkflowName, WorkflowDefinition>> = {

  // planner — idea → epics → tasks (board stages 1-6); the terminal approve-plan gate reveals the
  // tasks, retires the decomposed idea, and completes the run; writes via cyboflow_* MCP tools
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
            desc: 'Produce a short idea stub (Problem definition ≤5 bullets + Proposed solution ≤5 bullets) plus SCOPE and design flags.',
            outputArtifact: { atype: 'idea-spec', label: 'Idea spec' },
          },
          {
            id: 'approve-idea',
            name: 'Approve idea stub',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You approve, revise, or reject the short idea stub before the full spec is expanded.',
          },
        ],
      },
      {
        id: 'refine',
        label: 'Refine',
        color: '#5a4ad6',
        steps: [
          {
            id: 'expand-spec',
            name: 'Complete idea spec',
            agent: 'context',
            mcps: ['filesystem', 'web-search', 'context7'],
            retries: 0,
            desc: 'Expand the approved stub into the full idea spec (ungated), preserving the approved problem/solution/scope/flags; spin up the research subagent as needed for the idea\'s scope and complexity.',
          },
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
            id: 'adversarial-review',
            name: 'Adversarial review',
            agent: 'adversarial-review',
            mcps: ['filesystem'],
            retries: 0,
            optional: true,
            // A `REVIEW: BLOCKING` result re-runs the refine phase from `expand-spec`
            // AUTOMATICALLY (once — MAX_REVIEW_AUTO_REVISIONS) with the review's
            // `## Blocking` entries threaded into every re-run step, before the
            // human sees the design gate; a second BLOCKING falls through to the
            // gate. Being optional, a review that merely FAILS still skips rather
            // than taking this edge.
            loopback: 'expand-spec',
            desc: 'Stress-test spec + prototype + architecture; a blocking verdict re-runs the refine phase once automatically, remaining critique surfaced (non-blocking) at the design gate. Runs only when a prototype or architecture exists.',
            outputArtifact: { atype: 'adversarial-review', label: 'Adversarial review' },
          },
          {
            id: 'approve-design',
            name: 'Approve design',
            agent: 'human',
            mcps: [],
            retries: 0,
            optional: true,
            human: true,
            // 'revise' at this gate re-runs the refine phase from `expand-spec`
            // (intra-phase, so legal under the v1 loopback invariant) with the
            // human's note + the adversarial-review artifact threaded into every
            // re-run step. Without a target, 'revise' merely RE-PRESENTS the same
            // gate — the reviewer presses Revise and nothing changes.
            loopback: 'expand-spec',
            desc: 'You review the prototype and/or architecture before decomposition. Revise re-runs the refine phase from the spec with your note and the adversarial review. Skipped when neither ran.',
          },
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'epics',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Group the idea\'s work under epics — a full breakdown with dependency edges for a large idea; otherwise one epic named after the idea whenever it yields more than one task.',
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
            desc: 'You sign off on scope. Approve puts the tasks on the board, retires the decomposed idea(s), and ends the run.',
          },
        ],
      },
    ],
  },

  // sprint — execute N ready tasks (board stages 7-10) in ONE session-hosted
  // run. The orchestrator agent analyzes the dependency DAG, fans out per-task
  // subagents with bounded concurrency, and reports per-task lane progress via
  // cyboflow_update_sprint_task. One holistic verify/review/address/human gate
  // at the end — 'address-review' is what keeps the review honest: it verifies
  // and acts on the findings the run's own reviews produced (per-lane
  // code-review AND sprint-review) instead of deferring every one of them to a
  // backlog nobody reads. N=1 degenerates to a normal single-task sprint. The
  // inner chain's `loopback: 'implement'` fields encode today's "on failure,
  // re-delegate to implement" behavior as data, consumed by both the
  // orchestrated prompt generator and the programmatic controller.
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
                {
                  id: 'implement',
                  agent: 'implement',
                  name: 'Implement',
                  // SELF-loopback: a first-step failure gets the same second
                  // chance every later inner step already gets. Without it,
                  // `implement` was the one stage whose FIRST failure was
                  // immediate lane exhaustion — a transient spawn/tool failure at
                  // the head of the chain failed the lane outright while the very
                  // same failure at `write-tests` would have been retried. The
                  // controller already supports a self-targeting loopback (it
                  // re-drives from the target index and bumps the attempt, capped
                  // by FAN_OUT_LANE_ATTEMPT_CAP); this only declares it.
                  loopback: 'implement',
                },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
                { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
                {
                  id: 'visual-verify',
                  agent: 'visual-verify',
                  name: 'Visual check',
                  optional: true,
                  loopback: 'implement',
                  // The ONLY firm gate in the implementation chain: it has no
                  // subagent (the orchestrator fires the verification request and
                  // parks the lane on an async verdict), so it can never be folded
                  // into a delegated batch. Every stage before it is batchable.
                  firmGate: true,
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
            id: 'address-review',
            name: 'Address review findings',
            agent: 'address-review',
            mcps: ['filesystem', 'git'],
            retries: 1,
            desc: 'Verify every code-review finding this run filed, judge which are worth acting on, fix those in place, and resolve them — so a review changes code instead of only filling the backlog. Confirmed-but-out-of-scope findings stay open for the human.',
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
            agent: 'compound-load',
            mcps: ['filesystem', 'git'],
            retries: 0,
            desc: 'Gather the session diff + raw run data for recently merged/completed runs; cyboflow-compound-load returns ONLY a Merged work summary here — no learnings and no discarded list yet (those come at extract), and nothing is filed as a review item.',
          },
          {
            id: 'extract',
            name: 'Extract learnings',
            agent: 'compounder',
            mcps: ['filesystem'],
            retries: 0,
            // The load step's `## Merged work` survey is this step's whole view
            // of what shipped — including run outcomes and gaps that are not
            // visible in the diff. Programmatically each step is a fresh turn,
            // so without this the summary would reach nobody.
            consumesPriorStepOutput: true,
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
            agent: 'compound-writeback',
            mcps: ['filesystem'],
            retries: 0,
            // Carries EXTRACT's learnings across the approve-learnings gate (the
            // gate is transparent to this channel). The human's approved SUBSET
            // still arrives through the gate decision itself — this supplies the
            // learning bodies that subset refers to.
            consumesPriorStepOutput: true,
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
  // not earlier. Planner's approve-plan gate is MID-RUN here (it never completes a
  // ship run); sprint's 'plan' phase id is renamed 'sprint-plan' to avoid colliding
  // with planner's 'plan'.
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
            desc: 'Produce a short idea stub (Problem definition ≤5 bullets + Proposed solution ≤5 bullets) plus SCOPE and design flags.',
          },
          {
            id: 'approve-idea',
            name: 'Approve idea stub',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You approve, revise, or reject the short idea stub before the full spec is expanded.',
          },
        ],
      },
      {
        id: 'refine',
        label: 'Refine',
        color: '#5a4ad6',
        steps: [
          {
            id: 'expand-spec',
            name: 'Complete idea spec',
            agent: 'context',
            mcps: ['filesystem', 'web-search', 'context7'],
            retries: 0,
            desc: 'Expand the approved stub into the full idea spec (ungated), preserving the approved problem/solution/scope/flags; spin up the research subagent as needed for the idea\'s scope and complexity.',
          },
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
            id: 'adversarial-review',
            name: 'Adversarial review',
            agent: 'adversarial-review',
            mcps: ['filesystem'],
            retries: 0,
            optional: true,
            // Same automatic revision as Planner: a `REVIEW: BLOCKING` result
            // re-runs the refine phase from `expand-spec` once, then the gate.
            loopback: 'expand-spec',
            desc: 'Stress-test spec + prototype + architecture; a blocking verdict re-runs the refine phase once automatically, remaining critique surfaced (non-blocking) at the design gate. Runs only when a prototype or architecture exists.',
            outputArtifact: { atype: 'adversarial-review', label: 'Adversarial review' },
          },
          {
            id: 'approve-design',
            name: 'Approve design',
            agent: 'human',
            mcps: [],
            retries: 0,
            optional: true,
            human: true,
            // 'revise' at this gate re-runs the refine phase from `expand-spec`
            // (intra-phase, so legal under the v1 loopback invariant) with the
            // human's note + the adversarial-review artifact threaded into every
            // re-run step. Without a target, 'revise' merely RE-PRESENTS the same
            // gate — the reviewer presses Revise and nothing changes.
            loopback: 'expand-spec',
            desc: 'You review the prototype and/or architecture before decomposition. Revise re-runs the refine phase from the spec with your note and the adversarial review. Skipped when neither ran.',
          },
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'epics',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Group the idea\'s work under epics — a full breakdown with dependency edges for a large idea; otherwise one epic named after the idea whenever it yields more than one task.',
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
                {
                  id: 'implement',
                  agent: 'implement',
                  name: 'Implement',
                  // SELF-loopback: a first-step failure gets the same second
                  // chance every later inner step already gets. Without it,
                  // `implement` was the one stage whose FIRST failure was
                  // immediate lane exhaustion — a transient spawn/tool failure at
                  // the head of the chain failed the lane outright while the very
                  // same failure at `write-tests` would have been retried. The
                  // controller already supports a self-targeting loopback (it
                  // re-drives from the target index and bumps the attempt, capped
                  // by FAN_OUT_LANE_ATTEMPT_CAP); this only declares it.
                  loopback: 'implement',
                },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
                { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
                {
                  id: 'visual-verify',
                  agent: 'visual-verify',
                  name: 'Visual check',
                  optional: true,
                  loopback: 'implement',
                  // The ONLY firm gate in the implementation chain: it has no
                  // subagent (the orchestrator fires the verification request and
                  // parks the lane on an async verdict), so it can never be folded
                  // into a delegated batch. Every stage before it is batchable.
                  firmGate: true,
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
            id: 'address-review',
            name: 'Address review findings',
            agent: 'address-review',
            mcps: ['filesystem', 'git'],
            retries: 1,
            desc: 'Verify every code-review finding this run filed, judge which are worth acting on, fix those in place, and resolve them — so a review changes code instead of only filling the backlog. Confirmed-but-out-of-scope findings stay open for the human.',
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

  // verify-setup — the per-project visual-verification setup flow
  // (docs/proposals/verification-setup-flow.md §5): derive → prove → persist →
  // reuse. It exists because BOTH prior designs failed in opposite directions —
  // the legacy waterfall demanded a hand-authored `.cyboflow/verify.json` nobody
  // ever wrote, and the agent engine guesses the build/serve environment per run
  // with no memory and guessed wrong every single time (0-for-5 in production).
  // The middle is a runbook derived ONCE from evidence and then PROVED by an
  // actual run through the real verification path.
  //
  // Shape is Compound's `extract → approve-learnings → write-back → human-review`
  // template 1:1 — propose, gate, apply + commit, terminal merge gate — with the
  // proof step wedged between apply and gate, because "we wrote a config file" is
  // exactly the non-guarantee this flow exists to replace. FIVE steps in a single
  // 'Verify Setup' phase with exactly TWO human gates: `approve-runbook` (the
  // proposal, BEFORE anything touches the repo) and the terminal `human-review`
  // merge gate over the committed diff + the per-modality proof outcomes.
  //
  // Two properties that are load-bearing and easy to break:
  //  - It is EVAL-EXEMPT by name in snapshotRunForEval, exactly like compound
  //    (§5.1): its diff is a config file and a couple of isolation levers, not
  //    rubric material, and rubric-grading the setup flow would tax every project
  //    that dares to configure verification.
  //  - `prove` NEVER marks a runbook proven. It fires a `setup_proof` verification
  //    and awaits the verdict; the ENGINE marks (project, modality, hash) proven
  //    off a PASSING request with full §5.3 provenance. Proof-by-running is
  //    engine-enforced precisely so a flow cannot assert its own success.
  //
  // WHAT THE PROSE ABOVE ASSUMES, AND WHICH PLANE ACTUALLY HAS IT. This flow's
  // markdown body (`workflows/verify-setup.md`) is written for the ORCHESTRATED
  // plane, where one session owns every step and simply remembers the survey, the
  // proposal, and the gate answer. Programmatic runs — which is what an SDK run
  // floors to, so in practice most of them — give each step a FRESH agent turn
  // with no memory and no MCP tool that reads an artifact. Three consequences
  // that are easy to re-break:
  //  - `derive`'s `outputArtifact` is the ONLY durable channel from the drafting
  //    step to `prove`; the host threads it back in as a prompt section
  //    (defaultProgrammaticRunner.readRunbookProposalMarkdown). Its atype is
  //    therefore load-bearing twice over: composeStepPrompt's `artifactFollowUp`
  //    switches on it for the doc contract, and the reader keys on it. It read
  //    'compound-recommendations' until 2026-08-28, which handed `derive`
  //    COMPOUND's instructions and left `prove` asking a human to paste the
  //    proposal back.
  //  - `inspect` declares NO output, so a programmatic `derive` cannot receive the
  //    survey and re-surveys the repo itself. That is redundant work rather than
  //    lost correctness (derive holds the same worktree and the same subagent), so
  //    it is left as-is — but it is why the flow prose's "re-delegate with the
  //    survey" does not literally happen here.
  //  - The `approve-runbook` gate is ALL-OR-NOTHING on this plane: the host opens a
  //    generic blocking decision item (a typed payload exists only for launch's
  //    approve-ideas) and reduces its resolution to approve/reject/revise. The
  //    prose's "Pick subset" option is orchestrated-only; the sole trimming signal
  //    that survives to `prove` is free text a human typed into the gate note.
  'verify-setup': {
    id: 'verify-setup',
    phases: [
      {
        id: 'verify-setup',
        label: 'Verify Setup',
        color: '#0ea5e9',
        steps: [
          {
            id: 'inspect',
            name: 'Inspect the project',
            agent: 'verify-setup',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Probe how this project\'s UI actually stands up: its dev / build / start scripts, framework, whether the deliverable is an Electron-style app or browser-served, the isolation levers it ALREADY has (a port env var or CLI flag, a data-dir lever, a remote-debugging/CDP flag), and any existing .cyboflow/verify-runbook.json plus its proven/unproven status. Evidence only — package.json scripts, README/CLAUDE.md, the app entrypoints — never a command nobody documented, and never run an install or a rebuild.',
          },
          {
            id: 'derive',
            name: 'Derive the runbook',
            agent: 'verify-setup',
            mcps: ['filesystem'],
            retries: 0,
            outputArtifact: { atype: 'verify-runbook', label: 'Runbook proposal' },
            desc: 'Draft the PORTABLE runbook per declared modality — build/serve command TEMPLATES carrying ${PORT}-style lever placeholders (never a resolved port, never a temp dir, never an install or native-rebuild command) plus the REQUIRED attestation spec for each modality — alongside the machine-local bindings (binary paths, data-dir lever name, ABI facts) and any rung-ladder repo changes: rung 0 existing levers only, rung 1 config-only, rung 2 a proposed diff that is NEVER auto-applied. Publish ONE proposal doc via cyboflow_report_artifact; nothing is written to the repo at this step.',
          },
          {
            id: 'approve-runbook',
            name: 'Approve runbook',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You review the runbook proposal — the commands, the per-modality attestation channel, and every rung-1 / rung-2 repo change it wants — and approve, trim, or reject BEFORE anything is written to the repo.',
          },
          {
            id: 'prove',
            name: 'Prove the runbook',
            agent: 'verify-setup',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Write .cyboflow/verify-runbook.json plus the APPROVED rung-1/rung-2 changes and commit them, register each declared modality via cyboflow_register_verify_runbook, then prove each one by RUNNING it: compose a proof task FROM the runbook, fire cyboflow_request_verification with setup_proof true, and block on cyboflow_await_verification. A PASS is what marks the runbook proven — the engine does that from the passing request, never this flow. On FAIL, diagnose from failureClass/feedback, adjust, re-register, re-prove (max 3 rounds per modality); on exhaustion keep the unproven draft, put the diagnosis in the run summary, and continue — never a dead end.',
          },
          {
            id: 'human-review',
            name: 'Human review',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'Final "merge in changes" gate over the committed runbook + repo diff and the per-modality proof outcomes (proven, or still an unproven draft with its diagnosis) — approve to make the branch mergeable, reject to leave it unadopted. Same as a sprint/ship human-review, but does not trigger an eval.',
          },
        ],
      },
    ],
  },

  // launch — the super-planner for a brand-new project: an in-depth interview
  // produces a project brief, the brief decomposes into an ordered idea set,
  // and every approved idea becomes execution-ready epics and tasks. Ends at the approved backlog — Launch never materializes a
  // sprint; Sprint/Ship run afterwards against the tasks it created. Reuses
  // planner's approve-plan step id so the hidden-draft reveal, idea-retirement,
  // and run-completion machinery apply unchanged.
  launch: {
    id: 'launch',
    phases: [
      {
        id: 'interview',
        label: 'Interview',
        color: '#3b6dd6',
        steps: [
          {
            id: 'interview',
            name: 'Project interview',
            agent: 'interview',
            mcps: ['filesystem', 'web-search'],
            retries: 0,
            desc: 'In-depth interview — questions asked one at a time, uncapped, with a "clarify further or draft the brief?" checkpoint every four questions — covering vision, users, core loop, MVP boundary, stack, data, and risks.',
          },
          {
            id: 'project-brief',
            name: 'Project brief',
            agent: 'interview',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Synthesize the interview into a self-contained project brief — vision, MVP scope, technical direction, data sketch, and build sequence.',
            outputArtifact: { atype: 'project-brief', label: 'Project brief' },
          },
          {
            id: 'approve-brief',
            name: 'Approve brief',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You approve, revise, or reject the project brief before any decomposition.',
          },
        ],
      },
      {
        id: 'design',
        label: 'Design',
        color: '#5a4ad6',
        steps: [
          {
            id: 'ui-prototype',
            name: 'Concept prototype',
            agent: 'ui-prototype',
            mcps: ['filesystem'],
            retries: 1,
            optional: true,
            desc: 'Optional whole-product concept mockup built from the approved brief (before any decomposition), when the brief declares a user-facing UI.',
            outputArtifact: { atype: 'ui-prototype', label: 'Concept prototype' },
          },
          {
            id: 'architecture',
            name: 'Architecture design',
            agent: 'architecture',
            mcps: ['filesystem'],
            retries: 1,
            optional: true,
            desc: 'Optional project-level architecture (stack, repo layout, data model, seams) designed from the approved brief; recorded in the brief now and folded into the lowest-BUILD_ORDER idea at decomposition.',
            outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
          },
          {
            id: 'adversarial-review',
            name: 'Adversarial review',
            agent: 'adversarial-review',
            mcps: ['filesystem'],
            retries: 0,
            optional: true,
            // Same automatic revision as Planner, targeting the design pass
            // itself (`ui-prototype`) — the brief is already approved, exactly
            // as the gate's own revise below.
            loopback: 'ui-prototype',
            desc: 'Stress-test the brief + concept design surfaces; a blocking verdict re-runs the design pass once automatically, remaining critique surfaced (non-blocking) at the design gate.',
            outputArtifact: { atype: 'adversarial-review', label: 'Adversarial review' },
          },
          {
            id: 'approve-design',
            name: 'Approve design',
            agent: 'human',
            mcps: [],
            retries: 0,
            optional: true,
            human: true,
            // Launch's design phase has no spec step to return to — the brief was
            // already approved at its own gate — so 'revise' re-runs the design
            // pass itself from `ui-prototype` (same phase, legal target).
            loopback: 'ui-prototype',
            desc: 'You review the concept prototype and/or architecture before decomposition. Revise re-runs the design pass with your note and the adversarial review. Skipped when neither ran.',
          },
        ],
      },
      {
        id: 'ideas',
        label: 'Ideas',
        color: '#8b5cf6',
        steps: [
          {
            id: 'ideas',
            name: 'Decompose into ideas',
            agent: 'interview',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Split the approved brief + concept design into an ordered idea set (aim 4-8) sequenced by BUILD_ORDER; each idea lands on the board with a short stub, and the architecture folds into the foundation idea.',
          },
          {
            id: 'approve-ideas',
            name: 'Approve ideas',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You approve or deny each idea in the set via the joint batch gate.',
          },
        ],
      },
      {
        id: 'plan',
        label: 'Plan',
        color: '#a87a2c',
        steps: [
          {
            id: 'expand-spec',
            name: 'Complete idea specs',
            agent: 'context',
            mcps: ['filesystem', 'web-search', 'context7'],
            retries: 0,
            desc: 'Expand every approved idea into a full spec (ungated), preserving the approved stub; research the proposed stack as needed.',
          },
          {
            id: 'epics',
            name: 'Create epics',
            agent: 'epics',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Epic breakdown per approved idea — a full tree for a large idea; otherwise one fallback epic whenever an idea yields more than one task.',
          },
          {
            id: 'tasks',
            name: 'Fill out task details',
            agent: 'tasks',
            mcps: ['filesystem'],
            retries: 0,
            desc: 'Capture every task via cyboflow_create_task with acceptance criteria and idea lineage.',
            outputArtifact: { atype: 'decomposed-stories', label: 'Decomposed stories' },
          },
          {
            id: 'approve-plan',
            name: 'Approve task plan',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You sign off on the whole task plan. Approve puts the tasks on the board, retires the decomposed idea(s) (denied ideas stay on the backlog), and ends the run.',
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
 * Is a workflow's CUSTOM SLOT filled — i.e. does `spec_json` carry something
 * other than the two "no slot" sentinels?
 *
 * THE emptiness predicate, shared by every surface that needs to know: the
 * migration-122 backfill (in SQL), the tuning selector's "Custom is disabled
 * until you save one" hint, `setTuningLevel`'s empty-slot rejection, and the
 * MCP `has_custom_spec` projection. Deliberately a function of `spec_json`
 * rather than a derived field on {@link WorkflowRow}: the registry casts raw
 * SQL rows, so a computed row field would silently be `undefined` at any
 * producer that forgot to compute it — the exact drift the IPC type-parity
 * rules exist to prevent.
 *
 * Structural validity is NOT checked here (a corrupt-but-non-empty slot still
 * counts as filled — that is a broken definition to repair, not an absent one).
 */
export function hasCustomSpecSlot(specJson: string | null | undefined): boolean {
  if (specJson === null || specJson === undefined) return false;
  const trimmed = specJson.trim();
  return trimmed !== '' && trimmed !== '{}';
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
