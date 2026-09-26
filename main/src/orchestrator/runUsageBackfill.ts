/**
 * runUsageBackfill — the one-shot boot backfill that brings past runs onto the
 * current usage accounting version (docs/proposals/codex-workflow-efficiency.md
 * §5.2, 1d). Runs at boot BEFORE `backfillRunUsageRollups`, so the rows that
 * sweep adds for still-unmaterialized runs already see this pass's Codex rows.
 *
 * Per candidate run — every run with usage raw_events (the fold's event types,
 * or stored Codex app-server notifications) not yet recorded in
 * `usage_backfill_runs` at {@link ACCOUNTING_VERSION} — ONE transaction:
 *   1. Codex runs: the injected replay (services/panels/codex/codexUsageReplay.ts)
 *      rebuilds descendant usage from the stored notifications and upserts the
 *      historical `codex-subagent-run:` / `codex-unattributed:` rows.
 *   2. The run's `run_usage` row is recomputed with the current fold through
 *      the shared writer, carrying the fold's coverage raised by what the replay
 *      could not see: `codex-run-level` when historical rows were written,
 *      `codex-root-only` when the run stored notifications but no
 *      `rawResponse/completed` at all (before 2026-09-14T19:51Z — decided from
 *      the data, not the date). Most severe wins.
 *   3. `(run_id, ACCOUNTING_VERSION)` goes into `usage_backfill_runs`.
 *
 * A NON-terminal run with no `run_usage` row gets no row here (steps 1 and 3
 * still happen): its log is still growing, and materializing it now would
 * freeze a partial rollup the read path prefers — the executor's terminal seam
 * writes it. Such a run loses a `codex-root-only` raise, which only a pre-
 * boundary run left non-terminal could carry. A row that already exists is
 * replaced whatever the status: it is stale at the old version either way.
 *
 * A run whose transaction throws is logged and skipped: the transaction rolls
 * back, so its old row stays and it is not recorded as done. The completion
 * marker is written only when every candidate succeeded, so the next boot
 * resumes from the progress table; with the marker present the whole pass is a
 * single indexed lookup.
 *
 * Runs with no usage raw_events are never candidates — their stored row stays
 * `legacy` (migration 132's rule). Historical root `agent_result` rows are not
 * rewritten (their ~0.4% duplicate-update overcount stays, documented in §5.2).
 *
 * DEFERRED, one run at a time. Measured read-only against the production
 * database (617 candidate runs, 47 of them Codex), the pass reads ~180 MB of
 * notification payloads plus the ~300 MB of usage rows the recompute folds —
 * about 9-11 s in all, the slowest single run ~1 s. Every read is indexed by
 * run_id, so no two runs' payloads are held at once, and the pass yields to the
 * event loop before each run: the boot wiring starts it without awaiting, and
 * chains `backfillRunUsageRollups` after it (keeping that sweep second), so the
 * window opens while it works. Each run's transaction is synchronous, so nothing
 * interleaves inside one — not the executor's terminal rollup, not a live Codex
 * tracker. Between runs they can: a run resumed on this boot writes new
 * notifications and rows, so the wiring bounds the replay to notifications
 * stored before the process started (codexUsageReplay.ts); a run the executor
 * rolls up before this pass reaches it is simply recomputed again. Quitting
 * mid-pass leaves the remaining runs to the next boot (no marker).
 *
 * Standalone-typecheck invariant (mirrors runRecovery.ts): no imports from
 * 'electron', 'better-sqlite3', or any concrete service — the Codex replay is
 * injected by the boot wiring.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { UsageCoverage } from '../../../shared/types/insights';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';
import { ACCOUNTING_VERSION, USAGE_FOLD_EVENT_TYPES, mostSevereCoverage } from './usageFold';
import { selectRunUsageRollupsFromRawEvents } from './insightsQueries';
import { writeRunUsageRow } from './runUsageRollup';

/** What the Codex replay did for one run (see codexUsageReplay.ts). */
export interface CodexRunReplayResult {
  /** At least one `rawResponse/completed` was stored for the run. */
  hasResponses: boolean;
  /** Historical descendant / unattributed rows upserted. */
  rowsWritten: number;
}

export interface UsageBackfillDeps {
  /** Rebuild and upsert one run's historical Codex rows; throws on failure. */
  replayCodexRun: (runId: string) => CodexRunReplayResult;
  /** Awaited before each run; defaults to a macrotask yield (setImmediate). */
  yieldBetweenRuns?: () => Promise<void>;
}

export interface UsageBackfillResult {
  /** True when the marker for the current version was already present. */
  alreadyComplete: boolean;
  candidates: number;
  backfilled: number;
  failed: number;
  /** The completion marker was written by this call. */
  markerWritten: boolean;
}

/** raw_events event type of a stored Codex app-server notification (codex/appServer/rawNotificationSink.ts). */
const CODEX_NOTIFICATION_EVENT_TYPE = 'codex_app_server_notification';

const CANDIDATE_EVENT_TYPES: readonly string[] = [...USAGE_FOLD_EVENT_TYPES, CODEX_NOTIFICATION_EVENT_TYPE];

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATUSES);

interface CandidateRow {
  runId: string;
  status: string;
  hasCodex: number;
}

function placeholders(n: number): string {
  return new Array<string>(n).fill('?').join(', ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Backfill one run inside its own transaction. Throws (after the rollback) on
 * any failure.
 */
function backfillRun(db: DatabaseLike, deps: UsageBackfillDeps, candidate: CandidateRow): void {
  const tx = db.transaction(() => {
    let raise: UsageCoverage = 'complete';
    if (candidate.hasCodex === 1) {
      const replay = deps.replayCodexRun(candidate.runId);
      if (!replay.hasResponses) raise = mostSevereCoverage(raise, 'codex-root-only');
      if (replay.rowsWritten > 0) raise = mostSevereCoverage(raise, 'codex-run-level');
    }

    const hasRow = db.prepare('SELECT 1 FROM run_usage WHERE run_id = ?').get(candidate.runId) !== undefined;
    if (hasRow || TERMINAL_STATUSES.has(candidate.status)) {
      // The fold's diagnostics are not forwarded: a whole-history pass would
      // flood the log with every past run's (already known) anomalies.
      const rollup = selectRunUsageRollupsFromRawEvents(db, [candidate.runId])[0];
      if (rollup === undefined) throw new Error('run_usage fold returned no row');
      rollup.coverage = mostSevereCoverage(rollup.coverage, raise);
      writeRunUsageRow(db, rollup, 'replace');
    }

    db.prepare(
      'INSERT OR IGNORE INTO usage_backfill_runs (run_id, accounting_version) VALUES (?, ?)',
    ).run(candidate.runId, ACCOUNTING_VERSION);
  });
  tx();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run the backfill (see the module header). Never rejects: a failure to even
 * list candidates (an un-migrated DB) is logged and reported as zero work.
 */
export async function backfillUsageAccounting(
  db: DatabaseLike,
  deps: UsageBackfillDeps,
  logger?: Pick<LoggerLike, 'warn'>,
): Promise<UsageBackfillResult> {
  const result: UsageBackfillResult = {
    alreadyComplete: false,
    candidates: 0,
    backfilled: 0,
    failed: 0,
    markerWritten: false,
  };
  let candidates: CandidateRow[];
  try {
    const marker = db
      .prepare('SELECT 1 FROM usage_backfill_marker WHERE accounting_version = ?')
      .get(ACCOUNTING_VERSION);
    if (marker !== undefined) return { ...result, alreadyComplete: true };

    // Only runs that still exist: raw_events outliving its run (FK enforcement
    // off) would fail the run_usage FK on every boot and block the marker.
    candidates = db
      .prepare(
        `SELECT r.id AS runId, r.status AS status,
                EXISTS (SELECT 1 FROM raw_events c
                         WHERE c.run_id = r.id AND c.event_type = ?) AS hasCodex
           FROM workflow_runs r
          WHERE EXISTS (SELECT 1 FROM raw_events e
                         WHERE e.run_id = r.id AND e.event_type IN (${placeholders(CANDIDATE_EVENT_TYPES.length)}))
            AND NOT EXISTS (SELECT 1 FROM usage_backfill_runs b
                             WHERE b.run_id = r.id AND b.accounting_version = ?)
          ORDER BY r.created_at, r.id`,
      )
      .all(CODEX_NOTIFICATION_EVENT_TYPE, ...CANDIDATE_EVENT_TYPES, ACCOUNTING_VERSION) as CandidateRow[];
  } catch (err) {
    logger?.warn('[runUsageBackfill] could not list backfill candidates (skipped this boot)', {
      error: errorMessage(err),
    });
    return result;
  }

  result.candidates = candidates.length;
  const yieldBetweenRuns = deps.yieldBetweenRuns ?? yieldToEventLoop;
  for (const candidate of candidates) {
    await yieldBetweenRuns();
    try {
      backfillRun(db, deps, candidate);
      result.backfilled += 1;
    } catch (err) {
      result.failed += 1;
      logger?.warn('[runUsageBackfill] run backfill failed; its old run_usage row is kept', {
        runId: candidate.runId,
        error: errorMessage(err),
      });
    }
  }

  if (result.failed === 0) {
    try {
      db.prepare('INSERT OR IGNORE INTO usage_backfill_marker (accounting_version) VALUES (?)').run(
        ACCOUNTING_VERSION,
      );
      result.markerWritten = true;
    } catch (err) {
      logger?.warn('[runUsageBackfill] could not write the completion marker', { error: errorMessage(err) });
    }
  }
  return result;
}
