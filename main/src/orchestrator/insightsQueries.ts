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
} from '../../../shared/types/insights';
import { parseSourceStep } from '../../../shared/types/insights';

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
    ${projectId === null ? '' : 'WHERE w.project_id = ?'}
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

/** Max ids per IN-list chunk; keeps us well under SQLite's parameter ceiling. */
const RUN_ID_CHUNK_SIZE = 400;

/**
 * Token/cost rollup per run, from one pass over the run's persisted
 * `assistant` + `result` raw_events. The id list is chunked at 400 so the
 * `IN (...)` clause never blows the bound-parameter limit; rows are processed
 * in (run_id, id) order so cost/turn SUMs are deterministic.
 *
 * Parsing rules (all guarded against malformed JSON, which is skipped silently):
 *   - assistant → message.usage.{input,output,cache_read,cache_creation}_tokens
 *     (each optional). `assistantMessageCount` increments ONLY when a `usage`
 *     object is present.
 *   - result → total_cost_usd (SUMmed; null when never present) and num_turns
 *     (SUMmed; null when never present).
 * `result.usage` tokens are intentionally NOT added (they restate turn totals).
 * `totalTokens` = inputTokens + outputTokens.
 *
 * Runs with no matching events still get a zeroed rollup (every requested id is
 * seeded), so callers can index by runId without undefined checks.
 *
 * @param db     - Narrow DatabaseLike surface.
 * @param runIds - Run ids to roll up (order of the result mirrors this list).
 */
export function selectRunUsageRollups(
  db: DatabaseLike,
  runIds: string[],
): RunUsageRollup[] {
  // Seed an accumulator for every requested id so empty runs still appear.
  const acc = new Map<string, RunUsageRollup>();
  for (const id of runIds) {
    acc.set(id, {
      runId: id,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: null,
      numTurns: null,
      assistantMessageCount: 0,
    });
  }
  if (runIds.length === 0) return [];

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

  // Finalize derived totals and emit in the caller's requested order.
  return runIds.map((id) => {
    const r = acc.get(id);
    // acc always has the id (seeded above), but narrow defensively.
    if (r === undefined) {
      return {
        runId: id,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: null,
        numTurns: null,
        assistantMessageCount: 0,
      };
    }
    r.totalTokens = r.inputTokens + r.outputTokens;
    return r;
  });
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
 * `limitRunsPerWorkflow` run ids that have ANY persisted events (any status),
 * roll them up via `selectRunUsageRollups`, then aggregate:
 *   - runsWithUsage = rollups whose assistantMessageCount > 0.
 *   - avgTotalTokens = mean totalTokens over those runs (null when none).
 *   - totalCostUsd = sum of non-null costUsd (null when every rollup was null).
 *   - avgCostUsd = mean costUsd over runs with a non-null cost (null when none).
 *
 * @param db                   - Narrow DatabaseLike surface.
 * @param projectId            - When non-null, restricts to that project.
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
             WHERE project_id = ?
             ORDER BY name ASC`,
          )
          .all(projectId)
  ) as WorkflowWithRunIdsRow[];

  // Per workflow: last N run ids that carry at least one raw_events row.
  const recentRunsStmt = db.prepare(
    `SELECT r.id AS runId
     FROM workflow_runs r
     WHERE r.workflow_id = ?
       AND EXISTS (SELECT 1 FROM raw_events e WHERE e.run_id = r.id)
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`,
  );

  const result: WorkflowUsageStats[] = [];
  for (const wf of workflows) {
    const runIdRows = recentRunsStmt.all(
      wf.workflowId,
      limitRunsPerWorkflow,
    ) as RunIdRow[];
    const runIds = runIdRows.map((row) => row.runId);
    const rollups = selectRunUsageRollups(db, runIds);

    const usedRollups = rollups.filter((r) => r.assistantMessageCount > 0);
    const costRollups = rollups.filter((r) => r.costUsd !== null);

    const runsWithUsage = usedRollups.length;
    const avgTotalTokens =
      runsWithUsage === 0
        ? null
        : Math.round(
            usedRollups.reduce((sum, r) => sum + r.totalTokens, 0) / runsWithUsage,
          );
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
    pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0 },
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
      row.kind === 'human_task'
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

// ---------------------------------------------------------------------------
// 6. selectStepTokenBuckets
// ---------------------------------------------------------------------------

interface StepEventRow {
  runId: string;
  payloadJson: string;
}

/** The MCP report-step tool name suffix. MCP prefixing yields names like
 *  'mcp__cyboflow__cyboflow_report_step', so we suffix-match. */
const REPORT_STEP_TOOL_SUFFIX = 'cyboflow_report_step';

/** Step id used before the first cyboflow_report_step lands in a run. */
const UNATTRIBUTED_STEP = 'unattributed';

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
 * Tokens attributed to each workflow step across the workflow's most recent
 * `lastNRuns` runs. Within each run we walk its `assistant` events in
 * (run_id, id) order, tracking a "current step" that starts at 'unattributed'.
 *
 * Attribution ORDER per assistant payload (load-bearing): we FIRST attribute
 * the payload's own usage to the current step, THEN inspect its content for a
 * `cyboflow_report_step` tool_use that switches the current step. This means
 * the message that REPORTS a step transition is itself counted under the
 * PREVIOUS step — the report tool_use belongs to the step that was running
 * when the agent decided to advance.
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
  const buckets = new Map<string, { totalTokens: number; assistantMessageCount: number }>();
  const bump = (stepId: string, tokens: number): void => {
    const existing = buckets.get(stepId) ?? { totalTokens: 0, assistantMessageCount: 0 };
    existing.totalTokens += tokens;
    existing.assistantMessageCount += 1;
    buckets.set(stepId, existing);
  };

  for (const ids of chunk(runIds, RUN_ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT run_id AS runId, payload_json AS payloadJson
         FROM raw_events
         WHERE run_id IN (${placeholders(ids.length)})
           AND event_type = 'assistant'
         ORDER BY run_id, id`,
      )
      .all(...ids) as StepEventRow[];

    // Track the current step per run (rows are grouped by run_id via ORDER BY).
    let currentRunId: string | null = null;
    let currentStep = UNATTRIBUTED_STEP;

    for (const row of rows) {
      if (row.runId !== currentRunId) {
        currentRunId = row.runId;
        currentStep = UNATTRIBUTED_STEP;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch {
        continue; // malformed — skip
      }
      if (!isRecord(payload)) continue;
      const message = payload.message;
      if (!isRecord(message)) continue;

      // 1. Attribute this payload's usage to the CURRENT step (before any switch).
      const usage = isRecord(message.usage) ? message.usage : null;
      if (usage !== null) {
        const tokens =
          asNumber(usage.input_tokens) + asNumber(usage.output_tokens);
        bump(currentStep, tokens);
      }

      // 2. THEN switch the current step if this message reported a transition.
      const reported = extractReportedStepId(message);
      if (reported !== null) {
        currentStep = reported;
      }
    }
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
