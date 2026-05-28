/**
 * runUnifiedMessagesListing — SELECT helper that reconstructs a run's chat
 * history as fully-correlated `UnifiedMessage[]` (tool_use folded together with
 * its matching tool_result), exactly like the quick-session path.
 *
 * Exports `selectRunUnifiedMessages(db, runId, logger?)` so the tRPC
 * `cyboflow.runs.listUnifiedMessages` procedure has a testable,
 * framework-free implementation.
 *
 * Source of truth: the raw_events table (same table `selectRunMessages` reads).
 * Where `selectRunMessages` is a TEXT-ONLY reducer, this helper runs every
 * stored event through the SAME projection pipeline the live stream uses —
 * `TypedEventNarrowing` + `MessageProjection` — producing the rich, correlated
 * shape the renderer's RichOutputView consumes.
 *
 * Pattern note: this mirrors `projectStoredOutputs` in main/src/ipc/session.ts
 * (the quick-session path) but reads from raw_events keyed by runId instead of
 * session_outputs keyed by panelId. MessageProjection is id-agnostic, so the
 * `runId` is used directly as its correlation key.
 *
 * Import note: this file imports `MessageProjection`/`TypedEventNarrowing` from
 * `../services/streamParser`. That is the SAME import the sibling orchestrator
 * file `runEventBridge.ts` uses — the streamParser barrel only re-exports
 * classes whose own imports are limited to `shared/types` + the barrel's local
 * `./types`, so it does NOT pull in 'electron', 'better-sqlite3', or a concrete
 * service. The stricter "no services/* import" comment on `runMessagesListing.ts`
 * is per-file; this helper is deliberately a separate sibling so that file's
 * invariant stays intact.
 *
 * Logger note (per project CLAUDE.md): the optional `logger` is THREADED into
 * both `TypedEventNarrowing` and `MessageProjection` — omitting it would silently
 * turn their observability into a no-op. `LoggerLike` has no `verbose` method, so
 * the call site adapts `verbose` to the logger's `debug` channel, matching the
 * adaptation in `runEventBridge.ts`.
 *
 * Ordering: created_at ASC, id ASC (tiebreaker) — same as `selectRunMessages`.
 */
import { MessageProjection, TypedEventNarrowing } from '../services/streamParser';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';
import type { DatabaseLike, LoggerLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface DbRawEventRow {
  id: number;
  runId: string;
  payloadJson: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the reconstructed chat history for `runId` as correlated
 * `UnifiedMessage[]`, oldest-first.
 *
 * Reads ALL raw_events rows for the run (every event_type — the projection
 * pipeline itself decides what renders) and folds them through
 * `TypedEventNarrowing` + `MessageProjection`. Events that project to `null`
 * (e.g. user/tool_result rows, stream_event deltas, unknown variants) are
 * absorbed into projection state and filtered out of the result, while their
 * correlation data (tool_result → tool_use) is retained so the matching
 * assistant tool_call message carries its result.
 *
 * The persisted `created_at` timestamp overwrites MessageProjection's
 * `new Date()` default so UI ordering reflects actual run time.
 *
 * @param db     - Narrow DatabaseLike interface (real or test mock).
 * @param runId  - The workflow_runs.id to scope the query AND the projection key.
 * @param logger - Optional structured logger; threaded into the projection
 *                 pipeline so warnings/verbose diagnostics are not silently
 *                 dropped.
 * @returns UnifiedMessage[] sorted by created_at ASC, id ASC.
 */
export function selectRunUnifiedMessages(
  db: DatabaseLike,
  runId: string,
  logger?: LoggerLike,
): UnifiedMessage[] {
  const rows = db
    .prepare(
      `SELECT
         re.id           AS id,
         re.payload_json AS payloadJson,
         re.run_id       AS runId,
         re.created_at   AS createdAt
       FROM raw_events re
       WHERE re.run_id = ?
       ORDER BY re.created_at ASC, re.id ASC`,
    )
    .all(runId) as DbRawEventRow[];

  // Thread the logger into BOTH pipeline stages. LoggerLike has no `verbose`
  // method (TypedEventNarrowing expects one), so adapt verbose -> debug; the
  // logger's own `warn` satisfies MessageProjection's Pick<ILogger, 'warn'>.
  const narrowingLogger = logger ? { verbose: (m: string) => logger.debug(m) } : undefined;
  const projectionLogger = logger ? { warn: (m: string) => logger.warn(m) } : undefined;

  const narrower = new TypedEventNarrowing(narrowingLogger);
  const projection = new MessageProjection(runId, projectionLogger);

  const result: UnifiedMessage[] = [];

  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson);
    } catch {
      // Unparseable persisted payload — skip (defensive; sink writes valid JSON).
      continue;
    }

    const event = narrower.narrow(raw);
    const projected = projection.project(event);
    if (projected !== null) {
      // Overwrite the MessageProjection-generated timestamp with the persisted one.
      result.push({ ...projected, timestamp: new Date(row.createdAt).toISOString() });
    }
  }

  return result;
}
