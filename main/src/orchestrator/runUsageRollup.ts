/**
 * runUsageRollup — materialize a durable per-run token/cost rollup row in
 * `run_usage` (migration 026) at the moment a run reaches a terminal seam.
 *
 * WHY THIS EXISTS
 * ---------------
 * Insights Phase 1 computes token/cost rollups ON THE FLY from `raw_events`
 * (insightsQueries.selectRunUsageRollups — a full per-run raw_events scan).
 * Phase 2 adds `run_usage` so the Insights view reads ONE precomputed row per run
 * instead of re-scanning the (potentially large) raw_events log on every read.
 * This module is the Phase-2 WRITER: it runs the same scan ONCE, at run
 * termination, and upserts the result.
 *
 * SEAM CONTRACT — WHY "AT TERMINATION" IS CORRECT
 * -----------------------------------------------
 * `selectRunUsageRollups` reads only `assistant` + `result` raw_events for the
 * run. Those events are PERSISTED into raw_events by the SDK→bridge pipeline
 * (RawEventsSink, driven by ClaudeCodeManager's EventRouter) BEFORE the run's
 * terminal lifecycle transition fires:
 *   - on a clean drain, the SDK `query()` iterator is fully consumed (every
 *     assistant + the terminal result event has already been emitted, routed,
 *     and INSERTed) by the time `spawnCliProcess()` resolves and the executor
 *     fires the 'drained' → restAwaitingReview transition. So at the rest seam
 *     the raw_events log for this run is COMPLETE.
 *   - on failure/cancel, whatever events DID land are already persisted; the
 *     run simply has fewer (or no) usage events, and the scan reflects exactly
 *     what was captured. A zeroed rollup for a run that produced no usage events
 *     is the correct, intended result (selectRunUsageRollups seeds a zero row
 *     for the requested id).
 * Calling the rollup AFTER the terminal transition's event flush is therefore a
 * read over a frozen, complete-for-this-run slice of raw_events.
 *
 * WHY `INSERT OR REPLACE` (AND A PRECEDING DELETE)
 * ------------------------------------------------
 * The run_usage row is keyed by `run_id` (PRIMARY KEY). A single run can reach a
 * terminal seam MORE THAN ONCE in this codebase:
 *   - the interactive substrate rests in awaiting_review per TURN (each turn-end
 *     re-fires the 'drained' transition), and a run can be RESUMED (Pause/Resume,
 *     idle-chat nudge) onto the SAME conversation and then re-drain — each
 *     re-drain should re-roll-up the now-larger raw_events log.
 *   - a run that drained, then failed/canceled on a later turn, re-terminates.
 * `INSERT OR REPLACE` makes every such re-terminal write idempotent: the latest
 * full scan overwrites the prior row rather than colliding on the PK or
 * accumulating stale partials. `computed_at` is intentionally NOT in the column
 * list so it takes its DEFAULT (CURRENT_TIMESTAMP) on every replace — the column
 * always reflects the most recent materialization.
 *
 * WRITER MUST NEVER CONSUME ITS OWN OUTPUT (the DELETE-before-scan)
 * ----------------------------------------------------------------
 * `selectRunUsageRollups` is a TWO-TIER read (migration 026): it PREFERS an
 * existing materialized `run_usage` row over the raw_events scan, falling back to
 * the scan only for runs WITHOUT a row. That two-tier behavior is correct for the
 * Insights READ path — but it is poison for THIS WRITER. If we called it with a
 * prior row still present, tier-1 would hand back the writer's OWN stale row and
 * we would REPLACE it with identical values: every re-terminal seam (per-turn
 * re-drain, resume-then-drain, fail-after-drain) would freeze the rollup at its
 * first-seam value and never fold in the raw_events that landed since. To keep the
 * writer honest we DELETE the run's row FIRST, so the very `selectRunUsageRollups`
 * call below misses tier-1 and falls through to a fresh tier-2 raw_events scan —
 * the full, current, this-run slice. (If the run never had a row, the DELETE is a
 * harmless no-op.) The DELETE + INSERT are not wrapped in a transaction on
 * purpose: a crash in the narrow window between them leaves the run with NO
 * materialized row, which the Insights read path simply recovers from via its own
 * tier-2 fallback — strictly better than leaving a stale row behind.
 *
 * FAIL-SOFT CONTRACT
 * ------------------
 * A rollup failure must NEVER break a run transition. This is a derived,
 * best-effort overlay (Insights can always fall back to the Phase-1 on-the-fly
 * scan if a row is missing or stale). Every throw — a missing `run_usage` table
 * on an un-migrated DB, a malformed raw_events payload that escapes the query's
 * own guards, an FK violation on a since-deleted run — is caught and logged at
 * WARN with runId context, then swallowed. The caller (runExecutor's terminal
 * seams) proceeds untouched.
 *
 * Standalone-typecheck invariant (mirrors insightsQueries.ts): this module must
 * NOT import from 'electron', 'better-sqlite3', 'fs', or any concrete service in
 * main/src/services/*. Only DatabaseLike + LoggerLike + the pure query helper.
 */
import type { DatabaseLike, LoggerLike } from './types';
import { selectRunUsageRollups } from './insightsQueries';

/**
 * Compute and persist (upsert) the token/cost rollup for a single terminated run.
 *
 * DELETEs any prior `run_usage` row for the run FIRST (so the writer never reads
 * back its own stale output — see the module header), then computes the rollup
 * via `selectRunUsageRollups(db, [runId])[0]`, which now misses the materialized
 * tier and performs the fresh raw_events scan the Insights view would do on the
 * fly, and writes it into `run_usage` with `INSERT OR REPLACE` so a re-terminal
 * transition or a resumed run re-rolling up overwrites the prior row
 * idempotently. `computed_at` is omitted from the column list so it takes its
 * DEFAULT on each write.
 *
 * Synchronous + `void`: it is fired at a lifecycle seam where the caller does
 * not await a result, and it must not surface errors — see the fail-soft
 * contract in the module header. Any throw is caught and logged via
 * `logger?.warn` with runId context; the function never re-throws.
 *
 * @param db     - Narrow DatabaseLike surface (same one threaded to the executor).
 * @param runId  - The run that just reached a terminal seam.
 * @param logger - Optional structured logger; warn-on-failure is gated on it
 *                 (CLAUDE.md: pass it through from the enclosing scope, never omit).
 */
export function rollupRunUsage(db: DatabaseLike, runId: string, logger?: LoggerLike): void {
  try {
    // Drop any prior materialized row FIRST so the selectRunUsageRollups call
    // below cannot read it back from the helper's tier-1 (materialized) path and
    // REPLACE the row with its own stale values. With the row gone, the helper
    // misses tier-1 and falls through to a fresh tier-2 raw_events scan — the
    // full, current slice for this run. A missing row here is a no-op DELETE; a
    // crash between this DELETE and the INSERT below is fail-soft (Insights'
    // read path re-derives from raw_events). See the module header.
    db.prepare(`DELETE FROM run_usage WHERE run_id = ?`).run(runId);

    // selectRunUsageRollups always returns an array of length runIds.length with
    // a (possibly zeroed) row for the requested id, so [0] is non-null here. The
    // `?? null` guard is purely defensive against a future signature change.
    const rollup = selectRunUsageRollups(db, [runId])[0] ?? null;
    if (rollup === null) {
      // Should be unreachable (the helper seeds a zero row per requested id), but
      // bail without writing rather than INSERTing a half-formed row.
      logger?.warn('[runUsageRollup] selectRunUsageRollups returned no row (skipping upsert)', {
        runId,
      });
      return;
    }

    // INSERT OR REPLACE keyed on run_id (PK). Column order matches migration 026's
    // run_usage definition; computed_at is deliberately absent so it takes its
    // DEFAULT (CURRENT_TIMESTAMP) on every (re-)materialization.
    db.prepare(
      `INSERT OR REPLACE INTO run_usage (
         run_id,
         input_tokens,
         output_tokens,
         cache_read_tokens,
         cache_creation_tokens,
         total_tokens,
         cost_usd,
         num_turns,
         assistant_message_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rollup.runId,
      rollup.inputTokens,
      rollup.outputTokens,
      rollup.cacheReadTokens,
      rollup.cacheCreationTokens,
      rollup.totalTokens,
      // cost_usd / num_turns are nullable in run_usage — pass the rollup's
      // null-or-number through verbatim (null distinguishes "no result carried it").
      rollup.costUsd,
      rollup.numTurns,
      rollup.assistantMessageCount,
    );
  } catch (err) {
    // Fail-soft: a rollup failure (missing table on an un-migrated DB, FK
    // violation on a since-deleted run, etc.) must never break the run
    // transition. Log at warn with runId context and swallow.
    logger?.warn('[runUsageRollup] failed to materialize run_usage rollup (fail-soft)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
