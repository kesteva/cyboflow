/**
 * runRawEventsListing — SELECT helper that rebuilds a run's RAW stream-event
 * log as `StreamEnvelope[]`, the SAME envelope shape the live IPC bridge
 * (`runEventBridge.ts`) publishes to the renderer. This lets the Data Stream
 * tab BACKFILL its history when a run is reopened, instead of starting empty
 * (the in-memory `cyboflowStore.streamEvents` buffer is wiped on every
 * `setActiveRun`, so without backfill, clicking away and returning erased the
 * stream — the renderer-side twin of the chat-history problem that
 * `selectRunUnifiedMessages` solved for the Chat tab).
 *
 * Contrast with `selectRunUnifiedMessages` (the sibling chat-history helper):
 * that one FOLDS events into correlated `UnifiedMessage[]` (tool_use + result
 * merged, deltas absorbed). This helper preserves EVERY persisted event 1:1
 * (including `stream_event` deltas and unknown variants) and only narrows +
 * classifies each, mirroring the bridge's per-event envelope construction at
 * `runEventBridge.ts:245-249`:
 *
 *   { type: deriveEventType(typed), payload: typed, timestamp }
 *
 * Source of truth: `raw_events` — same table and ORDER BY (created_at ASC,
 * id ASC) as `selectRunUnifiedMessages`. The persisted `created_at` overwrites
 * the live `new Date()` timestamp so the backfilled log reflects run time.
 *
 * Import note: imports `TypedEventNarrowing` + `deriveEventType` from the
 * `../services/streamParser` barrel — the same safe barrel `runEventBridge.ts`
 * and `runUnifiedMessagesListing.ts` use (no 'electron' / 'better-sqlite3' /
 * concrete-service pull-in).
 *
 * Logger note (per project CLAUDE.md): the optional `logger` is THREADED into
 * `TypedEventNarrowing` (adapting `verbose` → `debug`, as `LoggerLike` has no
 * `verbose`) so its diagnostics are not silently dropped.
 */
import { TypedEventNarrowing, deriveEventType } from '../services/streamParser';
import type { StreamEnvelope, StreamEventType } from '../../../shared/types/claudeStream';
import type { DatabaseLike, LoggerLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface DbRawEventRow {
  id: number;
  payloadJson: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the run's full raw stream-event log as `StreamEnvelope[]`, oldest-first.
 *
 * Every `raw_events` row for `runId` is narrowed and classified into the same
 * `{ type, payload, timestamp }` envelope the live bridge publishes, so the
 * renderer's `RunView` can render a reopened run identically to its live feed.
 *
 * @param db     - Narrow DatabaseLike interface (real or test mock).
 * @param runId  - The workflow_runs.id to scope the query.
 * @param logger - Optional structured logger; threaded into the narrowing stage.
 * @returns StreamEnvelope[] sorted by created_at ASC, id ASC.
 */
export function selectRunRawStreamEvents(
  db: DatabaseLike,
  runId: string,
  logger?: LoggerLike,
): StreamEnvelope[] {
  const rows = db
    .prepare(
      `SELECT
         re.id           AS id,
         re.payload_json AS payloadJson,
         re.created_at   AS createdAt
       FROM raw_events re
       WHERE re.run_id = ?
       ORDER BY re.created_at ASC, re.id ASC`,
    )
    .all(runId) as DbRawEventRow[];

  // LoggerLike has no `verbose` (TypedEventNarrowing expects one) — adapt to debug.
  const narrowingLogger = logger ? { verbose: (m: string) => logger.debug(m) } : undefined;
  const narrower = new TypedEventNarrowing(narrowingLogger);

  const result: StreamEnvelope[] = [];

  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson);
    } catch {
      // Unparseable persisted payload — skip (defensive; sink writes valid JSON).
      continue;
    }

    const typed = narrower.narrow(raw);
    // Same single audited cast as the bridge's envelope construction
    // (runEventBridge.ts:245): deriveEventType returns string, and the
    // {type, payload} cross-product is correct by construction but not
    // inferable without per-arm predicates.
    result.push({
      type: deriveEventType(typed) as StreamEventType,
      payload: typed,
      timestamp: new Date(row.createdAt).toISOString(),
    } as StreamEnvelope);
  }

  return result;
}
