/**
 * insightsQueries — pure SELECT/aggregation helpers backing the Insights view.
 *
 * Every export is a side-effect-free read over a `DatabaseLike` (the narrow
 * orchestrator surface). They produce the shared contract shapes declared in
 * `shared/types/insights.ts` and are surfaced verbatim through the
 * `cyboflow.insights` tRPC router.
 *
 * Standalone-typecheck invariant (mirrors inspectorQueries.ts / runRawEventsListing.ts):
 * this file must NOT import from 'electron', 'better-sqlite3', 'fs', or any
 * concrete service in main/src/services/*. Only DatabaseLike + shared types.
 *
 * Token/cost aggregation contract (see the shared file's header for the full
 * substrate caveat):
 *   - Token sums come ONLY from `assistant` payloads' `message.usage`. We never
 *     add `result.usage` tokens — `result` events restate per-turn totals and
 *     summing both double-counts (FIND-class double-count guard).
 *   - `costUsd` / `numTurns` come from `result` payloads' `total_cost_usd` /
 *     `num_turns`, SUMMED across results (a resumed run emits one `result` per
 *     turn-session). Null when no result ever carried the field.
 *
 * Materialized-row contract (migration 026): a `run_usage` row, when present,
 * is the precomputed projection of the same `assistant`/`result` scan above —
 * written once at run finalization. The two read-heavy rollup paths
 * (`selectRunUsageRollups` / `selectWorkflowUsageStats`) prefer it and skip the
 * raw_events scan for any run that has one, falling back to the live scan ONLY
 * for runs without a materialized row (historic runs, runs still in flight).
 * The WRITER of that row (`rollupRunUsage` in runUsageRollup.ts) must NOT use the
 * materialized-first read — it would read back its own stale row on each
 * re-materialization and freeze the values. It takes the force-scan sibling
 * `selectRunUsageRollupsFromRawEvents` instead, which always re-scans raw_events.
 *
 * SQLite DATETIME columns are stored as 'YYYY-MM-DD HH:MM:SS' (space-separated,
 * UTC). `toIso` below normalizes them to ISO-8601 strings for the tRPC boundary.
 */
import type { DatabaseLike } from './types';
import type {
  WorkflowRunStats,
  RunUsageRollup,
  WorkflowUsageStats,
  ReviewItemSummary,
  QualityFinding,
  StepTokenBucket,
  UsageTrendPoint,
  WorkflowRevisionStats,
  DailyModelUsagePoint,
  RunEval,
  RunEvalStatus,
  RunEvalBand,
  RunEvalDimension,
} from '../../../shared/types/insights';
import { parseSourceStep } from '../../../shared/types/insights';
import type {
  VariantStats,
  RotationArmStats,
  RotationExperimentRun,
  RotationDashboardRow,
  ExperimentStatus,
} from '../../../shared/types/experiments';
import { MIN_VARIANT_RUNS, BASELINE_VARIANT_SENTINEL, isBaselineArm } from '../../../shared/types/experiments';
// computeSpecHash is the SAME content address workflow_runs.spec_hash was frozen
// with at createRun; hashing the live workflows.spec_json the identical way lets
// us flag the current revision. It imports only node:crypto (verified), so it
// respects this module's standalone-typecheck invariant (no electron / service deps).
import { computeSpecHash } from './specHash';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a SQLite DATETIME string ('YYYY-MM-DD HH:MM:SS', UTC) — or an
 * already-ISO string — to an ISO-8601 string. Returns null for null input.
 *
 * SQLite's CURRENT_TIMESTAMP / datetime() emit a space-separated UTC string
 * with no zone suffix. We append 'Z' (treating it as UTC, which it is) so
 * `new Date(...)` parses it deterministically across platforms rather than
 * guessing local time from the bare space-separated form.
 */
function toIso(value: string | null): string | null {
  if (value === null) return null;
  // Already ISO (carries a 'T' separator) — pass through `Date` to canonicalize.
  const candidate = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    // Defensive: hand back the raw string rather than an Invalid Date marker.
    return value;
  }
  return parsed.toISOString();
}

/** Number-guard: returns the value when it is a finite number, else 0. */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Round to 1 decimal place (used for errorRatePct). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Split an id list into chunks of at most `size` so the generated
 * `IN (?, ?, ...)` clause never exceeds SQLite's bound-parameter ceiling.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Build a comma-joined '?' placeholder string of length `n`. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** Narrow an unknown JSON value to a plain object (not array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The four terminal run statuses. A run is "terminal" once it lands in one of
 * these; everything else (queued/starting/running/awaiting_review/awaiting_input/stuck/paused) is
 * "active". Kept here as the single source for the bucketing SQL + null checks.
 */
const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;

/** SQL `IN (...)` body built from TERMINAL_STATUSES — static, never user input. */
const TERMINAL_SQL = TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ');

// ---------------------------------------------------------------------------
// 1. selectWorkflowRunStats
// ---------------------------------------------------------------------------

interface WorkflowRunStatsRow {
  workflowId: string;
  workflowName: string;
  projectId: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  activeRuns: number;
  mergedRuns: number;
  dismissedRuns: number;
  nullOutcomeRuns: number;
  /** AVG over terminal runs with both stamps; SQLite returns null when empty. */
  avgDurationMs: number | null;
  lastRunAt: string | null;
}

/**
 * Per-workflow run-outcome statistics, one GROUP BY over
 * `workflow_runs JOIN workflows`. Optionally scoped to a single project.
 *
 * Status buckets:
 *   - terminal = completed | failed | canceled
 *   - active   = every other status (queued/starting/running/awaiting_review/
 *                awaiting_input/stuck/paused)
 * Outcome buckets: mergedRuns (outcome='merged'), dismissedRuns
 * (outcome='dismissed'). nullOutcomeRuns = terminal AND outcome IS NULL.
 *
 * `errorRatePct` = failedRuns / terminalRuns * 100, rounded to 1dp in TS
 * (0 when there are no terminal runs — avoids a /0). `avgDurationMs` is
 * AVG((ended_at - started_at) ms) over terminal runs that carry both stamps.
 * `lastRunAt` is MAX(created_at), normalized to ISO.
 *
 * @param db        - Narrow DatabaseLike surface.
 * @param projectId - When non-null, restricts to that project; null = all.
 *
 * Migration-030: this scopes on `r.project_id = ?` (the RUN's project), NOT the
 * workflow's — so a GLOBAL built-in/custom flow (workflows.project_id NULL) is still
 * attributed to the project its runs executed in. The per-project drill-down therefore
 * surfaces global-flow stats correctly (grouped by workflow; the row's `projectId`
 * field reflects the workflow's own scope, NULL for globals).
 */
export function selectWorkflowRunStats(
  db: DatabaseLike,
  projectId: number | null,
): WorkflowRunStats[] {
  // (julianday(ended) - julianday(started)) is a day-delta; *86400000 → ms.
  // Averaged only over terminal runs that carry BOTH timestamps (the inner
  // CASE returns NULL otherwise, and AVG ignores NULLs).
  const sql = `
    SELECT
      w.id   AS workflowId,
      w.name AS workflowName,
      w.project_id AS projectId,
      COUNT(*) AS totalRuns,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completedRuns,
      SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END) AS failedRuns,
      SUM(CASE WHEN r.status = 'canceled'  THEN 1 ELSE 0 END) AS canceledRuns,
      SUM(CASE WHEN r.status NOT IN (${TERMINAL_SQL}) THEN 1 ELSE 0 END) AS activeRuns,
      SUM(CASE WHEN r.outcome = 'merged'    THEN 1 ELSE 0 END) AS mergedRuns,
      SUM(CASE WHEN r.outcome = 'dismissed' THEN 1 ELSE 0 END) AS dismissedRuns,
      SUM(CASE WHEN r.status IN (${TERMINAL_SQL}) AND r.outcome IS NULL THEN 1 ELSE 0 END) AS nullOutcomeRuns,
      AVG(
        CASE
          WHEN r.status IN (${TERMINAL_SQL})
               AND r.started_at IS NOT NULL
               AND r.ended_at IS NOT NULL
          THEN (julianday(r.ended_at) - julianday(r.started_at)) * 86400000.0
          ELSE NULL
        END
      ) AS avgDurationMs,
      MAX(r.created_at) AS lastRunAt
    FROM workflow_runs r
    JOIN workflows w ON w.id = r.workflow_id
    ${projectId === null ? '' : 'WHERE r.project_id = ?'}
    GROUP BY w.id, w.name, w.project_id
    ORDER BY w.name ASC
  `;

  const stmt = db.prepare(sql);
  const rows = (
    projectId === null ? stmt.all() : stmt.all(projectId)
  ) as WorkflowRunStatsRow[];

  return rows.map((row) => {
    const terminalRuns = row.completedRuns + row.failedRuns + row.canceledRuns;
    const errorRatePct =
      terminalRuns === 0 ? 0 : round1((row.failedRuns / terminalRuns) * 100);
    return {
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      projectId: row.projectId,
      totalRuns: row.totalRuns,
      activeRuns: row.activeRuns,
      completedRuns: row.completedRuns,
      failedRuns: row.failedRuns,
      canceledRuns: row.canceledRuns,
      mergedRuns: row.mergedRuns,
      dismissedRuns: row.dismissedRuns,
      nullOutcomeRuns: row.nullOutcomeRuns,
      errorRatePct,
      // SQLite AVG over an empty set returns null — keep it null (no runs timed).
      avgDurationMs: row.avgDurationMs === null ? null : row.avgDurationMs,
      lastRunAt: toIso(row.lastRunAt),
    };
  });
}

// ---------------------------------------------------------------------------
// 2. selectRunUsageRollups
// ---------------------------------------------------------------------------

interface RawEventUsageRow {
  runId: string;
  eventType: string;
  payloadJson: string;
}

/** Shape of a migration-026 `run_usage` row (SELECT * column names). */
interface RunUsageMaterializedRow {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  num_turns: number | null;
  assistant_message_count: number;
}

/** Max ids per IN-list chunk; keeps us well under SQLite's parameter ceiling. */
const RUN_ID_CHUNK_SIZE = 400;

/** A freshly-zeroed rollup for a run id with no usage data in either tier. */
function zeroRollup(runId: string): RunUsageRollup {
  return {
    runId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: null,
    numTurns: null,
    assistantMessageCount: 0,
    // Runtime timestamps are folded in by selectRunUsageRollups from a single
    // workflow_runs read; the token-only aggregation paths leave them null.
    startedAt: null,
    endedAt: null,
  };
}

/**
 * Map a materialized `run_usage` row to a `RunUsageRollup`. The persisted
 * columns are the precomputed projection of the same assistant/result scan the
 * fallback performs, so the mapping is one-to-one (cost_usd / num_turns stay
 * null when the run never reported them). `totalTokens` is re-derived from
 * input + output rather than trusting the stored `total_tokens` so a corrupt
 * materialized total can never desync from the contract's definition.
 */
function rollupFromMaterializedRow(row: RunUsageMaterializedRow): RunUsageRollup {
  const inputTokens = asNumber(row.input_tokens);
  const outputTokens = asNumber(row.output_tokens);
  return {
    runId: row.run_id,
    inputTokens,
    outputTokens,
    cacheReadTokens: asNumber(row.cache_read_tokens),
    cacheCreationTokens: asNumber(row.cache_creation_tokens),
    totalTokens: inputTokens + outputTokens,
    costUsd: typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) ? row.cost_usd : null,
    numTurns: typeof row.num_turns === 'number' && Number.isFinite(row.num_turns) ? row.num_turns : null,
    assistantMessageCount: asNumber(row.assistant_message_count),
    // run_usage carries no timestamps; selectRunUsageRollups stamps them.
    startedAt: null,
    endedAt: null,
  };
}

/**
 * Bulk-fetch the materialized `run_usage` rows for `runIds`, returned as a
 * runId→rollup map. The id list is chunked so the `IN (...)` clause stays under
 * SQLite's bound-parameter ceiling. Runs without a row are simply absent from
 * the map (the caller falls back to the raw_events scan for those).
 */
function fetchMaterializedRollups(
  db: DatabaseLike,
  runIds: readonly string[],
): Map<string, RunUsageRollup> {
  const out = new Map<string, RunUsageRollup>();
  if (runIds.length === 0) return out;
  for (const ids of chunk(runIds, RUN_ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT run_id, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, total_tokens, cost_usd, num_turns,
                assistant_message_count
         FROM run_usage
         WHERE run_id IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as RunUsageMaterializedRow[];
    for (const row of rows) {
      out.set(row.run_id, rollupFromMaterializedRow(row));
    }
  }
  return out;
}

/**
 * Live raw_events scan for the runs WITHOUT a materialized row — the original
 * Phase-1 aggregation, now scoped to the fallback cohort. Seeds a zeroed rollup
 * for every requested id, then folds in `assistant` + `result` payloads in
 * (run_id, id) order so cost/turn SUMs are deterministic.
 *
 * Parsing rules (all guarded against malformed JSON, which is skipped silently):
 *   - assistant → message.usage.{input,output,cache_read,cache_creation}_tokens
 *     (each optional). `assistantMessageCount` increments ONLY when a `usage`
 *     object is present.
 *   - result → total_cost_usd (SUMmed; null when never present) and num_turns
 *     (SUMmed; null when never present).
 * `result.usage` tokens are intentionally NOT added (they restate turn totals).
 */
function scanRawEventRollups(
  db: DatabaseLike,
  runIds: readonly string[],
): Map<string, RunUsageRollup> {
  const acc = new Map<string, RunUsageRollup>();
  for (const id of runIds) acc.set(id, zeroRollup(id));
  if (runIds.length === 0) return acc;

  for (const ids of chunk(runIds, RUN_ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT run_id AS runId, event_type AS eventType, payload_json AS payloadJson
         FROM raw_events
         WHERE run_id IN (${placeholders(ids.length)})
           AND event_type IN ('assistant', 'result')
         ORDER BY run_id, id`,
      )
      .all(...ids) as RawEventUsageRow[];

    for (const row of rows) {
      const target = acc.get(row.runId);
      if (target === undefined) continue; // defensive — should always exist

      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch {
        continue; // malformed JSON — skip silently
      }
      if (!isRecord(payload)) continue;

      if (row.eventType === 'assistant') {
        const message = payload.message;
        if (!isRecord(message)) continue;
        const usage = message.usage;
        if (!isRecord(usage)) continue; // no usage object → not counted

        target.inputTokens += asNumber(usage.input_tokens);
        target.outputTokens += asNumber(usage.output_tokens);
        target.cacheReadTokens += asNumber(usage.cache_read_input_tokens);
        target.cacheCreationTokens += asNumber(usage.cache_creation_input_tokens);
        target.assistantMessageCount += 1;
      } else {
        // result: SUM total_cost_usd + num_turns when present (null stays null
        // until the first numeric value lands — distinguishes "never reported").
        if (typeof payload.total_cost_usd === 'number' && Number.isFinite(payload.total_cost_usd)) {
          target.costUsd = (target.costUsd ?? 0) + payload.total_cost_usd;
        }
        if (typeof payload.num_turns === 'number' && Number.isFinite(payload.num_turns)) {
          target.numTurns = (target.numTurns ?? 0) + payload.num_turns;
        }
      }
    }
  }

  for (const rollup of acc.values()) {
    rollup.totalTokens = rollup.inputTokens + rollup.outputTokens;
  }
  return acc;
}

/** Raw `workflow_runs` runtime-timestamp row (SELECT alias names). */
interface RunTimestampRow {
  runId: string;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Bulk-fetch `started_at` / `ended_at` for `runIds`, returned as a runId→{ISO,
 * ISO} map. One indexed IN() lookup per chunk over `workflow_runs`; runs with no
 * row are simply absent (the caller leaves their rollup timestamps null). Both
 * columns are normalized to ISO-8601 via `toIso`.
 */
function fetchRunTimestamps(
  db: DatabaseLike,
  runIds: readonly string[],
): Map<string, { startedAt: string | null; endedAt: string | null }> {
  const out = new Map<string, { startedAt: string | null; endedAt: string | null }>();
  if (runIds.length === 0) return out;
  for (const ids of chunk(runIds, RUN_ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT id AS runId, started_at AS startedAt, ended_at AS endedAt
         FROM workflow_runs
         WHERE id IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as RunTimestampRow[];
    for (const row of rows) {
      out.set(row.runId, { startedAt: toIso(row.startedAt), endedAt: toIso(row.endedAt) });
    }
  }
  return out;
}

/**
 * Token/cost rollup per run, via a TWO-TIER read (migration 026):
 *   1. Bulk-fetch the materialized `run_usage` rows for all requested ids.
 *      Any run WITH a row maps directly — no raw_events touched.
 *   2. The remaining ids (no materialized row — historic runs, runs still in
 *      flight) fall back to the live `assistant` + `result` raw_events scan.
 * Ids found in NEITHER tier still get a zeroed rollup, so callers can index by
 * runId without undefined checks.
 *
 * `result.usage` tokens are never added (they restate turn totals); `totalTokens`
 * = inputTokens + outputTokens in both tiers.
 *
 * @param db     - Narrow DatabaseLike surface.
 * @param runIds - Run ids to roll up (order of the result mirrors this list).
 */
export function selectRunUsageRollups(
  db: DatabaseLike,
  runIds: string[],
): RunUsageRollup[] {
  if (runIds.length === 0) return [];

  // Tier 1: materialized rows win outright.
  const materialized = fetchMaterializedRollups(db, runIds);

  // Tier 2: scan raw_events only for ids that lack a materialized row.
  const fallbackIds = runIds.filter((id) => !materialized.has(id));
  const scanned =
    fallbackIds.length === 0
      ? new Map<string, RunUsageRollup>()
      : scanRawEventRollups(db, fallbackIds);

  // Fold in runtime timestamps from a single workflow_runs read (the token tiers
  // carry none). Stamped last so both the materialized and scanned paths get them.
  const timestamps = fetchRunTimestamps(db, runIds);

  // Emit in the caller's requested order; zeroRollup covers ids in neither tier.
  return runIds.map((id) => {
    const rollup = materialized.get(id) ?? scanned.get(id) ?? zeroRollup(id);
    const ts = timestamps.get(id);
    if (ts !== undefined) {
      rollup.startedAt = ts.startedAt;
      rollup.endedAt = ts.endedAt;
    }
    return rollup;
  });
}

/** Per-category token totals across every workflow run hosted by a session. */
export interface SessionRunTokenTotals {
  runInputTokens: number;
  runOutputTokens: number;
  runCacheReadTokens: number;
  runCacheCreationTokens: number;
}

/**
 * Sum token usage across every workflow run hosted by a session (joined via
 * `workflow_runs.session_id`). This is the run-pipeline counterpart to
 * `DatabaseService.getSessionTokenUsage`, which only sees the quick-chat
 * `session_outputs`: the two sources are DISJOINT (session_outputs = SDK chat,
 * run_usage/raw_events = orchestrator agents), so callers SUM them for a
 * whole-session figure with no double-counting. Uses the two-tier
 * `selectRunUsageRollups` so a still-running session-hosted run (no materialized
 * row yet) is counted live from raw_events. Returns zeros for a session with no
 * hosted runs (the empty-id short-circuit makes that allocation-free).
 *
 * SDK quick-sentinel exclusion (permission-mode redesign slice 1b, §7d): once the
 * SDK `__quick__` sentinel gets its `session_id` stamped (so the run→session join
 * resolves for chat gating), this run scan would otherwise DOUBLE-COUNT every SDK
 * chat turn — `getSessionTokenUsage` already counts it via `session_outputs`. We
 * exclude the SDK sentinel via the workflows JOIN. INTERACTIVE sentinels write no
 * `session_outputs`, so they MUST stay counted via this run scan — hence the
 * substrate discriminator (only `__quick__` AND `sdk` is excluded).
 */
export function selectSessionRunTokenTotals(
  db: DatabaseLike,
  sessionId: string,
): SessionRunTokenTotals {
  const runRows = db
    .prepare(
      `SELECT r.id FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
       WHERE r.session_id = ?
         AND NOT (w.name = '__quick__' AND r.substrate = 'sdk')`,
    )
    .all(sessionId) as Array<{ id: string }>;
  const rollups = selectRunUsageRollups(
    db,
    runRows.map((r) => r.id),
  );
  return rollups.reduce<SessionRunTokenTotals>(
    (acc, r) => ({
      runInputTokens: acc.runInputTokens + r.inputTokens,
      runOutputTokens: acc.runOutputTokens + r.outputTokens,
      runCacheReadTokens: acc.runCacheReadTokens + r.cacheReadTokens,
      runCacheCreationTokens: acc.runCacheCreationTokens + r.cacheCreationTokens,
    }),
    { runInputTokens: 0, runOutputTokens: 0, runCacheReadTokens: 0, runCacheCreationTokens: 0 },
  );
}

/**
 * Raw-events-ONLY rollup — the force-scan sibling of `selectRunUsageRollups`
 * that DELIBERATELY ignores the materialized `run_usage` tier and computes every
 * id straight from the live `assistant` + `result` raw_events scan (with the same
 * zero-seeding and caller-order array semantics).
 *
 * WHY THIS EXISTS — the materializer must never read back its own row
 * --------------------------------------------------------------------
 * `run_usage` is WRITTEN by `rollupRunUsage` (runUsageRollup.ts), which derives
 * the row to upsert from this module. If the writer used the two-tier
 * `selectRunUsageRollups`, tier 1 would return the EXISTING `run_usage` row on
 * every re-materialization (the interactive substrate re-fires 'drained' per
 * turn; resumed runs re-drain) and the scan of the now-larger raw_events log
 * would be skipped — so the row would be REPLACEd with its own frozen values and
 * all usage from later turns would be permanently dropped. The writer MUST take
 * this force-scan path so each re-materialization re-reads the full raw_events
 * log; the materialized-first read is correct only for the Insights READ paths,
 * which never write the row they read.
 *
 * @param db     - Narrow DatabaseLike surface.
 * @param runIds - Run ids to roll up (order of the result mirrors this list).
 */
export function selectRunUsageRollupsFromRawEvents(
  db: DatabaseLike,
  runIds: string[],
): RunUsageRollup[] {
  if (runIds.length === 0) return [];
  const scanned = scanRawEventRollups(db, runIds);
  // scanRawEventRollups already seeds a zeroed rollup per requested id, so the
  // `?? zeroRollup(id)` is purely defensive; emit in the caller's order.
  return runIds.map((id) => scanned.get(id) ?? zeroRollup(id));
}

// ---------------------------------------------------------------------------
// 3. selectWorkflowUsageStats
// ---------------------------------------------------------------------------

interface WorkflowWithRunIdsRow {
  workflowId: string;
  workflowName: string;
}

interface RunIdRow {
  runId: string;
}

/**
 * Per-workflow usage aggregate. For each workflow, take the most recent
 * `limitRunsPerWorkflow` run ids that have usage data — either a materialized
 * `run_usage` row (migration 026) OR at least one persisted raw_events row —
 * roll them up via `selectRunUsageRollups`, then aggregate:
 *   - runsWithUsage = rollups whose assistantMessageCount > 0.
 *   - avgTotalTokens = mean totalTokens over those runs (null when none).
 *   - totalTokens = raw SUM of totalTokens over those runs (null when none) —
 *     the unaveraged companion that backs the by-flow token bars.
 *   - totalCostUsd = sum of non-null costUsd (null when every rollup was null).
 *   - avgCostUsd = mean costUsd over runs with a non-null cost (null when none).
 *
 * Two-tier benefit: the recent-runs window qualifies a run on EITHER an
 * EXISTS(run_usage) or an EXISTS(raw_events) — so a run whose raw_events were
 * pruned but whose usage was materialized still counts. An early bulk-fetch of
 * the materialized rollups means the run_usage hit path never loads raw_events
 * (`selectRunUsageRollups` scans them only for the fallback ids). The LIMIT is
 * applied AFTER the OR, so the N-runs cap semantics are unchanged.
 *
 * @param db                   - Narrow DatabaseLike surface.
 * @param projectId            - When non-null, restricts to that project. Same
 *   migration-030 caveat as selectWorkflowRunStats: the per-project branch
 *   filters on the WORKFLOW's `project_id = ?`, so a GLOBAL flow (project_id
 *   NULL) is omitted from a per-project usage view (its runs still carry a real
 *   workflow_runs.project_id). All-projects (null) sees every flow. Deliberately
 *   unchanged scope for this pass.
 * @param limitRunsPerWorkflow - Recent-run window per workflow (default 200).
 */
export function selectWorkflowUsageStats(
  db: DatabaseLike,
  projectId: number | null,
  limitRunsPerWorkflow = 200,
): WorkflowUsageStats[] {
  const workflows = (
    projectId === null
      ? db
          .prepare(
            `SELECT id AS workflowId, name AS workflowName
             FROM workflows
             ORDER BY name ASC`,
          )
          .all()
      : db
          .prepare(
            `SELECT id AS workflowId, name AS workflowName
             FROM workflows
             WHERE project_id = ? OR project_id IS NULL
             ORDER BY name ASC`,
          )
          .all(projectId)
  ) as WorkflowWithRunIdsRow[];

  // Per workflow: last N run ids that carry usage — a materialized run_usage row
  // OR at least one raw_events row. The OR (not a switch) keeps historic runs
  // without a materialized row visible; the LIMIT after it preserves the N cap.
  // Scope a (now possibly global) flow's runs to the queried project via the run's
  // own project_id; `? IS NULL` disables the filter in the cross-project view.
  const recentRunsStmt = db.prepare(
    `SELECT r.id AS runId
     FROM workflow_runs r
     WHERE r.workflow_id = ?
       AND (? IS NULL OR r.project_id = ?)
       AND (
         EXISTS (SELECT 1 FROM run_usage u WHERE u.run_id = r.id)
         OR EXISTS (SELECT 1 FROM raw_events e WHERE e.run_id = r.id)
       )
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`,
  );

  const result: WorkflowUsageStats[] = [];
  for (const wf of workflows) {
    const runIdRows = recentRunsStmt.all(
      wf.workflowId,
      projectId,
      projectId,
      limitRunsPerWorkflow,
    ) as RunIdRow[];
    const runIds = runIdRows.map((row) => row.runId);
    // selectRunUsageRollups already does the materialized-first two-tier read,
    // so run_usage hits here never load raw_events.
    const rollups = selectRunUsageRollups(db, runIds);

    const usedRollups = rollups.filter((r) => r.assistantMessageCount > 0);
    const costRollups = rollups.filter((r) => r.costUsd !== null);

    const runsWithUsage = usedRollups.length;
    // Raw sum of totalTokens across the usage-bearing runs — the unaveraged
    // companion to avgTotalTokens that backs the by-flow token bars. Null when
    // no run carried usage (mirrors avgTotalTokens), NOT 0, so the bar chart can
    // distinguish "no data" from "a real zero".
    const totalTokens =
      runsWithUsage === 0
        ? null
        : usedRollups.reduce((sum, r) => sum + r.totalTokens, 0);
    // Companion cache total (read + creation). totalTokens above excludes cache,
    // but costUsd below includes it — surfacing this keeps the card's tokens and
    // cost on the same footing (cache re-reads are usually the dominant volume).
    const totalCacheTokens =
      runsWithUsage === 0
        ? null
        : usedRollups.reduce(
            (sum, r) => sum + r.cacheReadTokens + r.cacheCreationTokens,
            0,
          );
    const avgTotalTokens =
      runsWithUsage === 0
        ? null
        : Math.round((totalTokens ?? 0) / runsWithUsage);
    const totalCostUsd =
      costRollups.length === 0
        ? null
        : costRollups.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const avgCostUsd =
      costRollups.length === 0
        ? null
        : (totalCostUsd ?? 0) / costRollups.length;

    result.push({
      workflowId: wf.workflowId,
      workflowName: wf.workflowName,
      runsWithUsage,
      avgTotalTokens,
      totalTokens,
      totalCacheTokens,
      totalCostUsd,
      avgCostUsd,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. selectReviewItemSummary
// ---------------------------------------------------------------------------

interface StatusCountRow {
  status: string;
  count: number;
}

interface KindCountRow {
  kind: string;
  count: number;
}

/**
 * Review-queue counters for the inbox header. Two grouped reads:
 *   - GROUP BY status → total / pending / resolved / dismissed.
 *   - GROUP BY kind WHERE status='pending' → pendingByKind (all four kinds
 *     present, defaulting to 0).
 *
 * @param db        - Narrow DatabaseLike surface.
 * @param projectId - When non-null, restricts to that project.
 */
export function selectReviewItemSummary(
  db: DatabaseLike,
  projectId: number | null,
): ReviewItemSummary {
  const statusRows = (
    projectId === null
      ? db
          .prepare(
            `SELECT status, COUNT(*) AS count FROM review_items GROUP BY status`,
          )
          .all()
      : db
          .prepare(
            `SELECT status, COUNT(*) AS count
             FROM review_items WHERE project_id = ? GROUP BY status`,
          )
          .all(projectId)
  ) as StatusCountRow[];

  const summary: ReviewItemSummary = {
    total: 0,
    pending: 0,
    resolved: 0,
    dismissed: 0,
    pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0, notification: 0 },
  };

  for (const row of statusRows) {
    summary.total += row.count;
    if (row.status === 'pending') summary.pending = row.count;
    else if (row.status === 'resolved') summary.resolved = row.count;
    else if (row.status === 'dismissed') summary.dismissed = row.count;
  }

  const kindRows = (
    projectId === null
      ? db
          .prepare(
            `SELECT kind, COUNT(*) AS count
             FROM review_items WHERE status = 'pending' GROUP BY kind`,
          )
          .all()
      : db
          .prepare(
            `SELECT kind, COUNT(*) AS count
             FROM review_items WHERE status = 'pending' AND project_id = ? GROUP BY kind`,
          )
          .all(projectId)
  ) as KindCountRow[];

  for (const row of kindRows) {
    if (
      row.kind === 'finding' ||
      row.kind === 'permission' ||
      row.kind === 'decision' ||
      row.kind === 'human_task' ||
      row.kind === 'notification'
    ) {
      summary.pendingByKind[row.kind] = row.count;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// 5. selectQualityFindings
// ---------------------------------------------------------------------------

interface QualityFindingRow {
  id: string;
  projectId: number;
  title: string;
  severity: string | null;
  status: string;
  source: string | null;
  payloadJson: string | null;
  createdAt: string;
  resolution: string | null;
  runId: string | null;
  runOutcome: string | null;
  runEndedAt: string | null;
  workflowName: string | null;
}

/** Narrow an unknown to the QualityFinding.severity union (or null). */
function narrowSeverity(value: string | null): 'info' | 'warning' | 'error' | null {
  return value === 'info' || value === 'warning' || value === 'error' ? value : null;
}

/** Narrow an unknown to the QualityFinding.status union (defaults 'pending'). */
function narrowFindingStatus(value: string): 'pending' | 'resolved' | 'dismissed' {
  return value === 'resolved' || value === 'dismissed' ? value : 'pending';
}

/**
 * Parse FindingPayload.category (string | null) and locations (array of
 * {path, line?}) from a finding's payload_json, guarding every shape.
 */
function parseFindingPayload(payloadJson: string | null): {
  category: string | null;
  locations: Array<{ path: string; line?: number }>;
} {
  if (payloadJson === null) return { category: null, locations: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { category: null, locations: [] };
  }
  if (!isRecord(payload)) return { category: null, locations: [] };

  const category = typeof payload.category === 'string' ? payload.category : null;

  const locations: Array<{ path: string; line?: number }> = [];
  if (Array.isArray(payload.locations)) {
    for (const loc of payload.locations) {
      if (!isRecord(loc)) continue;
      if (typeof loc.path !== 'string') continue;
      const entry: { path: string; line?: number } = { path: loc.path };
      if (typeof loc.line === 'number' && Number.isFinite(loc.line)) {
        entry.line = loc.line;
      }
      locations.push(entry);
    }
  }

  return { category, locations };
}

/**
 * The `kind='finding'` review items for the code-quality section, flattened
 * with their creating run + workflow via LEFT JOINs (so a deleted/SET-NULL run
 * still surfaces the finding with null run fields). Ordered newest-first.
 *
 * @param db        - Narrow DatabaseLike surface.
 * @param projectId - When non-null, restricts to that project (ri.project_id).
 * @param limit     - Max rows (default 100).
 */
export function selectQualityFindings(
  db: DatabaseLike,
  projectId: number | null,
  limit = 100,
): QualityFinding[] {
  const sql = `
    SELECT
      ri.id           AS id,
      ri.project_id   AS projectId,
      ri.title        AS title,
      ri.severity     AS severity,
      ri.status       AS status,
      ri.source       AS source,
      ri.payload_json AS payloadJson,
      ri.created_at   AS createdAt,
      ri.resolution   AS resolution,
      ri.run_id       AS runId,
      r.outcome       AS runOutcome,
      r.ended_at      AS runEndedAt,
      w.name          AS workflowName
    FROM review_items ri
    LEFT JOIN workflow_runs r ON r.id = ri.run_id
    LEFT JOIN workflows w     ON w.id = r.workflow_id
    WHERE ri.kind = 'finding'
      ${projectId === null ? '' : 'AND ri.project_id = ?'}
    ORDER BY ri.created_at DESC
    LIMIT ?
  `;

  const stmt = db.prepare(sql);
  const rows = (
    projectId === null ? stmt.all(limit) : stmt.all(projectId, limit)
  ) as QualityFindingRow[];

  return rows.map((row) => {
    const { category, locations } = parseFindingPayload(row.payloadJson);
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      severity: narrowSeverity(row.severity),
      status: narrowFindingStatus(row.status),
      source: row.source,
      sourceStep: parseSourceStep(row.source),
      category,
      locations,
      createdAt: toIso(row.createdAt) ?? row.createdAt,
      resolution: row.resolution,
      runId: row.runId,
      runOutcome: row.runOutcome,
      runEndedAt: toIso(row.runEndedAt),
      workflowName: row.workflowName,
    };
  });
}

/**
 * `kind='finding'` review items for ONE run (A/B testing slice C — the per-arm
 * findings list on the experiment comparison payload). Same row shape + mapping as
 * {@link selectQualityFindings}, scoped to a single run_id, newest-first.
 */
export function selectRunFindings(db: DatabaseLike, runId: string): QualityFinding[] {
  const rows = db
    .prepare(
      `SELECT
         ri.id           AS id,
         ri.project_id   AS projectId,
         ri.title        AS title,
         ri.severity     AS severity,
         ri.status       AS status,
         ri.source       AS source,
         ri.payload_json AS payloadJson,
         ri.created_at   AS createdAt,
         ri.resolution   AS resolution,
         ri.run_id       AS runId,
         r.outcome       AS runOutcome,
         r.ended_at      AS runEndedAt,
         w.name          AS workflowName
       FROM review_items ri
       LEFT JOIN workflow_runs r ON r.id = ri.run_id
       LEFT JOIN workflows w     ON w.id = r.workflow_id
       WHERE ri.kind = 'finding' AND ri.run_id = ?
       ORDER BY ri.created_at DESC`,
    )
    .all(runId) as QualityFindingRow[];

  return rows.map((row) => {
    const { category, locations } = parseFindingPayload(row.payloadJson);
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      severity: narrowSeverity(row.severity),
      status: narrowFindingStatus(row.status),
      source: row.source,
      sourceStep: parseSourceStep(row.source),
      category,
      locations,
      createdAt: toIso(row.createdAt) ?? row.createdAt,
      resolution: row.resolution,
      runId: row.runId,
      runOutcome: row.runOutcome,
      runEndedAt: toIso(row.runEndedAt),
      workflowName: row.workflowName,
    };
  });
}

// ---------------------------------------------------------------------------
// 6. selectStepTokenBuckets
// ---------------------------------------------------------------------------

interface StepEventRow {
  runId: string;
  /** raw_events.id — the row-id ordering key both attribution paths interleave on. */
  rowId: number;
  eventType: string;
  payloadJson: string;
}

/** The MCP report-step tool name suffix. MCP prefixing yields names like
 *  'mcp__cyboflow__cyboflow_report_step', so we suffix-match. */
const REPORT_STEP_TOOL_SUFFIX = 'cyboflow_report_step';

/** Step id used before the first step transition lands in a run. */
const UNATTRIBUTED_STEP = 'unattributed';

/**
 * One element of a run's id-ordered attribution stream consumed by
 * `attributeStepStream`. A `usage` item attributes `tokens` to the current
 * step; a `transition` item switches the current step to `stepId`.
 */
type StepStreamItem =
  | { kind: 'usage'; tokens: number }
  | { kind: 'transition'; stepId: string };

/** Per-step accumulator (mutated in place by `attributeStepStream`). */
type StepBuckets = Map<string, { totalTokens: number; assistantMessageCount: number }>;

/**
 * Extract input.step_id (string) from a tool_use block whose name ends with
 * `cyboflow_report_step`, scanning the assistant message's content array.
 * Returns null when no such block / step_id is present.
 */
function extractReportedStepId(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'tool_use') continue;
    if (typeof block.name !== 'string') continue;
    if (!block.name.endsWith(REPORT_STEP_TOOL_SUFFIX)) continue;
    const input = block.input;
    if (!isRecord(input)) continue;
    if (typeof input.step_id === 'string' && input.step_id.length > 0) {
      return input.step_id;
    }
  }
  return null;
}

/**
 * Parse the step_id out of a persisted `step_transition` raw_events payload
 * ({ kind:'step_transition', step_id, status, timestamp }). Returns null when
 * the payload is malformed or carries no usable step_id — every transition row
 * (status 'running' OR 'done') is treated uniformly: the attribution rule is
 * "the most recent transition row with a smaller id", so a 'done' row simply
 * keeps the just-finished step current until the next 'running' arrives.
 */
function parseStepTransitionStepId(payloadJson: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null; // malformed — skip
  }
  if (!isRecord(payload)) return null;
  if (typeof payload.step_id === 'string' && payload.step_id.length > 0) {
    return payload.step_id;
  }
  return null;
}

/**
 * SHARED attribution loop reused by both paths. Walks an already-id-ordered
 * stream of stream items for ONE run, starting at 'unattributed', attributing
 * each `usage` item to the current step and switching on each `transition`.
 * Mutates `buckets` in place.
 */
function attributeStepStream(items: readonly StepStreamItem[], buckets: StepBuckets): void {
  let currentStep = UNATTRIBUTED_STEP;
  for (const item of items) {
    if (item.kind === 'transition') {
      currentStep = item.stepId;
      continue;
    }
    const existing = buckets.get(currentStep) ?? { totalTokens: 0, assistantMessageCount: 0 };
    existing.totalTokens += item.tokens;
    existing.assistantMessageCount += 1;
    buckets.set(currentStep, existing);
  }
}

/** Pull the input+output token count off an assistant payload, or null when it carries no usage object. */
function assistantUsageTokens(payloadJson: string): number | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null; // malformed — skip
  }
  if (!isRecord(payload)) return null;
  const message = payload.message;
  if (!isRecord(message)) return null;
  const usage = message.usage;
  if (!isRecord(usage)) return null; // no usage object → not attributed
  return asNumber(usage.input_tokens) + asNumber(usage.output_tokens);
}

/**
 * Build the id-ordered stream for ONE run from the persisted `step_transition`
 * rows interleaved with its `assistant` rows. Because each transition is its
 * own row, ordering by row id alone places every assistant after the most
 * recent transition with a smaller id — so an assistant row attributes to that
 * transition's step (the contract). tool_use-embedded transitions are IGNORED
 * here: the persisted rows are authoritative.
 */
function buildTransitionStream(rows: readonly StepEventRow[]): StepStreamItem[] {
  const items: StepStreamItem[] = [];
  for (const row of rows) {
    if (row.eventType === 'step_transition') {
      const stepId = parseStepTransitionStepId(row.payloadJson);
      if (stepId !== null) items.push({ kind: 'transition', stepId });
    } else {
      const tokens = assistantUsageTokens(row.payloadJson);
      if (tokens !== null) items.push({ kind: 'usage', tokens });
    }
  }
  return items;
}

/**
 * Build the id-ordered stream for ONE run with NO persisted transition rows —
 * the original tool_use-scan fallback. Each assistant row emits its `usage`
 * item FIRST (attributed to the step that was current BEFORE the switch), THEN,
 * when the message content carries a `cyboflow_report_step` tool_use, a
 * `transition` item — so the reporting message is itself counted under the
 * PREVIOUS step (load-bearing Phase-1 behavior).
 */
function buildToolUseFallbackStream(rows: readonly StepEventRow[]): StepStreamItem[] {
  const items: StepStreamItem[] = [];
  for (const row of rows) {
    if (row.eventType !== 'assistant') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      continue; // malformed — skip
    }
    if (!isRecord(payload)) continue;
    const message = payload.message;
    if (!isRecord(message)) continue;

    const usage = isRecord(message.usage) ? message.usage : null;
    if (usage !== null) {
      items.push({
        kind: 'usage',
        tokens: asNumber(usage.input_tokens) + asNumber(usage.output_tokens),
      });
    }
    const reported = extractReportedStepId(message);
    if (reported !== null) items.push({ kind: 'transition', stepId: reported });
  }
  return items;
}

/**
 * Tokens attributed to each workflow step across the workflow's most recent
 * `lastNRuns` runs. Within each run we walk its events in (run_id, id) order,
 * tracking a "current step" that starts at 'unattributed'.
 *
 * Two-tier attribution (migration 026), decided PER RUN:
 *   - Runs WITH persisted `step_transition` raw_events build their step timeline
 *     from those rows. An assistant row belongs to the most recent transition
 *     row with a smaller id (row-id interleaving) — usage before the first
 *     transition lands in 'unattributed'.
 *   - Runs WITHOUT any transition row keep the tool_use-scan fallback: the step
 *     comes from `cyboflow_report_step` tool_use blocks, and the reporting
 *     message's own usage counts under the PREVIOUS step.
 * Both paths emit a per-run id-ordered StepStreamItem[] and fold it through the
 * single shared `attributeStepStream` loop, so the attribution semantics cannot
 * drift between them.
 *
 * Buckets are aggregated across all the runs and returned sorted by
 * totalTokens desc.
 *
 * @param db         - Narrow DatabaseLike surface.
 * @param workflowId - The workflow whose recent runs are scanned.
 * @param lastNRuns  - Recent-run window (default 20).
 */
export function selectStepTokenBuckets(
  db: DatabaseLike,
  workflowId: string,
  lastNRuns = 20,
): StepTokenBucket[] {
  const runIdRows = db
    .prepare(
      `SELECT id AS runId
       FROM workflow_runs
       WHERE workflow_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(workflowId, lastNRuns) as RunIdRow[];
  const runIds = runIdRows.map((row) => row.runId);
  if (runIds.length === 0) return [];

  // Accumulate per step across runs.
  const buckets: StepBuckets = new Map();

  for (const ids of chunk(runIds, RUN_ID_CHUNK_SIZE)) {
    // Fetch assistant AND step_transition rows together, id-ordered per run, so
    // each run's timeline can interleave the two without a second query.
    const rows = db
      .prepare(
        `SELECT run_id AS runId, id AS rowId, event_type AS eventType, payload_json AS payloadJson
         FROM raw_events
         WHERE run_id IN (${placeholders(ids.length)})
           AND event_type IN ('assistant', 'step_transition')
         ORDER BY run_id, id`,
      )
      .all(...ids) as StepEventRow[];

    // Partition the id-ordered rows into per-run runs (rows are grouped by
    // run_id via ORDER BY), then dispatch each run to the right stream builder.
    let runRows: StepEventRow[] = [];
    let currentRunId: string | null = null;
    const flush = (): void => {
      if (runRows.length === 0) return;
      const hasTransition = runRows.some((r) => r.eventType === 'step_transition');
      const items = hasTransition
        ? buildTransitionStream(runRows)
        : buildToolUseFallbackStream(runRows);
      attributeStepStream(items, buckets);
      runRows = [];
    };

    for (const row of rows) {
      if (row.runId !== currentRunId) {
        flush();
        currentRunId = row.runId;
      }
      runRows.push(row);
    }
    flush();
  }

  return Array.from(buckets.entries())
    .map(([stepId, agg]) => ({
      stepId,
      totalTokens: agg.totalTokens,
      assistantMessageCount: agg.assistantMessageCount,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// ---------------------------------------------------------------------------
// 7. selectUsageTrend
// ---------------------------------------------------------------------------

interface TrendRunRow {
  runId: string;
  /** date(created_at) → 'YYYY-MM-DD'. */
  dateBucket: string;
}

/**
 * Token-usage trend over the last `days` days, bucketed by local date.
 *
 * Selects the runs created within the window (created_at >=
 * datetime('now','-N days')), optionally scoped by workflowId and/or projectId,
 * rolls each up via `selectRunUsageRollups`, and sums totalTokens + run count
 * into per-date buckets ('YYYY-MM-DD'). `days` is clamped to 1..90. Result is
 * ascending by date.
 *
 * @param db   - Narrow DatabaseLike surface.
 * @param opts - { workflowId, projectId, days? } filters (each nullable / optional).
 */
export function selectUsageTrend(
  db: DatabaseLike,
  opts: { workflowId: string | null; projectId: number | null; days?: number },
): UsageTrendPoint[] {
  const days = Math.min(90, Math.max(1, opts.days ?? 30));

  // Build the WHERE clause incrementally; '-' || ? || ' days' keeps `days`
  // bound as a parameter rather than string-concatenated into the SQL.
  const conditions: string[] = [
    `r.created_at >= datetime('now', '-' || ? || ' days')`,
  ];
  const params: unknown[] = [days];
  if (opts.workflowId !== null) {
    conditions.push('r.workflow_id = ?');
    params.push(opts.workflowId);
  }
  if (opts.projectId !== null) {
    conditions.push('r.project_id = ?');
    params.push(opts.projectId);
  }

  const rows = db
    .prepare(
      `SELECT r.id AS runId, date(r.created_at) AS dateBucket
       FROM workflow_runs r
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(...params) as TrendRunRow[];

  if (rows.length === 0) return [];

  // Map each run to its bucket date, then roll up tokens once for all runs.
  const dateByRunId = new Map<string, string>();
  for (const row of rows) {
    dateByRunId.set(row.runId, row.dateBucket);
  }
  const rollups = selectRunUsageRollups(db, Array.from(dateByRunId.keys()));

  const byDate = new Map<string, { totalTokens: number; runs: number }>();
  for (const rollup of rollups) {
    const date = dateByRunId.get(rollup.runId);
    if (date === undefined) continue;
    const bucket = byDate.get(date) ?? { totalTokens: 0, runs: 0 };
    bucket.totalTokens += rollup.totalTokens;
    bucket.runs += 1;
    byDate.set(date, bucket);
  }

  return Array.from(byDate.entries())
    .map(([date, agg]) => ({ date, totalTokens: agg.totalTokens, runs: agg.runs }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 8. selectWorkflowRevisionStats
// ---------------------------------------------------------------------------

interface WorkflowRevisionStatsRow {
  specHash: string;
  firstSeenAt: string;
  runs: number;
  mergedRuns: number;
  failedRuns: number;
  /** Terminal runs that carry an outcome (merged|dismissed) — the success denominator. */
  outcomeRuns: number;
  /** AVG(run_usage.total_tokens) over this revision's materialized rows; SQLite returns null when none. */
  avgTotalTokens: number | null;
}

/**
 * Per-revision run statistics for one workflow's version history (mockup S6).
 *
 * For every recorded `workflow_revisions` snapshot of `workflowId`, LEFT JOIN the
 * `workflow_runs` that froze the SAME `spec_hash` (so a brand-new revision with no
 * runs yet still surfaces with zeroed counts), then LEFT JOIN `run_usage` to average
 * each revision's materialized `total_tokens`. Newest revision first (created_at DESC).
 *
 *   - runs            = COUNT of runs whose spec_hash matches the revision.
 *   - mergedRuns      = outcome='merged'.
 *   - failedRuns      = status='failed'.
 *   - successRatePct  = merged / (terminal runs with an outcome) * 100, 1dp in TS
 *                       (0 when no outcome-bearing run — avoids /0). "Terminal with
 *                       outcome" = outcome IS NOT NULL (merged|dismissed), matching
 *                       the shared type's denominator note.
 *   - avgTotalTokens  = mean of the matched runs' materialized run_usage.total_tokens
 *                       (null when none materialized — historic/in-flight runs).
 *   - isCurrent       = the revision's hash equals computeSpecHash(workflows.spec_json)
 *                       (the live spec a new run would freeze). At most one per workflow.
 *
 * INVISIBLE BY DESIGN: runs with `spec_hash IS NULL` (every pre-migration-026 run)
 * match no recorded revision and never appear here — they still count in the
 * workflow-wide selectWorkflowRunStats aggregate.
 *
 * `avgTotalTokens` deliberately reads ONLY the materialized `run_usage` tier (no
 * raw_events fallback): version-history is a coarse trend, and a revision's runs
 * are typically already finalized + materialized by the time it has history worth
 * showing. A run without a materialized row simply does not contribute to the mean.
 *
 * @param db         - Narrow DatabaseLike surface.
 * @param workflowId - The workflow whose revision history is read.
 */
export function selectWorkflowRevisionStats(
  db: DatabaseLike,
  workflowId: string,
): WorkflowRevisionStats[] {
  const rows = db
    .prepare(
      `SELECT
         rev.spec_hash  AS specHash,
         rev.created_at AS firstSeenAt,
         COUNT(r.id) AS runs,
         SUM(CASE WHEN r.outcome = 'merged' THEN 1 ELSE 0 END) AS mergedRuns,
         SUM(CASE WHEN r.status = 'failed'  THEN 1 ELSE 0 END) AS failedRuns,
         SUM(CASE WHEN r.outcome IS NOT NULL THEN 1 ELSE 0 END) AS outcomeRuns,
         AVG(u.total_tokens) AS avgTotalTokens
       FROM workflow_revisions rev
       LEFT JOIN workflow_runs r
         ON r.workflow_id = rev.workflow_id AND r.spec_hash = rev.spec_hash
       LEFT JOIN run_usage u ON u.run_id = r.id
       WHERE rev.workflow_id = ?
       GROUP BY rev.spec_hash, rev.created_at
       ORDER BY rev.created_at DESC, rev.id DESC`,
    )
    .all(workflowId) as WorkflowRevisionStatsRow[];

  // The live spec a new run would freeze — compare each revision's hash to flag the
  // current one. Missing workflow row (deleted) → null spec_json → computeSpecHash's
  // '{}' floor, which simply matches no revision (none was recorded for empty spec).
  const liveRow = db
    .prepare(`SELECT spec_json AS specJson FROM workflows WHERE id = ?`)
    .get(workflowId) as { specJson: string | null } | undefined;
  const currentHash = computeSpecHash(liveRow?.specJson ?? null);

  return rows.map((row): WorkflowRevisionStats => {
    const successRatePct =
      row.outcomeRuns === 0 ? 0 : round1((row.mergedRuns / row.outcomeRuns) * 100);
    return {
      workflowId,
      specHash: row.specHash,
      firstSeenAt: toIso(row.firstSeenAt) ?? row.firstSeenAt,
      isCurrent: row.specHash === currentHash,
      runs: row.runs,
      mergedRuns: row.mergedRuns,
      failedRuns: row.failedRuns,
      successRatePct,
      // SQLite AVG over zero matched run_usage rows returns null — keep it null.
      avgTotalTokens:
        row.avgTotalTokens === null ? null : Math.round(row.avgTotalTokens),
    };
  });
}

// ---------------------------------------------------------------------------
// 8b. selectVariantStats (A/B testing slice C — per-variant rotation aggregates)
// ---------------------------------------------------------------------------

interface VariantStatsBaseRow {
  variantId: string;
  variantLabel: string | null;
  variantStatus: string | null;
  weight: number | null;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  activeRuns: number;
  mergedRuns: number;
  dismissedRuns: number;
  nullOutcomeRuns: number;
  outcomeRuns: number;
  avgDurationMs: number | null;
  avgTotalTokens: number | null;
  avgCostUsd: number | null;
}

/** Narrow a raw workflow_variants.status string to the shared enum (NULL when deleted). */
function narrowVariantStatus(
  raw: string | null,
): 'draft' | 'active' | 'paused' | 'retired' | null {
  return raw === 'draft' || raw === 'active' || raw === 'paused' || raw === 'retired'
    ? raw
    : null;
}

/**
 * Per-variant rotation statistics for one workflow (A/B testing slice C), modeled
 * on {@link selectWorkflowRevisionStats} but grouped on `workflow_runs.variant_id`.
 *
 * Scope: `variant_id IS NOT NULL AND experiment_id IS NULL` — side-by-side
 * experiment ARM runs are EXCLUDED (a decided experiment always dismisses the
 * loser, which would systematically depress rotation success rates). Honors the
 * mig-030 project-scoping caveat (filter on the RUN's project_id when non-null).
 *
 * `LEFT JOIN workflow_variants` (never INNER) so a DELETED variant still reports
 * via the denormalized `workflow_runs.variant_label` (variantStatus NULL then).
 *
 * The per-run averages that could fan out (eval score, findings, post-merge bugs)
 * are computed in SEPARATE grouped passes and merged in TS, so multiple
 * run_evals/review_items rows per run can never inflate the base run counts.
 * `avgTotalTokens`/`avgCostUsd` join `run_usage` (1:1 with a run — no fan-out).
 *
 * `postMergeBugCount` uses slice B's bug predicate: a UNION of ideas/epics/tasks
 * whose `caused_by_run_id` points at a run of this variant (setting the link =
 * declaring the regression). `lowSample = runs < MIN_VARIANT_RUNS` (display-only —
 * no auto-promotion / auto-weight adjustment in v1).
 *
 * @param db         - Narrow DatabaseLike surface.
 * @param workflowId - The workflow whose variant runs are aggregated.
 * @param projectId  - When non-null, restricts to that project's runs; null = all.
 */
export function selectVariantStats(
  db: DatabaseLike,
  workflowId: string,
  projectId: number | null,
): VariantStats[] {
  const scope = projectId === null ? '' : 'AND r.project_id = ?';
  const bind = (...extra: unknown[]): unknown[] =>
    projectId === null ? [workflowId, ...extra] : [workflowId, projectId, ...extra];

  // Base pass: counts + duration + usage averages (usage is 1:1 with a run).
  const baseRows = db
    .prepare(
      `SELECT
         r.variant_id       AS variantId,
         MAX(r.variant_label) AS variantLabel,
         v.status           AS variantStatus,
         v.weight           AS weight,
         COUNT(r.id) AS runs,
         SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completedRuns,
         SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END) AS failedRuns,
         SUM(CASE WHEN r.status = 'canceled'  THEN 1 ELSE 0 END) AS canceledRuns,
         SUM(CASE WHEN r.status NOT IN (${TERMINAL_SQL}) THEN 1 ELSE 0 END) AS activeRuns,
         SUM(CASE WHEN r.outcome = 'merged'    THEN 1 ELSE 0 END) AS mergedRuns,
         SUM(CASE WHEN r.outcome = 'dismissed' THEN 1 ELSE 0 END) AS dismissedRuns,
         SUM(CASE WHEN r.status IN (${TERMINAL_SQL}) AND r.outcome IS NULL THEN 1 ELSE 0 END) AS nullOutcomeRuns,
         SUM(CASE WHEN r.outcome IS NOT NULL THEN 1 ELSE 0 END) AS outcomeRuns,
         AVG(CASE
               WHEN r.status IN (${TERMINAL_SQL})
                    AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL
               THEN (julianday(r.ended_at) - julianday(r.started_at)) * 86400000
             END) AS avgDurationMs,
         AVG(u.total_tokens) AS avgTotalTokens,
         AVG(u.cost_usd)     AS avgCostUsd
       FROM workflow_runs r
       LEFT JOIN workflow_variants v ON v.id = r.variant_id
       LEFT JOIN run_usage u ON u.run_id = r.id
       WHERE r.workflow_id = ?
         AND r.variant_id IS NOT NULL
         AND r.experiment_id IS NULL
         ${scope}
       GROUP BY r.variant_id
       ORDER BY runs DESC, variantId ASC`,
    )
    .all(...bind()) as VariantStatsBaseRow[];

  // Eval-score pass (own grouping so multiple complete evals per run never fan out the base counts).
  const evalRows = db
    .prepare(
      `SELECT r.variant_id AS variantId, AVG(e.overall_score) AS avgEvalScore
       FROM run_evals e
       JOIN workflow_runs r ON r.id = e.run_id
       WHERE r.workflow_id = ?
         AND r.variant_id IS NOT NULL
         AND r.experiment_id IS NULL
         AND e.eval_status = 'complete'
         ${scope}
       GROUP BY r.variant_id`,
    )
    .all(...bind()) as Array<{ variantId: string; avgEvalScore: number | null }>;
  const evalByVariant = new Map<string, number | null>(
    evalRows.map((row) => [row.variantId, row.avgEvalScore]),
  );

  // Findings pass (kind='finding' review items whose run belongs to the variant).
  const findingRows = db
    .prepare(
      `SELECT r.variant_id AS variantId, COUNT(*) AS findingsCount
       FROM review_items ri
       JOIN workflow_runs r ON r.id = ri.run_id
       WHERE r.workflow_id = ?
         AND r.variant_id IS NOT NULL
         AND r.experiment_id IS NULL
         AND ri.kind = 'finding'
         ${scope}
       GROUP BY r.variant_id`,
    )
    .all(...bind()) as Array<{ variantId: string; findingsCount: number }>;
  const findingsByVariant = new Map<string, number>(
    findingRows.map((row) => [row.variantId, row.findingsCount]),
  );

  // Post-merge-bug pass: UNION of ideas/epics/tasks whose caused_by_run_id points
  // at a run of this variant (slice B's bug predicate). Scoped on the CAUSING run's
  // project (br.project_id), matching the base pass's run-project scoping.
  const bugScope = projectId === null ? '' : 'AND br.project_id = ?';
  const bugBind: unknown[] =
    projectId === null
      ? [workflowId, workflowId, workflowId]
      : [workflowId, projectId, workflowId, projectId, workflowId, projectId];
  const bugRows = db
    .prepare(
      `SELECT variantId, COUNT(*) AS postMergeBugCount FROM (
         SELECT br.variant_id AS variantId
           FROM ideas b JOIN workflow_runs br ON br.id = b.caused_by_run_id
          WHERE b.caused_by_run_id IS NOT NULL AND br.workflow_id = ?
            AND br.variant_id IS NOT NULL AND br.experiment_id IS NULL ${bugScope}
         UNION ALL
         SELECT br.variant_id AS variantId
           FROM epics b JOIN workflow_runs br ON br.id = b.caused_by_run_id
          WHERE b.caused_by_run_id IS NOT NULL AND br.workflow_id = ?
            AND br.variant_id IS NOT NULL AND br.experiment_id IS NULL ${bugScope}
         UNION ALL
         SELECT br.variant_id AS variantId
           FROM tasks b JOIN workflow_runs br ON br.id = b.caused_by_run_id
          WHERE b.caused_by_run_id IS NOT NULL AND br.workflow_id = ?
            AND br.variant_id IS NOT NULL AND br.experiment_id IS NULL ${bugScope}
       )
       WHERE variantId IS NOT NULL
       GROUP BY variantId`,
    )
    .all(...bugBind) as Array<{ variantId: string; postMergeBugCount: number }>;
  const bugsByVariant = new Map<string, number>(
    bugRows.map((row) => [row.variantId, row.postMergeBugCount]),
  );

  return baseRows.map((row): VariantStats => {
    const successRatePct =
      row.outcomeRuns === 0 ? 0 : round1((row.mergedRuns / row.outcomeRuns) * 100);
    return {
      variantId: row.variantId,
      variantLabel: row.variantLabel ?? row.variantId,
      variantStatus: narrowVariantStatus(row.variantStatus),
      weight: row.weight,
      runs: row.runs,
      completedRuns: row.completedRuns,
      failedRuns: row.failedRuns,
      canceledRuns: row.canceledRuns,
      activeRuns: row.activeRuns,
      mergedRuns: row.mergedRuns,
      dismissedRuns: row.dismissedRuns,
      nullOutcomeRuns: row.nullOutcomeRuns,
      successRatePct,
      avgDurationMs: row.avgDurationMs === null ? null : Math.round(row.avgDurationMs),
      avgTotalTokens: row.avgTotalTokens === null ? null : Math.round(row.avgTotalTokens),
      avgCostUsd: row.avgCostUsd === null ? null : row.avgCostUsd,
      avgEvalScore: evalByVariant.get(row.variantId) ?? null,
      findingsCount: findingsByVariant.get(row.variantId) ?? 0,
      postMergeBugCount: bugsByVariant.get(row.variantId) ?? 0,
      lowSample: row.runs < MIN_VARIANT_RUNS,
    };
  });
}

// ---------------------------------------------------------------------------
// 8c. selectRotationArmStats / selectRotationExperimentRuns /
//     selectRotationDashboardRows (rotation-experiment tracking, phase 3 read
//     surface, migration 057)
// ---------------------------------------------------------------------------

interface RotationArmBaseRow {
  armVariantId: string;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  activeRuns: number;
  mergedRuns: number;
  dismissedRuns: number;
  nullOutcomeRuns: number;
  outcomeRuns: number;
  avgDurationMs: number | null;
  avgTotalTokens: number | null;
  avgCostUsd: number | null;
}

/** Human label fallback for an arm id with no snapshot row: "Baseline" for the sentinel, else the raw id. */
function fallbackArmLabel(armVariantId: string): string {
  return isBaselineArm(armVariantId) ? 'Baseline' : armVariantId;
}

/** Build one `RotationArmStats` row; `base` is undefined for a zero-run arm (all counts zeroed, lowSample true). */
function buildRotationArmStats(
  armVariantId: string,
  label: string,
  base: RotationArmBaseRow | undefined,
  avgEvalScore: number | null,
  findingsCount: number,
  postMergeBugCount: number,
): RotationArmStats {
  if (!base) {
    return {
      armVariantId,
      label,
      runs: 0,
      completedRuns: 0,
      failedRuns: 0,
      canceledRuns: 0,
      activeRuns: 0,
      mergedRuns: 0,
      dismissedRuns: 0,
      nullOutcomeRuns: 0,
      successRatePct: 0,
      avgDurationMs: null,
      avgTotalTokens: null,
      avgCostUsd: null,
      avgEvalScore: null,
      findingsCount: 0,
      postMergeBugCount: 0,
      lowSample: true,
    };
  }
  const successRatePct =
    base.outcomeRuns === 0 ? 0 : round1((base.mergedRuns / base.outcomeRuns) * 100);
  return {
    armVariantId,
    label,
    runs: base.runs,
    completedRuns: base.completedRuns,
    failedRuns: base.failedRuns,
    canceledRuns: base.canceledRuns,
    activeRuns: base.activeRuns,
    mergedRuns: base.mergedRuns,
    dismissedRuns: base.dismissedRuns,
    nullOutcomeRuns: base.nullOutcomeRuns,
    successRatePct,
    avgDurationMs: base.avgDurationMs === null ? null : Math.round(base.avgDurationMs),
    avgTotalTokens: base.avgTotalTokens === null ? null : Math.round(base.avgTotalTokens),
    avgCostUsd: base.avgCostUsd,
    avgEvalScore,
    findingsCount,
    postMergeBugCount,
    lowSample: base.runs < MIN_VARIANT_RUNS,
  };
}

/**
 * Per-arm aggregate stats for ONE rotation experiment — the fair
 * baseline-vs-variant comparison (phase 3 read surface, migration 057).
 * Modeled on {@link selectVariantStats}'s four-pass shape (base counts/duration/
 * usage, then SEPARATE grouped passes for eval score / findings / post-merge
 * bugs, merged in TS so a multi-row join can never fan out the base counts) with
 * two swaps:
 *
 *   - every pass scopes `WHERE r.rotation_experiment_id = ?` — NO project
 *     scoping. A rotation experiment is cross-project by design (it is
 *     per-WORKFLOW, and a workflow's rotation can span every project that
 *     launches it), unlike selectVariantStats's optional per-project filter.
 *   - the grouping key is `COALESCE(r.variant_id, '__baseline__')` — a
 *     baseline-arm rotation run carries `variant_id IS NULL`, so the sentinel
 *     folds those runs onto the baseline arm rather than dropping them.
 *
 * The `experiment_rotation_arms` snapshot (not the aggregate rows) is the
 * DRIVING set: every snapshot arm always yields a row, even with zero runs
 * (zeroed counts, null averages, `lowSample: true`) — both arms must always
 * render so the comparison never silently drops an arm with no traffic yet.
 * Label precedence is the snapshot's own `label` (always set); an aggregate row
 * whose key is not in the snapshot (should not happen — every attributed run's
 * arm was live at open) is appended defensively using the fallback label
 * ("Baseline" for the sentinel, else the raw id).
 *
 * @param db           - Narrow DatabaseLike surface.
 * @param experimentId - The rotation experiment whose arms are aggregated.
 */
export function selectRotationArmStats(db: DatabaseLike, experimentId: string): RotationArmStats[] {
  const baseRows = db
    .prepare(
      `SELECT
         COALESCE(r.variant_id, ?) AS armVariantId,
         COUNT(r.id) AS runs,
         SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completedRuns,
         SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END) AS failedRuns,
         SUM(CASE WHEN r.status = 'canceled'  THEN 1 ELSE 0 END) AS canceledRuns,
         SUM(CASE WHEN r.status NOT IN (${TERMINAL_SQL}) THEN 1 ELSE 0 END) AS activeRuns,
         SUM(CASE WHEN r.outcome = 'merged'    THEN 1 ELSE 0 END) AS mergedRuns,
         SUM(CASE WHEN r.outcome = 'dismissed' THEN 1 ELSE 0 END) AS dismissedRuns,
         SUM(CASE WHEN r.status IN (${TERMINAL_SQL}) AND r.outcome IS NULL THEN 1 ELSE 0 END) AS nullOutcomeRuns,
         SUM(CASE WHEN r.outcome IS NOT NULL THEN 1 ELSE 0 END) AS outcomeRuns,
         AVG(CASE
               WHEN r.status IN (${TERMINAL_SQL})
                    AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL
               THEN (julianday(r.ended_at) - julianday(r.started_at)) * 86400000
             END) AS avgDurationMs,
         AVG(u.total_tokens) AS avgTotalTokens,
         AVG(u.cost_usd)     AS avgCostUsd
       FROM workflow_runs r
       LEFT JOIN run_usage u ON u.run_id = r.id
       WHERE r.rotation_experiment_id = ?
       GROUP BY armVariantId`,
    )
    .all(BASELINE_VARIANT_SENTINEL, experimentId) as RotationArmBaseRow[];
  const baseByArm = new Map(baseRows.map((row) => [row.armVariantId, row]));

  const evalRows = db
    .prepare(
      `SELECT COALESCE(r.variant_id, ?) AS armVariantId, AVG(e.overall_score) AS avgEvalScore
       FROM run_evals e
       JOIN workflow_runs r ON r.id = e.run_id
       WHERE r.rotation_experiment_id = ?
         AND e.eval_status = 'complete'
       GROUP BY armVariantId`,
    )
    .all(BASELINE_VARIANT_SENTINEL, experimentId) as Array<{
    armVariantId: string;
    avgEvalScore: number | null;
  }>;
  const evalByArm = new Map(evalRows.map((row) => [row.armVariantId, row.avgEvalScore]));

  const findingRows = db
    .prepare(
      `SELECT COALESCE(r.variant_id, ?) AS armVariantId, COUNT(*) AS findingsCount
       FROM review_items ri
       JOIN workflow_runs r ON r.id = ri.run_id
       WHERE r.rotation_experiment_id = ?
         AND ri.kind = 'finding'
       GROUP BY armVariantId`,
    )
    .all(BASELINE_VARIANT_SENTINEL, experimentId) as Array<{ armVariantId: string; findingsCount: number }>;
  const findingsByArm = new Map(findingRows.map((row) => [row.armVariantId, row.findingsCount]));

  const bugRows = db
    .prepare(
      `SELECT armVariantId, COUNT(*) AS postMergeBugCount FROM (
         SELECT COALESCE(br.variant_id, ?) AS armVariantId
           FROM ideas b JOIN workflow_runs br ON br.id = b.caused_by_run_id
          WHERE b.caused_by_run_id IS NOT NULL AND br.rotation_experiment_id = ?
         UNION ALL
         SELECT COALESCE(br.variant_id, ?) AS armVariantId
           FROM epics b JOIN workflow_runs br ON br.id = b.caused_by_run_id
          WHERE b.caused_by_run_id IS NOT NULL AND br.rotation_experiment_id = ?
         UNION ALL
         SELECT COALESCE(br.variant_id, ?) AS armVariantId
           FROM tasks b JOIN workflow_runs br ON br.id = b.caused_by_run_id
          WHERE b.caused_by_run_id IS NOT NULL AND br.rotation_experiment_id = ?
       )
       GROUP BY armVariantId`,
    )
    .all(
      BASELINE_VARIANT_SENTINEL,
      experimentId,
      BASELINE_VARIANT_SENTINEL,
      experimentId,
      BASELINE_VARIANT_SENTINEL,
      experimentId,
    ) as Array<{ armVariantId: string; postMergeBugCount: number }>;
  const bugsByArm = new Map(bugRows.map((row) => [row.armVariantId, row.postMergeBugCount]));

  const armSnapshot = db
    .prepare(
      'SELECT variant_id AS variantId, label FROM experiment_rotation_arms WHERE experiment_id = ? ORDER BY created_at, variant_id',
    )
    .all(experimentId) as Array<{ variantId: string; label: string }>;

  const results: RotationArmStats[] = armSnapshot.map((arm) =>
    buildRotationArmStats(
      arm.variantId,
      arm.label,
      baseByArm.get(arm.variantId),
      evalByArm.get(arm.variantId) ?? null,
      findingsByArm.get(arm.variantId) ?? 0,
      bugsByArm.get(arm.variantId) ?? 0,
    ),
  );

  // Defensive: an aggregate row whose key is not in the snapshot (should not
  // happen — every attributed run's arm was live at open) is appended after.
  const seenArms = new Set(armSnapshot.map((arm) => arm.variantId));
  for (const base of baseRows) {
    if (seenArms.has(base.armVariantId)) continue;
    results.push(
      buildRotationArmStats(
        base.armVariantId,
        fallbackArmLabel(base.armVariantId),
        base,
        evalByArm.get(base.armVariantId) ?? null,
        findingsByArm.get(base.armVariantId) ?? 0,
        bugsByArm.get(base.armVariantId) ?? 0,
      ),
    );
  }
  return results;
}

interface RotationExperimentRunRow {
  runId: string;
  armVariantId: string;
  armLabel: string;
  status: string;
  outcome: string | null;
  sessionId: string | null;
  projectId: number;
  createdAt: string;
  durationMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/**
 * The per-run drill-down for ONE rotation experiment — which runs got which
 * arm (phase 3 read surface, migration 057). One row per `workflow_runs` stamped
 * with `rotation_experiment_id = ?`; `LEFT JOIN run_usage` (1:1 with a run — no
 * fan-out) for tokens/cost, `LEFT JOIN experiment_rotation_arms` on the same
 * `COALESCE(variant_id, '__baseline__')` key as {@link selectRotationArmStats}
 * for the arm label. `durationMs` mirrors selectVariantStats: only computed for
 * a terminal run with both timestamps present, else null. Newest run first.
 *
 * @param db           - Narrow DatabaseLike surface.
 * @param experimentId - The rotation experiment whose runs are listed.
 */
export function selectRotationExperimentRuns(db: DatabaseLike, experimentId: string): RotationExperimentRun[] {
  const rows = db
    .prepare(
      `SELECT
         r.id AS runId,
         COALESCE(r.variant_id, ?) AS armVariantId,
         COALESCE(a.label, CASE WHEN r.variant_id IS NULL THEN 'Baseline' ELSE r.variant_id END) AS armLabel,
         r.status AS status,
         r.outcome AS outcome,
         r.session_id AS sessionId,
         r.project_id AS projectId,
         r.created_at AS createdAt,
         CASE
           WHEN r.status IN (${TERMINAL_SQL})
                AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL
           THEN (julianday(r.ended_at) - julianday(r.started_at)) * 86400000
         END AS durationMs,
         u.total_tokens AS totalTokens,
         u.cost_usd     AS costUsd
       FROM workflow_runs r
       LEFT JOIN run_usage u ON u.run_id = r.id
       LEFT JOIN experiment_rotation_arms a
              ON a.experiment_id = ? AND a.variant_id = COALESCE(r.variant_id, ?)
       WHERE r.rotation_experiment_id = ?
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .all(
      BASELINE_VARIANT_SENTINEL,
      experimentId,
      BASELINE_VARIANT_SENTINEL,
      experimentId,
    ) as RotationExperimentRunRow[];

  return rows.map((row): RotationExperimentRun => ({
    runId: row.runId,
    armVariantId: row.armVariantId,
    armLabel: row.armLabel,
    status: row.status,
    outcome: row.outcome,
    sessionId: row.sessionId,
    projectId: row.projectId,
    createdAt: toIso(row.createdAt) ?? row.createdAt,
    durationMs: row.durationMs === null ? null : Math.round(row.durationMs),
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
  }));
}

interface RotationExperimentRow {
  experimentId: string;
  workflowId: string;
  status: ExperimentStatus;
  createdAt: string;
  decidedAt: string | null;
  promotedVariantId: string | null;
}

interface RotationArmSnapshotRow {
  experimentId: string;
  variantId: string;
  label: string;
}

/**
 * Dashboard rows for ALL rotation experiments (running + settled), so they can
 * render alongside past side-by-side experiments in Insights section 04 (phase 3
 * read surface, migration 057). `experiments.listForDashboard`'s `kind =
 * 'side_by_side'` filter is UNCHANGED — this is the rotation-only sibling query.
 *
 * Per experiment: `armLabels` from its arm snapshot (created_at, variant_id
 * order); `runCount` is a separate grouped COUNT over `workflow_runs` (never a
 * row-multiplying join against the per-arm snapshot); `winnerLabel` is null
 * unless `status = 'decided'` (`promoted_variant_id` -> "Baseline" for the
 * sentinel, else the matching snapshot arm's label, else the raw id);
 * `seriesKey` is the SAME formula as the side-by-side dashboard's seriesKey
 * (workflow id + sorted arm-variant-id pair) so an identical matchup groups
 * identically regardless of experiment kind.
 *
 * @param db         - Narrow DatabaseLike surface.
 * @param workflowId - When non-null, restricts to that workflow's rotations; null = all.
 */
export function selectRotationDashboardRows(
  db: DatabaseLike,
  workflowId: string | null,
): RotationDashboardRow[] {
  const conds = ["e.kind = 'rotation'"];
  const params: unknown[] = [];
  if (workflowId !== null) {
    conds.push('e.workflow_id = ?');
    params.push(workflowId);
  }
  const expRows = db
    .prepare(
      `SELECT
         e.id AS experimentId, e.workflow_id AS workflowId, e.status AS status,
         e.created_at AS createdAt, e.decided_at AS decidedAt,
         e.promoted_variant_id AS promotedVariantId
       FROM experiments e
       WHERE ${conds.join(' AND ')}
       ORDER BY e.created_at DESC, e.id DESC`,
    )
    .all(...params) as RotationExperimentRow[];
  if (expRows.length === 0) return [];

  const ids = expRows.map((row) => row.experimentId);
  const armsByExp = new Map<string, RotationArmSnapshotRow[]>();
  const runCountByExp = new Map<string, number>();
  for (const idChunk of chunk(ids, RUN_ID_CHUNK_SIZE)) {
    const armRows = db
      .prepare(
        `SELECT experiment_id AS experimentId, variant_id AS variantId, label
         FROM experiment_rotation_arms
         WHERE experiment_id IN (${placeholders(idChunk.length)})
         ORDER BY created_at, variant_id`,
      )
      .all(...idChunk) as RotationArmSnapshotRow[];
    for (const arm of armRows) {
      const list = armsByExp.get(arm.experimentId) ?? [];
      list.push(arm);
      armsByExp.set(arm.experimentId, list);
    }
    const countRows = db
      .prepare(
        `SELECT rotation_experiment_id AS experimentId, COUNT(*) AS runCount
         FROM workflow_runs
         WHERE rotation_experiment_id IN (${placeholders(idChunk.length)})
         GROUP BY rotation_experiment_id`,
      )
      .all(...idChunk) as Array<{ experimentId: string; runCount: number }>;
    for (const row of countRows) runCountByExp.set(row.experimentId, row.runCount);
  }

  return expRows.map((exp): RotationDashboardRow => {
    const arms = armsByExp.get(exp.experimentId) ?? [];
    const armLabels = arms.map((arm) => arm.label);
    const seriesKey = `${exp.workflowId}:${arms
      .map((arm) => arm.variantId)
      .sort()
      .join('|')}`;
    let winnerLabel: string | null = null;
    if (exp.status === 'decided' && exp.promotedVariantId !== null) {
      if (isBaselineArm(exp.promotedVariantId)) {
        winnerLabel = 'Baseline';
      } else {
        const match = arms.find((arm) => arm.variantId === exp.promotedVariantId);
        winnerLabel = match ? match.label : exp.promotedVariantId;
      }
    }
    return {
      experimentId: exp.experimentId,
      workflowId: exp.workflowId,
      armLabels,
      status: exp.status,
      runCount: runCountByExp.get(exp.experimentId) ?? 0,
      createdAt: toIso(exp.createdAt) ?? exp.createdAt,
      decidedAt: toIso(exp.decidedAt),
      winnerLabel,
      seriesKey,
    };
  });
}

// ---------------------------------------------------------------------------
// 9. selectDailyModelUsage
// ---------------------------------------------------------------------------

interface DailyModelUsageRow {
  payloadJson: string;
  createdAt: string;
}

/** Per-(day, model) accumulator mutated in place while folding raw_events rows. */
interface DailyModelBucket {
  inputTokens: number;
  outputTokens: number;
  assistantMessageCount: number;
}

/** Model id reported when an assistant message carried no `message.model`. */
const UNKNOWN_MODEL = 'unknown';

/**
 * Composite-key separator joining `day` and `model` into one Map key. A space
 * never appears in a date slice, and the model id is the rest of the key after
 * the FIRST separator, so the key stays unambiguous even if a model id itself
 * contained a space — `indexOf` splits on the first one and keeps the tail whole.
 */
const DAY_MODEL_SEP = ' ';

/**
 * Per-(day, model) token buckets for the usage chart at the top of the
 * Statistics section, scanned over the last `days` days of `assistant`
 * raw_events.
 *
 * Window: rows are kept when `raw_events.created_at >= datetime('now', '-N days')`
 * -- the bind value is the string `-${days} days`, so the lookback is parameterized,
 * not string-concatenated. `days` is clamped to [1, 365] inside the helper. When
 * `projectId` is non-null the scan joins through `workflow_runs`/`workflows` and
 * restricts to that project; null aggregates every project.
 *
 * Parsing mirrors the other raw_events scan helpers (see scanRawEventRollups):
 *   - usage is read from `payload.message.usage` ({input_tokens, output_tokens,
 *     cache_read_input_tokens?, cache_creation_input_tokens?} -- any number may be
 *     absent). A row with no usable usage object is skipped (NOT counted).
 *   - model is `payload.message.model` (string), falling back to 'unknown'.
 *   - malformed JSON is skipped silently.
 *
 * Buckets are keyed by (day, model) where `day` is the UTC date slice of
 * `created_at` (the first 10 chars of SQLite's 'YYYY-MM-DD HH:MM:SS' UTC form).
 * `totalTokens` = inputTokens + outputTokens (cache EXCLUDED, matching the
 * RunUsageRollup convention). Only `assistant` events are scanned -- `result`
 * events (which restate per-turn totals) are excluded by the WHERE clause so their
 * totals can never be double-counted. The result is sorted by `day` ASC then
 * `model` ASC; days with no usage emit no bucket.
 *
 * @param db        - Narrow DatabaseLike surface.
 * @param projectId - When non-null, restricts to that project; null = all.
 * @param days      - Lookback window in days, clamped to [1, 365].
 */
export function selectDailyModelUsage(
  db: DatabaseLike,
  projectId: number | null,
  days: number,
): DailyModelUsagePoint[] {
  const clampedDays = Math.min(365, Math.max(1, Math.trunc(days)));
  // '-N days' is the datetime() modifier; bound as a parameter (the helper never
  // concatenates `days` into the SQL text).
  const windowArg = `-${clampedDays} days`;

  // The project scope is an optional JOIN through workflow_runs -> workflows; when
  // projectId is null we skip the joins entirely (a flat raw_events scan).
  const sql =
    projectId === null
      ? `SELECT e.payload_json AS payloadJson, e.created_at AS createdAt
         FROM raw_events e
         WHERE e.event_type = 'assistant'
           AND e.created_at >= datetime('now', ?)`
      : `SELECT e.payload_json AS payloadJson, e.created_at AS createdAt
         FROM raw_events e
         JOIN workflow_runs r ON r.id = e.run_id
         WHERE e.event_type = 'assistant'
           AND e.created_at >= datetime('now', ?)
           AND r.project_id = ?`;

  const stmt = db.prepare(sql);
  const rows = (
    projectId === null ? stmt.all(windowArg) : stmt.all(windowArg, projectId)
  ) as DailyModelUsageRow[];

  // Accumulate per (day, model); the key joins both on DAY_MODEL_SEP.
  const buckets = new Map<string, DailyModelBucket>();

  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      continue; // malformed JSON -- skip silently
    }
    if (!isRecord(payload)) continue;
    const message = payload.message;
    if (!isRecord(message)) continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue; // no usage object -> not counted

    const model = typeof message.model === 'string' ? message.model : UNKNOWN_MODEL;
    // SQLite DATETIME is 'YYYY-MM-DD HH:MM:SS' UTC; the first 10 chars are the day.
    const day = row.createdAt.slice(0, 10);
    const key = `${day}${DAY_MODEL_SEP}${model}`;

    const bucket = buckets.get(key) ?? {
      inputTokens: 0,
      outputTokens: 0,
      assistantMessageCount: 0,
    };
    bucket.inputTokens += asNumber(usage.input_tokens);
    bucket.outputTokens += asNumber(usage.output_tokens);
    bucket.assistantMessageCount += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([key, agg]): DailyModelUsagePoint => {
      const sep = key.indexOf(DAY_MODEL_SEP);
      const day = key.slice(0, sep);
      const model = key.slice(sep + DAY_MODEL_SEP.length);
      return {
        day,
        model,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        totalTokens: agg.inputTokens + agg.outputTokens,
        assistantMessageCount: agg.assistantMessageCount,
      };
    })
    .sort((a, b) =>
      a.day < b.day
        ? -1
        : a.day > b.day
          ? 1
          : a.model < b.model
            ? -1
            : a.model > b.model
              ? 1
              : 0,
    );
}

// ---------------------------------------------------------------------------
// getRunEval (migration 043 `run_evals` — the code-review eval read path)
// ---------------------------------------------------------------------------

/** Raw `run_evals` row (SELECT * column names), all snake_case. */
interface RunEvalRawRow {
  run_id: string;
  rubric_version: string;
  eval_status: string;
  base_sha: string | null;
  diff_stats_json: string | null;
  gate_results_json: string | null;
  human_influenced: number;
  snapshot_at: string;
  overall_score: number | null;
  band: string | null;
  ci_low: number | null;
  ci_high: number | null;
  gated: number;
  security_flag: number;
  requirements_unmet: number;
  cap_triggers_json: string | null;
  dimensions_json: string | null;
  judge_model: string | null;
  sample_count: number | null;
  prompt_hash: string | null;
  judge_build_id: string | null;
  workflow_id: string;
  workflow_name: string;
  spec_hash: string | null;
  run_model: string | null;
  subagent_models_json: string | null;
  difficulty_proxy_prerun: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const RUN_EVAL_STATUSES: readonly RunEvalStatus[] = ['pending', 'running', 'complete', 'failed'];
const RUN_EVAL_BANDS: readonly RunEvalBand[] = ['Excellent', 'Good', 'Fair', 'Poor'];

/** SQLite INTEGER boolean → JS boolean (any non-zero is true). */
function asBool(value: number): boolean {
  return value !== 0;
}

/** Finite-number-or-null guard for the nullable numeric eval columns. */
function asNullableNumber(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parse a JSON text column to a plain object, defensively: malformed JSON or a
 * non-object (array/primitive/null) yields null rather than throwing — the
 * contract's "bad JSON → null field, never throw" rule.
 */
function parseJsonRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/**
 * Parse `dimensions_json` into a typed dimension array, defensively. Any element
 * that is not a well-formed object is skipped; malformed JSON or a non-array
 * yields null. Numeric fields fall back to 0 (counts/weight) or null (score).
 */
function parseDimensions(text: string | null): RunEvalDimension[] | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: RunEvalDimension[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    out.push({
      key: typeof entry.key === 'string' ? entry.key : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      weight: asNumber(entry.weight),
      score:
        typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : null,
      active: entry.active === true,
      passCount: asNumber(entry.passCount),
      failCount: asNumber(entry.failCount),
      unknownCount: asNumber(entry.unknownCount),
    });
  }
  return out;
}

/**
 * Parse `cap_triggers_json` into a string-token array, defensively. Non-string
 * elements are dropped; malformed JSON, a non-array, or an empty array yields null
 * (null = not capped, so the UI can tell a capped 69 from an organic Fair 69).
 */
function parseCapTriggers(text: string | null): string[] | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = parsed.filter((t): t is string => typeof t === 'string');
  return out.length > 0 ? out : null;
}

/** Map a raw `run_evals` row to the shared `RunEval`, parsing JSON defensively. */
function mapRunEvalRow(row: RunEvalRawRow): RunEval {
  const evalStatus: RunEvalStatus = RUN_EVAL_STATUSES.includes(row.eval_status as RunEvalStatus)
    ? (row.eval_status as RunEvalStatus)
    : 'pending';
  const band: RunEvalBand | null =
    row.band !== null && RUN_EVAL_BANDS.includes(row.band as RunEvalBand)
      ? (row.band as RunEvalBand)
      : null;
  return {
    runId: row.run_id,
    rubricVersion: row.rubric_version,
    evalStatus,
    baseSha: row.base_sha,
    // diff_text / per_sample_json are intentionally NOT selected by the polled
    // read (they can be multi-MB) — the summary panel never reads them. A future
    // drill-down would fetch them via a dedicated read.
    diffText: null,
    diffStats: parseJsonRecord(row.diff_stats_json),
    gateResults: parseJsonRecord(row.gate_results_json),
    humanInfluenced: asBool(row.human_influenced),
    snapshotAt: row.snapshot_at,
    overallScore: asNullableNumber(row.overall_score),
    band,
    ciLow: asNullableNumber(row.ci_low),
    ciHigh: asNullableNumber(row.ci_high),
    gated: asBool(row.gated),
    securityFlag: asBool(row.security_flag),
    requirementsUnmet: asBool(row.requirements_unmet),
    capTriggers: parseCapTriggers(row.cap_triggers_json),
    dimensions: parseDimensions(row.dimensions_json),
    perSample: null,
    judgeModel: row.judge_model,
    sampleCount: asNullableNumber(row.sample_count),
    promptHash: row.prompt_hash,
    judgeBuildId: row.judge_build_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    specHash: row.spec_hash,
    runModel: row.run_model,
    subagentModels: parseJsonRecord(row.subagent_models_json),
    difficultyProxyPrerun: asNullableNumber(row.difficulty_proxy_prerun),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The canonical evaluation for one run, or null when none exists yet.
 *
 * A run can carry several `run_evals` rows (one per rubric_version), and a row's
 * `human_influenced` flag flips to 1 once a request-changes loop re-fires the
 * human-review gate. The canonical row is the FIRST non-human-influenced snapshot
 * (the pristine, pre-human evaluation): we order `human_influenced ASC` so a
 * 0-flagged row wins over any 1-flagged one, then `snapshot_at ASC` to take the
 * earliest, falling back to the earliest influenced row only when every row is
 * influenced. JSON columns are parsed defensively (bad JSON → null field).
 *
 * @param db    - Narrow DatabaseLike surface.
 * @param runId - The run to read the evaluation for.
 */
export function getRunEval(db: DatabaseLike, runId: string): RunEval | null {
  const row = db
    .prepare(
      // diff_text + per_sample_json are deliberately EXCLUDED — they can be
      // multi-MB and the summary panel polls this every 10s but reads neither.
      `SELECT run_id, rubric_version, eval_status, base_sha, diff_stats_json,
              gate_results_json, human_influenced, snapshot_at, overall_score, band,
              ci_low, ci_high, gated, security_flag, requirements_unmet, cap_triggers_json,
              dimensions_json, judge_model, sample_count, prompt_hash, judge_build_id,
              workflow_id, workflow_name, spec_hash, run_model, subagent_models_json,
              difficulty_proxy_prerun, error, created_at, updated_at
       FROM run_evals
       WHERE run_id = ?
       ORDER BY human_influenced ASC, snapshot_at ASC
       LIMIT 1`,
    )
    .get(runId) as RunEvalRawRow | undefined;
  return row === undefined ? null : mapRunEvalRow(row);
}
