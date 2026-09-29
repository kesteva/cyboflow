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
 * The usage fold reads only the run's usage raw_events (assistant / result /
 * provider result / subagent usage rows). Those events are PERSISTED into raw_events by the SDK→bridge pipeline
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
 *     is the correct, intended result (the rollup helpers seed a zero row
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
 * WRITER MUST NEVER CONSUME ITS OWN OUTPUT (force-scan + DELETE-first)
 * ---------------------------------------------------------------------
 * `selectRunUsageRollups` is a TWO-TIER read (migration 026): it PREFERS an
 * existing materialized `run_usage` row over the raw_events scan. That is correct
 * for the Insights READ path but poison for THIS WRITER: tier-1 would hand back
 * the writer's OWN stale row and every re-terminal seam (per-turn re-drain,
 * resume-then-drain, fail-after-drain) would freeze the rollup at its first-seam
 * value. The writer therefore computes through the force-scan sibling
 * `selectRunUsageRollupsFromRawEvents`, which always folds the full, current
 * raw_events slice under the CURRENT accounting version (usageFold.ts), and
 * stamps that version and the run's coverage on the row. It still DELETEs the
 * prior row first: the DELETE + INSERT are not wrapped in a transaction on
 * purpose, so a crash between them leaves NO materialized row, which the Insights
 * read path recovers from via its own tier-2 fold — strictly better than leaving
 * a stale row (possibly at an older accounting version) behind.
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
import type { RunUsageRollup } from '../../../shared/types/insights';
import { selectRunUsageRollupsFromRawEvents } from './insightsQueries';

/**
 * Write one rollup into `run_usage` — the single INSERT both writers share
 * (this module's per-run seam and runRecovery's boot backfill), so every row
 * records the fold version and coverage that produced it (migration 146).
 * `onConflict` 'replace' re-materializes; 'ignore' only ever ADDS a missing row.
 * `computed_at` is deliberately absent so it takes its DEFAULT on every write.
 * Returns the statement's `changes` count.
 */
export function writeRunUsageRow(
  db: DatabaseLike,
  rollup: RunUsageRollup,
  onConflict: 'replace' | 'ignore',
): number {
  const info = db
    .prepare(
      `INSERT OR ${onConflict === 'replace' ? 'REPLACE' : 'IGNORE'} INTO run_usage (
         run_id,
         input_tokens,
         output_tokens,
         cache_read_tokens,
         cache_creation_tokens,
         total_tokens,
         cost_usd,
         num_turns,
         assistant_message_count,
         accounting_version,
         coverage
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
      rollup.accountingVersion,
      rollup.coverage,
    ) as { changes?: number } | undefined;
  return info?.changes ?? 0;
}

/**
 * Compute and persist (upsert) the token/cost rollup for a single terminated run.
 *
 * DELETEs any prior `run_usage` row for the run FIRST (see the module header),
 * then computes the rollup via the force-scan
 * `selectRunUsageRollupsFromRawEvents(db, [runId], logger)[0]` and writes it
 * with {@link writeRunUsageRow} (`INSERT OR REPLACE`) so a re-terminal
 * transition or a resumed run re-rolling up overwrites the prior row
 * idempotently.
 *
 * Synchronous + `void`: it is fired at a lifecycle seam where the caller does
 * not await a result, and it must not surface errors — see the fail-soft
 * contract in the module header. Any throw is caught and logged via
 * `logger?.warn` with runId context; the function never re-throws.
 *
 * @param db     - Narrow DatabaseLike surface (same one threaded to the executor).
 * @param runId  - The run that just reached a terminal seam.
 * @param logger - Optional structured logger; warn-on-failure is gated on it
 *                 (CODE-PATTERNS.md: pass it through from the enclosing scope, never omit).
 */
export function rollupRunUsage(db: DatabaseLike, runId: string, logger?: LoggerLike): void {
  try {
    // Drop any prior materialized row FIRST: a crash between this DELETE and the
    // INSERT below leaves no row, which Insights' read path re-derives from
    // raw_events — never a stale one. A missing row here is a no-op DELETE. See
    // the module header.
    db.prepare(`DELETE FROM run_usage WHERE run_id = ?`).run(runId);

    // The force-scan helper always returns one (possibly zeroed) row per
    // requested id, so [0] is non-null here. The `?? null` guard is purely
    // defensive against a future signature change. The logger receives the
    // fold's diagnostics (usageFold.ts).
    const rollup = selectRunUsageRollupsFromRawEvents(db, [runId], logger)[0] ?? null;
    if (rollup === null) {
      // Should be unreachable (the helper seeds a zero row per requested id), but
      // bail without writing rather than INSERTing a half-formed row.
      logger?.warn('[runUsageRollup] selectRunUsageRollupsFromRawEvents returned no row (skipping upsert)', {
        runId,
      });
      return;
    }

    // INSERT OR REPLACE keyed on run_id (PK); computed_at takes its DEFAULT
    // (CURRENT_TIMESTAMP) on every (re-)materialization.
    writeRunUsageRow(db, rollup, 'replace');
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
