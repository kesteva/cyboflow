/**
 * SprintLaneStore — the SINGLE write chokepoint for sprint LANES (the
 * sprint-orchestrator redesign's per-task progress substrate).
 *
 * A "lane" is one sprint_batch_tasks row repurposed from the retired
 * SprintBatchScheduler model (migration 022; migration 023 adds
 * current_step_id). The ONE session-hosted sprint run owns a sprint_batches
 * row (stamped onto workflow_runs.batch_id by RunLauncher); its orchestrator
 * agent fans out per-task subagents in the SHARED session worktree and reports
 * per-task progress through the cyboflow_update_sprint_task MCP tool, which
 * lands here. Lane status 'integrated' now MEANS "task complete + committed in
 * the session worktree" — there is no per-task integration branch/merge.
 *
 * Ownership doctrine (same as migration 022's header): sprint_batches /
 * sprint_batch_tasks are NOT entity-model tables — they do NOT route through
 * TaskChangeRouter. This store writes them directly with status-guarded
 * UPDATEs, the same way workflow_runs is written directly by RunLauncher.
 * Board-stage derivation of the underlying tasks still flows through the
 * entity chokepoint elsewhere.
 *
 * Singleton lifecycle mirrors TaskChangeRouter (initialize / getInstance /
 * _resetForTesting). Pass the optional `logger` at initialize time from
 * main/src/index.ts — omitting it silently disables the store's diagnostics
 * (CODE-PATTERNS.md optional-logger rule).
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DatabaseLike, LoggerLike } from './types';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type {
  SprintBatchTaskStatus,
  SprintLaneChangedEvent,
  SprintLaneRow,
  SprintLaneStepId,
  SprintLaneVisualVerification,
} from '../../../shared/types/sprintBatch';
import {
  REQUEST_STATUS,
  isVerificationFailureClass,
  type RequestStatus,
} from '../../../shared/types/visualVerification';
import {
  AWAITING_VERIFY_STEP,
  SPRINT_BATCH_CAP,
  SPRINT_LANE_STEP_IDS,
  TERMINAL_BATCH_STATUSES,
  resolveSprintMaxTasks,
  type SprintMaxTasksOverrides,
} from '../../../shared/types/sprintBatch';
import { resolveRunFanOutInner } from './laneChainResolution';
import { isAgentDispatchToolName } from '../../../shared/types/agentIdentity';
import type { FanOutInnerStep } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Auto-derive: parent-orchestrator subagent dispatch -> lane step
//
// The sprint orchestrator is SUPPOSED to advance lanes via cyboflow_update_sprint_task
// (handleUpdateSprintTask), but in practice it skips that prose-only call while
// busy delegating — leaving lanes stuck at queued/current_step_id=NULL. As a
// BACKSTOP, deriveLaneFromTaskDispatch (below) observes the parent's PreToolUse
// Task-tool dispatches and advances the matching lane WITHOUT relying on the
// agent. It is called from BOTH PreToolUse seams (the interactive orchestrator-
// socket handler AND the SDK in-process hook) so it fires on either substrate.
//
// The agent->step map + step ordering below are the CANONICAL FALLBACK, not the
// only vocabulary: deriveLaneFromTaskDispatch now first tries to derive both from
// the calling run's resolved fan-out chain (resolveRunFanOutInner — chain-derived,
// user-editable via the workflow editor) and only falls back to this static map/
// order when the run's definition is unresolvable or has no fanOut step. The
// fallback IS the canonical mapping, so an unedited sprint/ship run behaves
// byte-identically either way.
// ---------------------------------------------------------------------------

/**
 * Map a sprint per-task subagent_type to its lane step. ONLY the five per-task
 * agents are mapped; the sprint-wide phase-1/phase-3 agents
 * (cyboflow-dependency-analyzer / cyboflow-sprint-verify / cyboflow-sprint-review /
 * cyboflow-address-review)
 * have no per-task lane and are deliberately absent -> an unmapped subagent_type
 * is a no-op. This is the FALLBACK map (see the module doc above) — used only
 * when the run's fan-out chain does not resolve.
 */
const SPRINT_SUBAGENT_TO_LANE_STEP: Readonly<Record<string, SprintLaneStepId>> = {
  'cyboflow-implement': 'implement',
  'cyboflow-write-tests': 'write-tests',
  'cyboflow-code-review': 'code-review',
  'cyboflow-task-verify': 'task-verify',
  'cyboflow-visual-verify': 'visual-verify',
};

/**
 * Build a `cyboflow-<agent>` -> step-id map + the monotonic step ordering from a
 * resolved fan-out inner chain, widened with AWAITING_VERIFY_STEP appended LAST
 * (mirroring SPRINT_LANE_STEP_IDS's shape — the park step is not itself an inner
 * chain id, but a lane parked there must still out-rank every inner step in the
 * monotonic-forward guard below). For the canonical (unedited) sprint/ship chain
 * this produces a map and an ordering byte-identical to
 * SPRINT_SUBAGENT_TO_LANE_STEP / SPRINT_LANE_STEP_IDS.
 */
function buildDynamicStepVocabulary(inner: readonly FanOutInnerStep[]): {
  agentMap: ReadonlyMap<string, string>;
  order: readonly string[];
} {
  const agentMap = new Map<string, string>();
  for (const step of inner) {
    agentMap.set(`cyboflow-${step.agent}`, step.id);
  }
  return { agentMap, order: [...inner.map((s) => s.id), AWAITING_VERIFY_STEP] };
}

/**
 * True when `token` appears in `prompt` as a whole token — present and NOT
 * immediately followed by an alphanumeric char. Prevents a lane ref like
 * "TASK-1" from matching inside "TASK-12" (and a short id from matching a longer
 * one) during multi-lane sprint-wave attribution.
 */
function tokenAppearsInPrompt(prompt: string, token: string): boolean {
  if (token.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = prompt.indexOf(token, from);
    if (idx === -1) return false;
    const next = prompt[idx + token.length];
    if (next === undefined || !/[0-9A-Za-z]/.test(next)) return true;
    from = idx + 1;
  }
}

// ---------------------------------------------------------------------------
// Public event emitter — bridged by the tRPC lane subscription via
// eventToAsyncIterable (mirrors taskChangeEvents in taskChangeRouter.ts).
//
// Emit key format: 'sprint-lane-' + runId.
// ---------------------------------------------------------------------------

export const sprintLaneEvents = new EventEmitter();

/** Build the emit channel name for a run. Exported so the tRPC subscription stays in sync. */
export function sprintLaneChannel(runId: string): string {
  return `sprint-lane-${runId}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SprintLaneErrorCode = 'lane_not_found' | 'bad_request' | 'no_eligible_tasks' | 'batch_too_large';

/** Discriminated error for all lane-write rejections. */
export class SprintLaneError extends Error {
  constructor(
    public readonly code: SprintLaneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SprintLaneError';
  }
}

// ---------------------------------------------------------------------------
// Internal constants / row shapes
// ---------------------------------------------------------------------------

/** Runtime mirror of the SprintBatchTaskStatus union (the 022 CHECK domain). */
const LANE_STATUSES: readonly SprintBatchTaskStatus[] = [
  'queued',
  'running',
  'integrated',
  'failed',
  'blocked',
];

/** sprint_batch_tasks LEFT JOIN tasks projection (ref/title fail-soft null). */
interface LaneDbRow {
  batch_id: string;
  task_id: string;
  status: SprintBatchTaskStatus;
  current_step_id: string | null;
  attempts: number;
  updated_at: string;
  ref: string | null;
  title: string | null;
}

/**
 * The `verification_requests` projection the lane read-model derives
 * `SprintLaneRow.visualVerification` from (F8 / Codex #9).
 */
interface LaneVerificationDbRow {
  enqueue_key: string | null;
  deliverable_json: string | null;
  status: string;
  failure_class: string | null;
  error_message: string | null;
}

/** Runtime membership test for the RequestStatus union (no `as` casts). */
const REQUEST_STATUS_SET: ReadonlySet<string> = new Set<string>(REQUEST_STATUS);
function isRequestStatus(value: string): value is RequestStatus {
  return REQUEST_STATUS_SET.has(value);
}

/**
 * The lane a request was fired for, read from `deliverable_json.taskRef` — the
 * CANONICAL lane link in this codebase (visualVerifyGate.parseTaskRef /
 * requestStatusForLane, verdictDelivery's lane resolution). Mirrored here rather
 * than imported because this file may not pull in DB/electron-shaped modules
 * (see the header's standalone-typecheck invariant). Fail-soft to null.
 */
function parseRequestTaskRef(json: string | null): string | null {
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object') {
      const ref = (parsed as { taskRef?: unknown }).taskRef;
      if (typeof ref === 'string' && ref.length > 0) return ref;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The LANE attempt an enqueue_key encodes (`${runId}:${taskRef}:${attempt}` — the
 * attempt is the LAST colon-segment; runId/taskRef may themselves contain colons).
 * Byte-identical rule to `verdictDelivery.parseAttemptFromEnqueueKey`, duplicated
 * for the same standalone-typecheck reason as parseRequestTaskRef. Returns null on
 * an absent/malformed key — including every MCP-fired request, which has none.
 */
function parseLaneAttemptFromEnqueueKey(enqueueKey: string | null): number | null {
  if (typeof enqueueKey !== 'string' || enqueueKey.length === 0) return null;
  const lastColon = enqueueKey.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = enqueueKey.slice(lastColon + 1);
  const n = Number.parseInt(tail, 10);
  return Number.isInteger(n) && n >= 0 && String(n) === tail.trim() ? n : null;
}

// ---------------------------------------------------------------------------
// SprintLaneStore
// ---------------------------------------------------------------------------

/**
 * Optional collaborators injected at initialize time. `getSprintMaxTasks`
 * reads the LIVE per-substrate override (ConfigManager.getSprintMaxTasks) so
 * createForRun's cap enforcement (Item 7) never drifts from the picker /
 * runs.start / experiments.start / MCP-backstop checks that already call
 * `resolveSprintMaxTasks` over the same live override — this is the FIFTH
 * (and truly final) enforcement point, inside the write chokepoint itself, so
 * no other caller of createForRun can ever bypass the cap. Omitted in tests
 * and any caller that hasn't wired ConfigManager — resolveSprintMaxTasks
 * falls back to the built-in per-substrate defaults either way, so the cap is
 * NEVER optional, only its user-configured override is.
 */
export interface SprintLaneStoreDeps {
  getSprintMaxTasks?: () => SprintMaxTasksOverrides;
  /**
   * Fired once, AFTER `createForRun`'s transaction commits, with the batch that
   * was just minted. The hook exists so work that must observe a materialized
   * batch — surfacing the HUMAN prerequisites its tasks depend on as standing
   * review items (migration 137) — can run without this store taking a
   * dependency on the review-item chokepoint.
   *
   * FAIL-SOFT by contract: the store wraps the call in try/catch and swallows
   * anything it throws. A batch that materialized must never be undone by a
   * side-effect, and a sprint must never fail to launch because a review item
   * could not be written.
   */
  onBatchMinted?: (args: { projectId: number; batchId: string; taskIds: string[] }) => void;
}

export class SprintLaneStore {
  private static instance: SprintLaneStore | null = null;

  /**
   * Per-runId cache of resolveRunFanOutInner's result, so
   * deriveLaneFromTaskDispatch (fired on EVERY PreToolUse Task dispatch) does not
   * re-read + re-resolve the frozen spec on every call. Safe to cache for the
   * process lifetime: a run's frozen spec (workflow_runs.spec_hash) is stamped
   * once at createRun and never changes, so the resolved chain for a given runId
   * is immutable for the run's lifetime. Never explicitly evicted — bounded by
   * the number of DISTINCT runIds a single process observes, which is small
   * relative to session lifetime (mirrors the singleton's own unbounded-but-small
   * lifetime scope; a process restart clears it).
   */
  private readonly fanOutInnerCache = new Map<string, readonly FanOutInnerStep[] | null>();

  /**
   * Cached table-existence checks (backward-compat shim for pre-049/051 / partial
   * test DBs). Mirrors TaskChangeRouter.columnExistsCache: a fresh store instance
   * is created per DB, so a cached true/false can never go stale within a process.
   */
  private readonly tableExistsCache = new Map<string, boolean>();

  /** Cached column-existence checks. Same rationale as {@link tableExistsCache}. */
  private readonly columnExistsCache = new Map<string, boolean>();

  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
    private readonly deps?: SprintLaneStoreDeps,
  ) {}

  /**
   * True when `table` exists in the DB. Used to gate the experiment-seed-reservation
   * clause in filterEligibleTaskIds so a post-042 / pre-049 schema keeps FILTERING
   * (the try/catch permissive degrade fires only on genuinely-broken reads, not on
   * the merely-absent A/B tables). Fail-closed to false on any error.
   */
  private tableExists(table: string): boolean {
    const cached = this.tableExistsCache.get(table);
    if (cached !== undefined) return cached;
    let exists = false;
    try {
      const row = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      exists = row !== undefined;
    } catch {
      exists = false;
    }
    this.tableExistsCache.set(table, exists);
    return exists;
  }

  /**
   * True when `table.column` exists. Gates the `executor != 'human'` clause in
   * filterEligibleTaskIds (migration 137) for the SAME reason tableExists gates
   * the experiment-seed clause: a pre-137 schema must keep filtering on
   * approval/stage/active-run, not fall into the permissive catch and disable
   * every guard at once. Fail-closed to false on any error.
   */
  private columnExists(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    const cached = this.columnExistsCache.get(key);
    if (cached !== undefined) return cached;
    let exists = false;
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
      exists = rows.some((r) => r.name === column);
    } catch {
      exists = false;
    }
    this.columnExistsCache.set(key, exists);
    return exists;
  }

  /** Cached resolveRunFanOutInner — see fanOutInnerCache's doc for why. */
  private resolveFanOutInnerCached(runId: string): readonly FanOutInnerStep[] | null {
    const cached = this.fanOutInnerCache.get(runId);
    if (cached !== undefined) return cached;
    const inner = resolveRunFanOutInner(this.db, runId);
    this.fanOutInnerCache.set(runId, inner);
    return inner;
  }

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring TaskChangeRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike, logger?: LoggerLike, deps?: SprintLaneStoreDeps): SprintLaneStore {
    SprintLaneStore.instance = new SprintLaneStore(db, logger, deps);
    return SprintLaneStore.instance;
  }

  static getInstance(): SprintLaneStore {
    if (!SprintLaneStore.instance) {
      throw new Error(
        'SprintLaneStore has not been initialized. Call SprintLaneStore.initialize() from main/src/index.ts.',
      );
    }
    return SprintLaneStore.instance;
  }

  /** Returns the singleton, or null when not initialized (early boot / tests). Mirrors StepResultStore.tryGetInstance — for fail-soft readers (e.g. the monitor's lane digest) that must never throw when the store is absent. */
  static tryGetInstance(): SprintLaneStore | null {
    return SprintLaneStore.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    SprintLaneStore.instance = null;
  }

  // --------------------------------------------------------------------------
  // createForRun — seed the lane substrate for ONE sprint run
  // --------------------------------------------------------------------------

  /**
   * Create the batch row + one queued lane per task, in ONE transaction.
   * Called by RunLauncher when a sprint run launches with seedTaskIds; the
   * launcher stamps the returned batchId onto workflow_runs.batch_id.
   *
   * The batch is born 'running' (no scheduler planning phase in the redesign)
   * with concurrency = SPRINT_BATCH_CAP and integration_branch NULL (all work
   * happens in the SHARED session worktree — there is no integration branch).
   * Duplicate task ids are collapsed (UNIQUE(batch_id, task_id)); an empty
   * selection is rejected with 'bad_request'; an ELIGIBLE selection larger
   * than the live per-substrate cap (resolveSprintMaxTasks, layered over the
   * `deps.getSprintMaxTasks` override passed at initialize time) is rejected
   * with 'batch_too_large' — the store's OWN enforcement, so no caller can
   * seed an over-cap batch by skipping its own pre-check (Item 7).
   */
  createForRun(projectId: number, substrate: CliSubstrate, taskIds: string[]): { batchId: string } {
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length === 0) {
      throw new SprintLaneError('bad_request', 'createForRun requires at least one task id');
    }

    // Q1 eligibility guard. This is the SINGLE materialization chokepoint that
    // runs.start AND handleCreateSprintBatch both converge on, so gating here
    // means neither path can seed a sprint over a pending/unready selection. A
    // task is kept ONLY when it is approved (approved_at IS NOT NULL — a NULL
    // approval is PENDING/sprint-ineligible), not archived, and sitting at a
    // ready-or-later, non-terminal board stage (position >= 6, is_terminal = 0
    // — which drops both 'Done' and 'Won't do'). Ineligible ids are DROPPED; an
    // empty result is rejected with a clear SprintLaneError.
    const eligibleTaskIds = this.filterEligibleTaskIds(projectId, uniqueTaskIds);
    if (eligibleTaskIds.length === 0) {
      // Candidates EXIST but every one failed the eligibility guard — almost always
      // because the approve-plan gate has not promoted them yet (approved_at NULL =
      // pending draft). Surface a distinct code (mapped to 'ship_no_tasks_to_materialize'
      // at the MCP seam) with a WHY message, NOT the generic 'bad_request' — do not
      // weaken the guard itself.
      const reason =
        `createForRun: ${uniqueTaskIds.length} candidate task(s) exist but none are sprint-eligible — ` +
        'likely the approve-plan gate has not promoted them (each must be approved + at ' +
        '"Ready for development" or later, not archived/done/won\'t-do)';
      this.logger?.warn('[SprintLaneStore] all candidate tasks ineligible', {
        projectId,
        candidates: uniqueTaskIds.length,
      });
      throw new SprintLaneError('no_eligible_tasks', reason);
    }

    // Batch cap (Item 7): the store OWNS this check now, not just its callers.
    // Every existing pre-check (the batch picker's client-side disable,
    // runs.start's 400, experiments.start's 400, the MCP
    // cyboflow_create_sprint_batch backstop) calls resolveSprintMaxTasks over
    // the SAME live override BEFORE reaching here — those exist purely for a
    // fast, friendly failure. This is the one check that can never be
    // bypassed by a caller that forgets its own pre-check, so it runs against
    // the FINAL eligible count (post-filter), not the raw selection size —
    // an over-selection that eligibility filtering trims back under the cap
    // must not be rejected for a size it no longer has.
    const maxTasks = resolveSprintMaxTasks(this.deps?.getSprintMaxTasks?.(), substrate);
    if (eligibleTaskIds.length > maxTasks) {
      const reason =
        `createForRun: ${eligibleTaskIds.length} eligible task(s) exceed the ${substrate} ` +
        `batch cap of ${maxTasks}`;
      this.logger?.warn('[SprintLaneStore] eligible selection exceeds the batch cap', {
        projectId,
        substrate,
        eligible: eligibleTaskIds.length,
        maxTasks,
      });
      throw new SprintLaneError('batch_too_large', reason);
    }

    const batchId = randomUUID().replace(/-/g, '');

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sprint_batches (id, project_id, substrate, status, integration_branch, concurrency)
           VALUES (?, ?, ?, 'running', NULL, ?)`,
        )
        .run(batchId, projectId, substrate, SPRINT_BATCH_CAP);

      const insertLane = this.db.prepare(
        `INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'queued')`,
      );
      for (const taskId of eligibleTaskIds) {
        insertLane.run(batchId, taskId);
      }
    });
    (txn as () => void)();

    this.logger?.info('[SprintLaneStore] lane substrate created', {
      batchId,
      projectId,
      substrate,
      tasks: eligibleTaskIds.length,
      dropped: uniqueTaskIds.length - eligibleTaskIds.length,
    });

    // POST-COMMIT HOOK (migration 137): the batch exists and its lanes are
    // durable, so a consumer may now read it. FAIL-SOFT by contract — a batch
    // that materialized must not be undone, and no side-effect may stop a sprint
    // from launching, so anything this throws is logged and swallowed.
    try {
      this.deps?.onBatchMinted?.({ projectId, batchId, taskIds: eligibleTaskIds });
    } catch (err) {
      this.logger?.warn('[SprintLaneStore] onBatchMinted hook failed (ignored)', {
        batchId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { batchId };
  }

  /**
   * Q1 sprint-eligibility filter — the single source of truth for which of a
   * candidate task-id selection may seed a sprint. A task is ELIGIBLE only when
   * it is APPROVED (tasks.approved_at IS NOT NULL — a NULL approval is PENDING,
   * backend-invisible + sprint-ineligible until plan approval), NOT archived
   * (archived_at IS NULL), and sitting at a ready-or-later, NON-terminal board
   * stage (board_stages.position >= 6 — '>= 6' tolerates in-dev movement per the
   * ship promote-before-batch ordering — AND is_terminal = 0, which drops both
   * 'Done' (pos 9) and 'Won't do' (pos 10)), and driven by an AGENT
   * (tasks.executor != 'human', migration 137 — human work never becomes a lane;
   * see findHumanTaskIds for the reason the launch boundary reports separately).
   * Candidate ids with no tasks row are dropped (inner JOIN). Input order is
   * preserved; duplicates are collapsed.
   *
   * Called by createForRun (the materialization chokepoint) and the runs.start
   * pre-check. On a pre-042 schema lacking approved_at/archived_at the filter
   * degrades to PERMISSIVE (returns the unique candidates unchanged), mirroring
   * the codebase's pre-migration defensive-read precedent — production DBs
   * always carry the columns, so the guard is fully active there.
   */
  filterEligibleTaskIds(projectId: number, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(', ');
      // EXPERIMENT-SEED RESERVATION (Fix 2): a task that is the ORIGINAL seed of a
      // LIVE (non-settled) A/B experiment has no run of its own, so the double-pull
      // run guard below misses it — but the experiment's decide/fold will overwrite
      // the original's body/stage, so a normal sprint must not pull it concurrently.
      // Live = experiments.status NOT IN the terminal set (matches isExperimentSettled).
      // GATED on experiment_seed_tasks existing so a post-042 / pre-049 schema keeps
      // filtering the OTHER predicates instead of tripping the permissive catch (the
      // A/B tables being merely absent must not disable approval/stage/run guards).
      // HUMAN EXECUTOR (migration 137). Gated on the column existing for the same
      // reason as expSeedClause below: on a pre-137 schema the OTHER guards must
      // keep working rather than the whole filter degrading permissively.
      const humanClause = this.columnExists('tasks', 'executor')
        ? "AND t.executor != 'human'"
        : '';
      const expSeedClause = this.tableExists('experiment_seed_tasks')
        ? `AND NOT EXISTS (
                SELECT 1 FROM experiment_seed_tasks est
                  JOIN experiments e ON e.id = est.experiment_id
                 WHERE est.original_task_id = t.id
                   AND e.status NOT IN ('decided', 'abandoned', 'superseded')
              )`
        : '';
      // DOUBLE-PULL GUARD (migration 066): exclude any task with an ACTIVE run
      // association — a non-terminal workflow_runs row linked DIRECTLY (task_id) or
      // via a sprint BATCH the task belongs to. The run-association (not stage
      // position 7) is the source of truth, so a stale stage-7 task with no live
      // run stays pullable and self-heals on the next recompute.
      const rows = this.db
        .prepare(
          `SELECT t.id AS id
             FROM tasks t
             JOIN board_stages bs ON bs.id = t.stage_id
            WHERE t.project_id = ?
              AND t.id IN (${placeholders})
              AND t.approved_at IS NOT NULL
              AND t.archived_at IS NULL
              ${humanClause}
              AND bs.position >= 6
              AND bs.is_terminal = 0
              AND NOT EXISTS (
                SELECT 1 FROM workflow_runs wr
                 WHERE wr.status NOT IN ('completed', 'failed', 'canceled')
                   AND (
                     wr.task_id = t.id
                     OR wr.batch_id IN (
                          SELECT sbt.batch_id FROM sprint_batch_tasks sbt WHERE sbt.task_id = t.id
                        )
                   )
              )
              ${expSeedClause}`,
        )
        .all(projectId, ...unique) as Array<{ id: string }>;
      const eligible = new Set(rows.map((r) => r.id));
      return unique.filter((id) => eligible.has(id));
    } catch (err) {
      if (err instanceof Error && /no such (column|table)/i.test(err.message)) {
        this.logger?.debug('[SprintLaneStore] eligibility filter skipped (pre-042/pre-022/pre-049/pre-137 schema)', {
          error: err.message,
        });
        return unique;
      }
      throw err;
    }
  }

  /**
   * Return the subset of `taskIds` that are the ORIGINAL seed of a LIVE (non-settled)
   * A/B experiment (Fix 2). While an experiment runs, only its CLONED arm tasks carry
   * run associations — the original seed has none, so the double-pull run guard in
   * filterEligibleTaskIds / findActiveRunTaskIds misses it. This SEPARATE query lets
   * the runs.start launch boundary give such a task a precise "reserved by a live
   * experiment" reason instead of the generic ineligibility message (mirrors the
   * separate-query pattern of findActiveRunTaskIds / findExperimentTaggedTaskIds).
   * "Live" = experiments.status NOT IN the terminal set ('decided'/'abandoned'/
   * 'superseded'), matching isExperimentSettled. Degrades to EMPTY on a pre-049/051
   * schema lacking experiment_seed_tasks / experiments.
   */
  findLiveExperimentSeedTaskIds(projectId: number, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT t.id AS id
             FROM tasks t
            WHERE t.project_id = ?
              AND t.id IN (${placeholders})
              AND EXISTS (
                SELECT 1 FROM experiment_seed_tasks est
                  JOIN experiments e ON e.id = est.experiment_id
                 WHERE est.original_task_id = t.id
                   AND e.status NOT IN ('decided', 'abandoned', 'superseded')
              )`,
        )
        .all(projectId, ...unique) as Array<{ id: string }>;
      const reserved = new Set(rows.map((r) => r.id));
      return unique.filter((id) => reserved.has(id));
    } catch (err) {
      if (err instanceof Error && /no such (column|table)/i.test(err.message)) {
        this.logger?.debug('[SprintLaneStore] live-experiment-seed scope skipped (pre-049/051 schema)', {
          error: err.message,
        });
        return [];
      }
      throw err;
    }
  }

  /**
   * Return the subset of `taskIds` whose executor is 'human' (migration 137).
   *
   * Used ONLY by the runs.start launch boundary. `filterEligibleTaskIds` now
   * drops human tasks, and without this query they would fall into the
   * pre-check's generic `other` bucket and be reported as "must be approved + at
   * 'Ready for development' or later, not archived/done" — which is false for an
   * approved, ready-staged human task and sends the user looking for a state
   * problem that is not there. Same fail-soft separate-query shape as
   * findActiveRunTaskIds / findLiveExperimentSeedTaskIds; degrades to EMPTY on a
   * pre-137 schema, which is correct (no task can be human before the column).
   */
  findHumanTaskIds(projectId: number, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT t.id AS id
             FROM tasks t
            WHERE t.project_id = ?
              AND t.id IN (${placeholders})
              AND t.executor = 'human'`,
        )
        .all(projectId, ...unique) as Array<{ id: string }>;
      const human = new Set(rows.map((r) => r.id));
      return unique.filter((id) => human.has(id));
    } catch (err) {
      if (err instanceof Error && /no such (column|table)/i.test(err.message)) {
        this.logger?.debug('[SprintLaneStore] human-task scope skipped (pre-137 schema)', {
          error: err.message,
        });
        return [];
      }
      throw err;
    }
  }

  /**
   * Return the subset of `taskIds` that currently hold an ACTIVE run association —
   * a non-terminal workflow_runs row linked DIRECTLY (task_id) or via a sprint
   * BATCH the task belongs to. Used ONLY by the runs.start launch boundary to give
   * a task rejected by filterEligibleTaskIds a precise "already in development"
   * reason instead of the generic ineligibility message (mirrors the separate-query
   * pattern of findExperimentTaggedTaskIds). Degrades to EMPTY on a schema lacking
   * workflow_runs/sprint_batch_tasks.
   */
  findActiveRunTaskIds(projectId: number, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT t.id AS id
             FROM tasks t
            WHERE t.project_id = ?
              AND t.id IN (${placeholders})
              AND EXISTS (
                SELECT 1 FROM workflow_runs wr
                 WHERE wr.status NOT IN ('completed', 'failed', 'canceled')
                   AND (
                     wr.task_id = t.id
                     OR wr.batch_id IN (
                          SELECT sbt.batch_id FROM sprint_batch_tasks sbt WHERE sbt.task_id = t.id
                        )
                   )
              )`,
        )
        .all(projectId, ...unique) as Array<{ id: string }>;
      const active = new Set(rows.map((r) => r.id));
      return unique.filter((id) => active.has(id));
    } catch (err) {
      if (err instanceof Error && /no such (column|table)/i.test(err.message)) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Return the subset of `taskIds` that are experiment-arm tasks (experiment_id
   * IS NOT NULL). Used ONLY by the runs.start launch boundary to REJECT a normal
   * (non-experiment) sprint selection that names a hidden arm task.
   *
   * WHY this is a SEPARATE query and NOT folded into filterEligibleTaskIds:
   * experiment-arm tasks are now approved_at-stamped (they must be, so the arm's
   * OWN materialize — createForRun, which shares filterEligibleTaskIds — accepts
   * its tagged clones). Board visibility is gated on the experiment_id TAG, not
   * approved_at. So a tagged+approved task IS sprint-eligible by that filter; the
   * only thing that must stop a FOREIGN launch from executing it is this
   * boundary check. The arm's own launch (runLauncher.launch) and materialize
   * (cyboflow_create_sprint_batch → run-scoped intersect) never route through the
   * runs.start pre-check, so scoping here does not affect them. Degrades to
   * EMPTY (no rejections) on a pre-049 schema lacking experiment_id.
   */
  findExperimentTaggedTaskIds(projectId: number, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT id FROM tasks
            WHERE project_id = ?
              AND id IN (${placeholders})
              AND experiment_id IS NOT NULL`,
        )
        .all(projectId, ...unique) as Array<{ id: string }>;
      const tagged = new Set(rows.map((r) => r.id));
      return unique.filter((id) => tagged.has(id));
    } catch (err) {
      if (err instanceof Error && /no such column/i.test(err.message)) {
        this.logger?.debug('[SprintLaneStore] experiment-tag scope skipped (pre-049 schema)', {
          error: err.message,
        });
        return [];
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // addLane / removeLane — mid-run lane roster edits (monitor steering)
  // --------------------------------------------------------------------------

  /**
   * Resolve a task identifier that may be EITHER the opaque `tasks.id` OR its
   * display `ref` (e.g. TASK-001) to the canonical opaque id, scoped to
   * `projectId`. Opaque id wins (an exact `id` match is tried first, mirroring
   * TaskChangeRouter.resolveTaskByRefOrId); on a miss the lookup falls back to
   * the project-scoped `ref` (UNIQUE(project_id, ref) ⇒ unambiguous). Returns
   * undefined when neither resolves. Used by addLane, which — unlike
   * updateLane's by-existing-lane resolution — has no sprint_batch_tasks row
   * yet to resolve against, so it must go straight to the tasks table.
   */
  private resolveTaskId(projectId: number, identifier: string): string | undefined {
    const byId = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(identifier) as
      | { id: string }
      | undefined;
    if (byId) return byId.id;
    const byRef = this.db
      .prepare('SELECT id FROM tasks WHERE project_id = ? AND ref = ?')
      .get(projectId, identifier) as { id: string } | undefined;
    return byRef?.id;
  }

  /** The run currently owning a batch (1:1, RunLauncher-stamped at launch). Mirrors resetFailedLanes' lookup. */
  private resolveOwningRunId(batchId: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM workflow_runs WHERE batch_id = ?').get(batchId) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  /**
   * Add ONE new 'queued' lane to a running batch — lets the monitor steer a
   * sprint mid-run by adding a task after createForRun already seeded the
   * initial roster. `taskId` may be the opaque tasks.id or the display ref
   * (resolveTaskId, project-scoped).
   *
   * Rejections (SprintLaneError):
   *   - 'bad_request'       — unknown batch; `taskId` resolves to no tasks
   *                           row in this project; the batch is already
   *                           terminal (TERMINAL_BATCH_STATUSES — a
   *                           completed/failed/canceled batch accepts no new
   *                           work); or the task already has a lane in this
   *                           batch (UNIQUE(batch_id, task_id) — checked up
   *                           front with a SELECT for a clean message rather
   *                           than catching the constraint error).
   *   - 'no_eligible_tasks' — the resolved task fails the SAME Q1 guard
   *                           createForRun applies (filterEligibleTaskIds):
   *                           not approved, not archived-free, or not at a
   *                           ready-or-later non-terminal board stage.
   *
   * Emits a SprintLaneChangedEvent on the batch's owning run's channel
   * (status='queued') so the swimlane canvas picks up the new lane live. The
   * owning run is resolved the same way resetFailedLanes does
   * (workflow_runs.batch_id, 1:1) — a missing owning run should not happen
   * (RunLauncher stamps batch_id at launch) but is logged and skipped rather
   * than failing the insert.
   */
  addLane(args: { projectId: number; batchId: string; taskId: string }): SprintLaneRow {
    const { projectId, batchId, taskId } = args;

    const batch = this.db.prepare('SELECT status FROM sprint_batches WHERE id = ?').get(batchId) as
      | { status: string }
      | undefined;
    if (!batch) {
      throw new SprintLaneError('bad_request', `no batch ${batchId}`);
    }
    if ((TERMINAL_BATCH_STATUSES as readonly string[]).includes(batch.status)) {
      throw new SprintLaneError(
        'bad_request',
        `batch ${batchId} is terminal (${batch.status}) and cannot accept new lanes`,
      );
    }

    const resolvedTaskId = this.resolveTaskId(projectId, taskId);
    if (!resolvedTaskId) {
      throw new SprintLaneError('bad_request', `no task ${taskId} in project ${projectId}`);
    }

    const eligible = this.filterEligibleTaskIds(projectId, [resolvedTaskId]);
    if (eligible.length === 0) {
      throw new SprintLaneError(
        'no_eligible_tasks',
        `task ${taskId} is not sprint-eligible: it must be approved and at "Ready for development" ` +
          "or later, not archived/done/won't-do",
      );
    }

    const txn = this.db.transaction(() => {
      const dup = this.db
        .prepare('SELECT id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, resolvedTaskId);
      if (dup) {
        throw new SprintLaneError('bad_request', `task ${taskId} is already in this batch`);
      }
      this.db
        .prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'queued')`)
        .run(batchId, resolvedTaskId);
    });
    (txn as () => void)();

    const lane = this.readLane(batchId, resolvedTaskId);
    if (!lane) {
      // Row vanished between commit and read-back — surface as not_found (parity with updateLane).
      throw new SprintLaneError('lane_not_found', `lane for task ${resolvedTaskId} vanished after insert`);
    }

    const runId = this.resolveOwningRunId(batchId);
    if (runId) {
      const event: SprintLaneChangedEvent = {
        runId,
        batchId,
        taskId: resolvedTaskId,
        status: lane.status,
        currentStepId: lane.currentStepId,
        attempts: lane.attempts,
        // F8 round-2: carried on the event so a live-watched canvas learns the
        // verdict without re-querying the snapshot (the read-back `lane` already
        // holds the derivation).
        visualVerification: lane.visualVerification,
        timestamp: lane.updatedAt,
      };
      sprintLaneEvents.emit(sprintLaneChannel(runId), event);
    } else {
      this.logger?.warn('[SprintLaneStore] addLane: no owning run for batch (event not emitted)', {
        batchId,
      });
    }

    this.logger?.info('[SprintLaneStore] lane added mid-run', { batchId, taskId: resolvedTaskId });
    return lane;
  }

  /**
   * Remove ONE not-yet-started lane from a batch — lets the monitor steer a
   * sprint mid-run by dropping a queued task before any subagent has touched
   * it. `taskId` may be the opaque tasks.id or the display ref, resolved the
   * SAME way updateLane resolves it: an exact task_id match against THIS
   * batch's lanes is tried first (join-free, so it works even when the tasks
   * row is absent), and only on a miss does the lookup fall back to the
   * display ref via the tasks join, scoped to this batch.
   *
   * Only a 'queued' lane may be removed. There is no 'canceled' lane status
   * (adding one needs a CHECK-constraint migration on sprint_batch_tasks —
   * out of scope here), so a lane that has already started ('running') or
   * settled ('integrated' / 'failed' / 'blocked') is rejected rather than
   * half-modeled by deleting live/finished work out from under the
   * orchestrator.
   *
   * Rejections (SprintLaneError):
   *   - 'lane_not_found' — no (batch, task) lane.
   *   - 'bad_request'    — the lane exists but is not 'queued'.
   *
   * Best-effort emits a SprintLaneChangedEvent (status='queued', the lane's
   * last known state) on the batch's owning run channel so the swimlane
   * canvas can drop the row immediately; there is no dedicated "removed"
   * event shape, and a missed/failed emit is fail-soft (never fails the
   * delete) because `listLanes` is the canvas's authoritative source on its
   * next fetch regardless.
   */
  removeLane(args: { projectId: number; batchId: string; taskId: string }): { removed: boolean } {
    const { batchId, taskId } = args;

    let resolvedTaskId = taskId;
    const txn = this.db.transaction(() => {
      let existing = this.db
        .prepare('SELECT id, status FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, taskId) as { id: number; status: SprintBatchTaskStatus } | undefined;
      if (!existing) {
        const byRef = this.db
          .prepare(
            `SELECT sbt.id AS id, sbt.status AS status, sbt.task_id AS taskId
               FROM sprint_batch_tasks sbt
               JOIN tasks t ON t.id = sbt.task_id
              WHERE sbt.batch_id = ? AND t.ref = ?`,
          )
          .get(batchId, taskId) as { id: number; status: SprintBatchTaskStatus; taskId: string } | undefined;
        if (byRef) {
          existing = { id: byRef.id, status: byRef.status };
          resolvedTaskId = byRef.taskId;
        }
      }
      if (!existing) {
        throw new SprintLaneError('lane_not_found', `no lane for task ${taskId} in batch ${batchId}`);
      }
      if (existing.status !== 'queued') {
        throw new SprintLaneError(
          'bad_request',
          `task ${taskId} has already started/finished (status '${existing.status}') and cannot be removed`,
        );
      }
      this.db.prepare('DELETE FROM sprint_batch_tasks WHERE id = ?').run(existing.id);
    });
    (txn as () => void)();

    try {
      const runId = this.resolveOwningRunId(batchId);
      if (runId) {
        const event: SprintLaneChangedEvent = {
          runId,
          batchId,
          taskId: resolvedTaskId,
          status: 'queued',
          currentStepId: null,
          attempts: 0,
          // The lane row is gone; there is nothing left to attribute a request to.
          visualVerification: null,
          timestamp: new Date().toISOString(),
        };
        sprintLaneEvents.emit(sprintLaneChannel(runId), event);
      }
    } catch (err) {
      this.logger?.debug('[SprintLaneStore] removeLane: event emit failed (fail-soft)', {
        batchId,
        taskId: resolvedTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.logger?.info('[SprintLaneStore] lane removed mid-run', { batchId, taskId: resolvedTaskId });
    return { removed: true };
  }

  // --------------------------------------------------------------------------
  // updateLane — the per-task progress write
  // --------------------------------------------------------------------------

  /**
   * Update one lane's status and/or current step, then emit a
   * SprintLaneChangedEvent on sprintLaneChannel(runId).
   *
   * Rejections (SprintLaneError):
   *   - 'bad_request'    — neither status nor currentStepId given, status not
   *                        in the SprintBatchTaskStatus domain, a non-null
   *                        currentStepId outside the allowed step-id set, or an
   *                        attempt that is not an integer >= 1.
   *   - 'lane_not_found' — no (batch_id, task_id) row.
   *
   * `currentStepId` semantics: undefined = leave unchanged; null = clear.
   * `allowedStepIds` semantics: the lane-step vocabulary a non-null
   * `currentStepId` is validated against. undefined ⇒ defaults to
   * SPRINT_LANE_STEP_IDS (the orchestrated / sprint contract — byte-identical
   * to the pre-generalization behavior). The host fan-out driver passes a
   * per-fanOut-step inner-id set so non-sprint flows declare their own lane
   * vocabulary.
   * `attempt` semantics: sets the attempts column verbatim (1-based; the
   * orchestrator reports 2, 3, ... when re-delegating implement after a
   * verify failure — see SprintLaneRow.attempts). undefined = leave unchanged.
   * `status='integrated'` stamps integrated_at (task complete + committed in
   * the session worktree). updated_at is always bumped.
   */
  updateLane(args: {
    runId: string;
    batchId: string;
    taskId: string;
    status?: SprintBatchTaskStatus;
    currentStepId?: string | null;
    attempt?: number;
    allowedStepIds?: readonly string[];
  }): SprintLaneRow {
    const { runId, batchId, taskId, status, currentStepId, attempt } = args;

    if (status === undefined && currentStepId === undefined && attempt === undefined) {
      throw new SprintLaneError('bad_request', 'updateLane requires at least one of status / currentStepId / attempt');
    }
    if (status !== undefined && !LANE_STATUSES.includes(status)) {
      throw new SprintLaneError('bad_request', `unknown lane status '${String(status)}'`);
    }
    const allowed = args.allowedStepIds ?? (SPRINT_LANE_STEP_IDS as readonly string[]);
    if (currentStepId !== undefined && currentStepId !== null && !allowed.includes(currentStepId)) {
      throw new SprintLaneError(
        'bad_request',
        `unknown lane step '${currentStepId}' (expected one of ${allowed.join(', ')})`,
      );
    }
    if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
      throw new SprintLaneError('bad_request', `attempt must be an integer >= 1 (got ${String(attempt)})`);
    }

    const now = new Date().toISOString();

    // The lane is keyed by the opaque tasks.id, but agents only see the display
    // ref (e.g. TASK-008) in the seeded sprint-task block — so accept EITHER and
    // normalize to the canonical opaque id (parity with cyboflow_add_task_dependency's
    // resolveTaskByRefOrId). Opaque id wins: the exact task_id match is tried first
    // (join-free, so a lane whose tasks row is absent still resolves); only on a
    // miss do we resolve the display ref via the tasks.ref join, scoped to THIS batch.
    let resolvedTaskId = taskId;

    const txn = this.db.transaction(() => {
      let existing = this.db
        .prepare('SELECT id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, taskId) as { id: number } | undefined;
      if (!existing) {
        const byRef = this.db
          .prepare(
            `SELECT sbt.id AS id, sbt.task_id AS taskId
               FROM sprint_batch_tasks sbt
               JOIN tasks t ON t.id = sbt.task_id
              WHERE sbt.batch_id = ? AND t.ref = ?`,
          )
          .get(batchId, taskId) as { id: number; taskId: string } | undefined;
        if (byRef) {
          existing = { id: byRef.id };
          resolvedTaskId = byRef.taskId;
        }
      }
      if (!existing) {
        throw new SprintLaneError('lane_not_found', `no lane for task ${taskId} in batch ${batchId}`);
      }

      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];
      if (status !== undefined) {
        sets.push('status = ?');
        params.push(status);
        if (status === 'integrated') {
          sets.push('integrated_at = ?');
          params.push(now);
        }
      }
      if (currentStepId !== undefined) {
        sets.push('current_step_id = ?');
        params.push(currentStepId);
      }
      if (attempt !== undefined) {
        sets.push('attempts = ?');
        params.push(attempt);
      }
      params.push(existing.id);
      this.db.prepare(`UPDATE sprint_batch_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    });
    (txn as () => void)();

    const lane = this.readLane(batchId, resolvedTaskId);
    if (!lane) {
      // Row vanished between commit and read-back — surface as not_found.
      throw new SprintLaneError('lane_not_found', `lane for task ${resolvedTaskId} vanished after update`);
    }

    const event: SprintLaneChangedEvent = {
      runId,
      batchId,
      taskId: resolvedTaskId,
      status: lane.status,
      currentStepId: lane.currentStepId,
      attempts: lane.attempts,
      // F8 round-2: THE seam that makes the feature live. The visual merge gate
      // drives a lane through this chokepoint only AFTER the scheduler's
      // markTerminal has committed the verdict, so the integrating event carries
      // the real outcome — without it a live canvas kept the mount-time snapshot's
      // `null` and painted every integrated lane "Visual check did not run".
      visualVerification: lane.visualVerification,
      timestamp: now,
    };
    sprintLaneEvents.emit(sprintLaneChannel(runId), event);

    return lane;
  }

  // --------------------------------------------------------------------------
  // deriveLaneFromTaskDispatch — observe-only auto-advance (substrate-agnostic)
  // --------------------------------------------------------------------------

  /**
   * BACKSTOP for the lane substrate: given a parent-orchestrator PreToolUse
   * Task-tool dispatch, advance the matching lane to status='running' with the
   * derived current step — without relying on the orchestrator calling
   * cyboflow_update_sprint_task. Called from BOTH PreToolUse seams (the
   * interactive orchestrator-socket handler and the SDK in-process hook) so it
   * fires regardless of substrate. The SINGLE write goes through updateLane, so
   * the existing sprintLaneEvents -> tRPC -> SprintLanesPanel pipeline lights up.
   *
   * Fully defensive (never throws — the caller's gating/verdict path must always
   * proceed). Strict NO-OP for: the 'orchestrator' sentinel, non-Task tools,
   * unmapped/phase-wide subagent_types, non-sprint runs (NULL batch_id), empty
   * lane lists, ambiguous multi-lane attribution, and any lane already
   * at-or-past the derived step (monotonic-forward — loopbacks that re-dispatch
   * `implement` keep the further-along step; terminal lanes are never resurrected).
   *
   * The agent->step map and the monotonic ordering are CHAIN-DERIVED (resolved
   * from the calling run's fanOut.inner, cached per runId via
   * resolveFanOutInnerCached) rather than always the static
   * SPRINT_SUBAGENT_TO_LANE_STEP / SPRINT_LANE_STEP_IDS pair — see the module doc
   * above. A custom chain's derived step id is passed as `allowedStepIds` on the
   * updateLane call so the write is not rejected against the (irrelevant) fixed
   * default vocabulary.
   */
  deriveLaneFromTaskDispatch(args: {
    runId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): void {
    const { runId, toolName, toolInput } = args;
    try {
      if (runId === 'orchestrator') return;
      // 'Agent' on CLI ≥~2.1.2xx, 'Task' on older CLIs — a 'Task'-only match
      // silently killed this backstop on current CLIs (see the single-home
      // helper's doc in shared/types/agentIdentity.ts).
      if (!isAgentDispatchToolName(toolName)) return;

      const subagentType = toolInput['subagent_type'];
      if (typeof subagentType !== 'string') return;

      // Chain-derived vocabulary first (resolveRunFanOutInner, cached per runId);
      // fall back to the static SPRINT_SUBAGENT_TO_LANE_STEP map/SPRINT_LANE_STEP_IDS
      // ordering when the run's definition is unresolvable or has no fanOut step.
      // The fallback IS the canonical mapping, so an unedited sprint/ship run is
      // byte-identical either way.
      const inner = this.resolveFanOutInnerCached(runId);
      let step: string;
      let stepOrder: readonly string[];
      let allowedStepIds: readonly string[] | undefined;
      if (inner && inner.length > 0) {
        const { agentMap, order } = buildDynamicStepVocabulary(inner);
        const derived = agentMap.get(subagentType);
        if (derived === undefined) return;
        step = derived;
        stepOrder = order;
        allowedStepIds = order;
      } else {
        const fallback = SPRINT_SUBAGENT_TO_LANE_STEP[subagentType];
        if (fallback === undefined) return;
        step = fallback;
        stepOrder = SPRINT_LANE_STEP_IDS;
        allowedStepIds = undefined; // SprintLaneStore's own canonical default.
      }

      // Resolve the run's batch (migration 022). NULL/absent batch = non-sprint
      // run -> strict no-op (mirrors handleUpdateSprintTask's read).
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return;

      // Attribution -> the lane's taskId. Single-lane batch is trivial; a
      // multi-lane wave needs an UNAMBIGUOUS ref/taskId match in the dispatch
      // prompt (0 or >1 matches -> skip safely; never guess).
      const lanes = this.listLanes(batchId);
      if (lanes.length === 0) return;

      let lane: SprintLaneRow | undefined;
      if (lanes.length === 1) {
        lane = lanes[0];
      } else {
        const prompt = typeof toolInput['prompt'] === 'string' ? toolInput['prompt'] : '';
        if (prompt === '') return;
        const matches = lanes.filter((l) => {
          const byRef = typeof l.ref === 'string' && tokenAppearsInPrompt(prompt, l.ref);
          const byId = tokenAppearsInPrompt(prompt, l.taskId);
          return byRef || byId;
        });
        if (matches.length !== 1) return;
        lane = matches[0];
      }
      if (lane === undefined) return;

      // Monotonic-forward guard: never resurrect a terminal lane; never regress a
      // lane already at-or-past this step (applies to running AND blocked; a
      // queued lane has currentStepId=null -> index -1 -> always advances). Indexed
      // against `stepOrder` (chain-derived + AWAITING_VERIFY_STEP appended, or the
      // canonical SPRINT_LANE_STEP_IDS fallback) so a lane parked at the merge-gate
      // is never regressed even when a custom chain resolved.
      if (lane.status === 'integrated' || lane.status === 'failed') return;
      const existingIdx = lane.currentStepId === null ? -1 : stepOrder.indexOf(lane.currentStepId);
      const derivedIdx = stepOrder.indexOf(step);
      if (existingIdx >= derivedIdx) return;

      this.updateLane({
        runId,
        batchId,
        taskId: lane.taskId,
        status: 'running',
        currentStepId: step,
        ...(allowedStepIds !== undefined ? { allowedStepIds } : {}),
      });
    } catch (err) {
      // Best-effort UI backstop — a lane read/write failure must never disturb
      // the caller's PreToolUse gating/verdict path.
      this.logger?.debug('[SprintLaneStore] auto-derive skipped', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /**
   * All lanes of a batch in insertion order, with ref/title resolved fail-soft
   * from the tasks table (LEFT JOIN — null when the task row is missing) and
   * blockedByRefs computed on read (see blockedByRefsForBatch — NOT stored).
   */
  listLanes(batchId: string): SprintLaneRow[] {
    const rows = this.db
      .prepare(
        `SELECT bt.batch_id, bt.task_id, bt.status, bt.current_step_id, bt.attempts, bt.updated_at,
                t.ref AS ref, t.title AS title
           FROM sprint_batch_tasks bt
           LEFT JOIN tasks t ON t.id = bt.task_id
          WHERE bt.batch_id = ?
          ORDER BY bt.id ASC`,
      )
      .all(batchId) as LaneDbRow[];
    const blockedBy = this.blockedByRefsForBatch(batchId);
    const visual = this.visualVerificationForLanes(batchId, rows);
    return rows.map((row) =>
      this.toLaneRow(row, blockedBy.get(row.task_id) ?? [], visual.get(row.task_id) ?? null),
    );
  }

  /** One lane (same projection as listLanes), or undefined when absent. */
  private readLane(batchId: string, taskId: string): SprintLaneRow | undefined {
    const row = this.db
      .prepare(
        `SELECT bt.batch_id, bt.task_id, bt.status, bt.current_step_id, bt.attempts, bt.updated_at,
                t.ref AS ref, t.title AS title
           FROM sprint_batch_tasks bt
           LEFT JOIN tasks t ON t.id = bt.task_id
          WHERE bt.batch_id = ? AND bt.task_id = ?`,
      )
      .get(batchId, taskId) as LaneDbRow | undefined;
    if (!row) return undefined;
    const blockedBy = this.blockedByRefsForBatch(batchId);
    const visual = this.visualVerificationForLanes(batchId, [row]);
    return this.toLaneRow(row, blockedBy.get(row.task_id) ?? [], visual.get(row.task_id) ?? null);
  }

  /**
   * Derive each lane's REAL visual-verification outcome (F8 / Codex #9,
   * docs/proposals/visual-verification-brittleness-fixes.md §F8) — the most
   * recent `verification_requests` row attributable to the lane, or absent from
   * the map when the lane has none.
   *
   * WHY IT IS DERIVED, NOT STORED: `mergeGateLaneAdvance` integrates a lane on
   * `passed`, `low_confidence`, `skipped` AND `timeout`, and the swimlane paints
   * every step of an integrated lane 'done' — so three of those four rendered a
   * green "Visual check" for a check that never ran. A stamp on the pre-row drop
   * alone would not have fixed that; the state has to come from the request row.
   *
   * ATTRIBUTION is by `deliverable_json.taskRef` FIRST — the canonical lane link
   * the rest of the system uses (visualVerifyGate.requestStatusForLane /
   * eventMatchesLane, verdictDelivery) — matched against the lane's opaque id OR
   * its display ref, with the `enqueue_key` prefix (`<runId>:<laneTaskRef>:`,
   * enqueueFromTask.ts) kept as a secondary match. Keying on enqueue_key ALONE was
   * wrong: there are two enqueue producers and only one of them sets a key. The
   * `cyboflow_request_verification` MCP path — the ONLY path on the default
   * `orchestrated` execution model, and the path the controller ADOPTS a pre-fired
   * request through — calls VerificationScheduler.enqueue with no `enqueueKey`, so
   * its rows store NULL and were dropped here; the swimlane then told the user, of
   * a lane that had genuinely PASSED, that no request was ever created for it.
   *
   * PROOF RUNS ARE EXCLUDED by the `setup_proof` / `bootstrap_proof` COLUMNS, plus
   * the `:bootstrap:<round>` key generation as belt-and-braces — the same
   * exclusion verdictDelivery and visualVerifyGate apply: a proof's terminal is
   * never a lane's verdict even though it carries the owning lane's ref. The key
   * predicate is written `enqueue_key IS NULL OR enqueue_key NOT LIKE ...` because
   * SQL three-valued logic makes a bare NOT LIKE on NULL filter the row out — the
   * very rows this fix exists to admit.
   *
   * STALENESS: a row is marked `stale` when its LANE attempt (parsed from the
   * enqueue key) is below the lane's current `attempts`, the same supersession
   * rule mergeGateLaneAdvance applies before writing a verdict. That is how a
   * later attempt whose verification was dropped pre-row (the codex channel-
   * unavailable drop) avoids rendering the PREVIOUS attempt's FAIL as this
   * attempt's outcome.
   *
   * FAIL-SOFT / PRE-MIGRATION: any read failure (a DB predating migration 055 /
   * 095 / 107, so `verification_requests`, `failure_class` or `bootstrap_proof`
   * do not exist yet) yields an EMPTY map — every lane reports `null` ("no row"),
   * never a throw that would take the whole lane listing down with it.
   */
  private visualVerificationForLanes(
    batchId: string,
    lanes: readonly { task_id: string; ref: string | null; attempts: number }[],
  ): Map<string, SprintLaneVisualVerification> {
    const out = new Map<string, SprintLaneVisualVerification>();
    if (lanes.length === 0) return out;
    try {
      // A batch normally has exactly ONE owning run, but read them all: a
      // re-launched/resumed run reusing the batch would otherwise strand its
      // lanes' verdicts.
      const runRows = this.db
        .prepare('SELECT id FROM workflow_runs WHERE batch_id = ?')
        .all(batchId) as { id: string }[];
      const runIds = runRows.map((r) => r.id).filter((id) => typeof id === 'string' && id.length > 0);
      if (runIds.length === 0) return out;

      const placeholders = runIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT enqueue_key, deliverable_json, status, failure_class, error_message
             FROM verification_requests
            WHERE run_id IN (${placeholders})
              AND setup_proof = 0
              AND bootstrap_proof = 0
              AND (enqueue_key IS NULL OR enqueue_key NOT LIKE '%:bootstrap:%')
            ORDER BY enqueued_at DESC, rowid DESC`,
        )
        .all(...runIds) as LaneVerificationDbRow[];
      if (rows.length === 0) return out;

      // Parse each row's taskRef ONCE (not once per lane) — the scan below is
      // O(lanes x rows) and JSON.parse is the only expensive step in it.
      const candidates = rows.map((row) => ({ row, taskRef: parseRequestTaskRef(row.deliverable_json) }));

      for (const lane of lanes) {
        const prefixes: string[] = [];
        for (const runId of runIds) {
          prefixes.push(`${runId}:${lane.task_id}:`);
          if (lane.ref !== null && lane.ref.length > 0) prefixes.push(`${runId}:${lane.ref}:`);
        }
        // Rows are newest-first, so the FIRST hit is the latest attributable request.
        const hit = candidates.find(({ row, taskRef }) => {
          if (taskRef !== null && (taskRef === lane.task_id || (lane.ref !== null && taskRef === lane.ref))) {
            return true;
          }
          return row.enqueue_key !== null && prefixes.some((p) => row.enqueue_key?.startsWith(p) === true);
        });
        if (hit === undefined) continue;
        const match = hit.row;
        if (!isRequestStatus(match.status)) continue;
        const laneAttempt = parseLaneAttemptFromEnqueueKey(match.enqueue_key);
        out.set(lane.task_id, {
          status: match.status,
          failureClass: isVerificationFailureClass(match.failure_class) ? match.failure_class : null,
          errorMessage: typeof match.error_message === 'string' ? match.error_message : null,
          laneAttempt,
          stale: laneAttempt !== null && lane.attempts > laneAttempt,
        });
      }
    } catch (err) {
      this.logger?.debug('[SprintLaneStore] visual-verification derivation skipped (fail-soft)', {
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map();
    }
    return out;
  }

  /**
   * Read-side computation of each lane's IN-BATCH blocking prerequisites:
   * task_dependencies (kind='blocking') edges whose PREREQUISITE has a lane in
   * the SAME batch that is not yet 'integrated'. Display refs resolve
   * fail-soft from the tasks table (fallback to the raw task id). Returns a
   * blocked-task-id → refs map; tasks without un-integrated in-batch prereqs
   * are simply absent. Out-of-batch dependencies are ignored — this is lane
   * gating, not global dependency truth.
   */
  private blockedByRefsForBatch(batchId: string): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT dep.task_id AS blocked_task_id,
                COALESCE(t.ref, dep.depends_on_task_id) AS prereq_ref
           FROM task_dependencies dep
           JOIN sprint_batch_tasks pre
             ON pre.batch_id = ?
            AND pre.task_id = dep.depends_on_task_id
            AND pre.status != 'integrated'
           LEFT JOIN tasks t ON t.id = dep.depends_on_task_id
          WHERE dep.kind = 'blocking'
          ORDER BY dep.id ASC`,
      )
      .all(batchId) as Array<{ blocked_task_id: string; prereq_ref: string }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const refs = map.get(row.blocked_task_id);
      if (refs) {
        refs.push(row.prereq_ref);
      } else {
        map.set(row.blocked_task_id, [row.prereq_ref]);
      }
    }
    return map;
  }

  private toLaneRow(
    row: LaneDbRow,
    blockedByRefs: string[],
    visualVerification: SprintLaneVisualVerification | null,
  ): SprintLaneRow {
    return {
      batchId: row.batch_id,
      taskId: row.task_id,
      status: row.status,
      currentStepId: row.current_step_id,
      ref: row.ref,
      title: row.title,
      attempts: row.attempts,
      blockedByRefs,
      visualVerification,
      updatedAt: row.updated_at,
    };
  }

  // --------------------------------------------------------------------------
  // resetFailedLanes — retry chokepoint (retryRunHandler)
  // --------------------------------------------------------------------------

  /**
   * Re-queue every 'failed' OR 'blocked' lane of a batch back to 'queued'
   * (clearing current_step_id), so a fan-out RETRY re-dispatches them instead
   * of instantly re-settling with the same failures. The production fan-out
   * driver (fanOutDriverFactory.resolveItems, main/src/index.ts) filters OUT
   * lanes already marked 'integrated', 'failed' or 'blocked' — without this
   * reset, a retried fanOut step would see zero eligible items for every
   * previously-failed-or-blocked lane. 'blocked' lanes are included because
   * they never started (Item 6: a lane blocks when a prerequisite failed) —
   * a retry needs them back in the dispatchable pool exactly like a lane that
   * DID run and failed.
   *
   * Routes each reset through `updateLane` (rather than a raw batch UPDATE) so
   * the write + SprintLaneChangedEvent emit pipeline is IDENTICAL to every
   * other lane mutation (driveLane, deriveLaneFromTaskDispatch) — same
   * channel, same event shape. `attempts` is left untouched (the next
   * dispatch's own progress report bumps it).
   *
   * The owning run is resolved from `workflow_runs.batch_id` (a batch belongs
   * to exactly one run — RunLauncher stamps it 1:1 at launch) so the caller
   * only needs to supply `batchId`, mirroring retryRunHandler's
   * `RetryRunDeps.resetFailedLanes` signature.
   *
   * Fail-soft: never throws. Returns the number of lanes reset, or 0 when
   * there are no failed/blocked lanes, the batch has no owning run, or
   * anything in between errors (logged at 'warn').
   */
  resetFailedLanes(batchId: string): number {
    try {
      const resetTaskIds = (
        this.db
          .prepare(
            `SELECT task_id AS taskId FROM sprint_batch_tasks WHERE batch_id = ? AND status IN ('failed', 'blocked')`,
          )
          .all(batchId) as Array<{ taskId: string }>
      ).map((r) => r.taskId);
      if (resetTaskIds.length === 0) return 0;

      const runRow = this.db
        .prepare('SELECT id FROM workflow_runs WHERE batch_id = ?')
        .get(batchId) as { id: string } | undefined;
      if (!runRow) {
        this.logger?.warn('[SprintLaneStore] resetFailedLanes: no owning run for batch (skipped)', {
          batchId,
        });
        return 0;
      }

      let reset = 0;
      for (const taskId of resetTaskIds) {
        this.updateLane({ runId: runRow.id, batchId, taskId, status: 'queued', currentStepId: null });
        reset += 1;
      }
      this.logger?.info('[SprintLaneStore] reset failed/blocked fan-out lanes for retry', {
        batchId,
        runId: runRow.id,
        count: reset,
      });
      return reset;
    } catch (err) {
      this.logger?.warn('[SprintLaneStore] resetFailedLanes failed (fail-soft)', {
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // reviveLane — targeted failed→running un-settle (controller merge-gate rescue)
  // --------------------------------------------------------------------------

  /**
   * Un-settle ONE lane from 'failed' back to 'running'.
   *
   * SCOPE — this exists for exactly ONE caller: the WorkflowController's
   * MONITOR LANE RESCUE at the visual merge gate, from INSIDE a live fan-out
   * walk. The merge-gate driver durably wrote the lane 'failed' before
   * `awaitVerdict` resolved, so a lane the supervisor decides to rescue is
   * already settled in the DB even though its in-memory walk is still running
   * and about to re-drive it. Every OTHER un-settle path must keep refusing:
   * the wave loop never un-settles a lane (a settled lane is excluded from
   * `remaining` and from the production driver's `resolveItems`), and
   * `laneRewindHandler` must keep refusing settled lanes from OUTSIDE the walk
   * — reviving a lane no walk is driving would strand a 'running' row nothing
   * advances. Do not reach for this anywhere else.
   *
   * Status-GUARDED to 'failed' only, mirroring `reopenBatch`'s guarded-UPDATE
   * discipline: a queued / running / integrated lane is an idempotent no-op, so
   * a double consult (or a rescue racing a lane that never settled) can never
   * flip a lane backwards out of 'integrated'. The guard is a read-then-write
   * rather than a `WHERE status='failed'` clause because the write itself MUST
   * go through the `updateLane` chokepoint — the same write + emit pipeline
   * every other lane mutation uses (driveLane, resetFailedLanes), so the
   * revival lands on `sprintLaneChannel` like any other lane change. Both halves
   * are synchronous better-sqlite3 calls on the single main-process handle, so
   * nothing interleaves between them.
   *
   * `taskId` accepts EITHER the opaque tasks.id or the display ref, resolved the
   * same way `updateLane` resolves it (opaque id first, then the ref join scoped
   * to this batch) so the status guard reads the same row the write will target.
   *
   * `current_step_id` is deliberately left alone: the rescue's very next
   * `driveLane` stamps the target inner step, and clearing it here would blank
   * the lane's step chip for the width of that gap.
   *
   * Fail-soft: never throws. Returns 1 on a revive, 0 when the lane is missing,
   * not 'failed', has no owning run, or anything errors (logged at 'warn').
   */
  reviveLane(batchId: string, taskId: string): number {
    try {
      let resolvedTaskId = taskId;
      let row = this.db
        .prepare('SELECT status FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, taskId) as { status: string } | undefined;
      if (!row) {
        const byRef = this.db
          .prepare(
            `SELECT sbt.status AS status, sbt.task_id AS taskId
               FROM sprint_batch_tasks sbt
               JOIN tasks t ON t.id = sbt.task_id
              WHERE sbt.batch_id = ? AND t.ref = ?`,
          )
          .get(batchId, taskId) as { status: string; taskId: string } | undefined;
        if (byRef) {
          row = { status: byRef.status };
          resolvedTaskId = byRef.taskId;
        }
      }
      if (!row) {
        this.logger?.debug('[SprintLaneStore] reviveLane no-op (no such lane)', { batchId, taskId });
        return 0;
      }
      if (row.status !== 'failed') {
        this.logger?.debug('[SprintLaneStore] reviveLane no-op (lane is not failed)', {
          batchId,
          taskId: resolvedTaskId,
          status: row.status,
        });
        return 0;
      }

      const runRow = this.db
        .prepare('SELECT id FROM workflow_runs WHERE batch_id = ?')
        .get(batchId) as { id: string } | undefined;
      if (!runRow) {
        this.logger?.warn('[SprintLaneStore] reviveLane: no owning run for batch (skipped)', { batchId });
        return 0;
      }

      this.updateLane({ runId: runRow.id, batchId, taskId: resolvedTaskId, status: 'running' });
      this.logger?.info('[SprintLaneStore] lane revived for an in-walk rescue', {
        batchId,
        runId: runRow.id,
        taskId: resolvedTaskId,
      });
      return 1;
    } catch (err) {
      this.logger?.warn('[SprintLaneStore] reviveLane failed (fail-soft)', {
        batchId,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // markBatchTerminal — batch close-out
  // --------------------------------------------------------------------------

  /**
   * Flip a batch to a terminal status. Status-guarded: only a NON-terminal
   * batch transitions (a completed/failed/canceled batch is immutable — a late
   * second call is a logged no-op, mirroring the old scheduler's guarded
   * UPDATEs). Stamps completed_at alongside.
   */
  markBatchTerminal(batchId: string, status: 'completed' | 'failed' | 'canceled'): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE sprint_batches
            SET status = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
      )
      .run(status, now, now, batchId);
    if (result.changes === 0) {
      this.logger?.debug('[SprintLaneStore] markBatchTerminal no-op (batch missing or already terminal)', {
        batchId,
        status,
      });
      return;
    }
    this.logger?.info('[SprintLaneStore] batch terminal', { batchId, status });
  }

  // --------------------------------------------------------------------------
  // reopenBatch — un-terminal a FAILED batch for retry (retryRunHandler)
  // --------------------------------------------------------------------------

  /**
   * Un-terminal a batch that was marked 'failed' back to 'running' (clearing
   * completed_at), so a successful RETRY's completion close-out can re-stamp it
   * terminal via markBatchTerminal (which is otherwise a guaranteed no-op on an
   * already-terminal row). Status-guarded to 'failed' ONLY: a completed or
   * canceled batch is IMMUTABLE — reviving a canceled batch would violate cancel
   * semantics, and a completed one has nothing to retry. Mirrors
   * markBatchTerminal's guarded-UPDATE style; like every batch-status change it
   * emits NOTHING (only logs) — batch status is polled via listLanes/read paths,
   * not the sprintLaneEvents channel.
   *
   * Fail-soft: never throws. Returns the number of rows changed — 1 on a revive,
   * 0 when the batch is missing, already 'running', terminal-non-failed
   * (completed/canceled), or anything errors (logged at 'warn').
   */
  reopenBatch(batchId: string): number {
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE sprint_batches
              SET status = 'running', completed_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'failed'`,
        )
        .run(now, batchId);
      if (result.changes === 0) {
        this.logger?.debug('[SprintLaneStore] reopenBatch no-op (batch missing or not failed)', {
          batchId,
        });
        return 0;
      }
      this.logger?.info('[SprintLaneStore] batch reopened for retry', { batchId });
      return result.changes;
    } catch (err) {
      this.logger?.warn('[SprintLaneStore] reopenBatch failed (fail-soft)', {
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}
