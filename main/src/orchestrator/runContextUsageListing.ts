/**
 * runContextUsageListing — SELECT helper that recovers a run's context-usage
 * numbers from the persisted `raw_events` log, so the Chat meta strip's
 * token/context-% ticker can BACKFILL when a run view is (re)opened.
 *
 * The renderer's live deriver (`frontend .../unified/runContextUsage.ts`) reads
 * the in-memory `cyboflowStore.streamEvents` buffer, which starts empty on every
 * run activation — so after switching views (or reopening the app) the meter
 * showed "--" until BOTH a fresh `assistant` event (numerator) AND a fresh
 * `result` event (denominator, step-boundary only) happened to arrive live.
 * This helper reads the same two facts straight from `raw_events`:
 *
 *   - usedTokens    — the NEWEST `assistant` event's `message.usage` partition
 *                     sum (input + cache_read + cache_creation ≈ live prompt
 *                     size). Same numerator rule as the live deriver.
 *   - contextWindow — the NEWEST `result` event's
 *                     `modelUsage.<model>.contextWindow`. Same denominator rule
 *                     (a result's own token counts are cumulative over the whole
 *                     run and deliberately NOT used).
 *
 * Both scans are bounded (`LIMIT`) newest-first raw JSON reads — no
 * TypedEventNarrowing pass, because only two well-known fields are consulted
 * and a malformed row simply falls through to the next (fail-soft). Either
 * field is null when no qualifying event exists yet.
 *
 * Standalone-typecheck invariant: DatabaseLike only — no electron /
 * better-sqlite3 / concrete-service imports.
 */
import type { DatabaseLike } from './types';

/** The recovered context-usage facts; either side is null when not yet known. */
export interface RunContextUsage {
  usedTokens: number | null;
  contextWindow: number | null;
}

/** Newest-first scan bounds — generous enough to skip malformed/usage-less rows. */
const ASSISTANT_SCAN_LIMIT = 50;
const RESULT_SCAN_LIMIT = 10;

interface DbPayloadRow {
  payloadJson: string;
}

function parseRow(row: DbPayloadRow): unknown {
  try {
    return JSON.parse(row.payloadJson);
  } catch {
    return null;
  }
}

/** Sum the disjoint usage partitions of one assistant `message.usage`, or null. */
function assistantUsedTokens(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = (payload as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const sum =
    num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  return sum > 0 ? sum : null;
}

/** Extract the first positive `contextWindow` from a result's `modelUsage`, or null. */
function resultContextWindow(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const modelUsage = (payload as Record<string, unknown>).modelUsage;
  if (typeof modelUsage !== 'object' || modelUsage === null) return null;
  for (const modelData of Object.values(modelUsage)) {
    if (typeof modelData !== 'object' || modelData === null) continue;
    const cw = (modelData as Record<string, unknown>).contextWindow;
    if (typeof cw === 'number' && cw > 0) return cw;
  }
  return null;
}

/**
 * Recover the run's latest context-usage facts from `raw_events`, newest-first.
 * Same numerator/denominator rules as the renderer's live deriver (see header).
 */
export function selectRunContextUsage(db: DatabaseLike, runId: string): RunContextUsage {
  const assistantRows = db
    .prepare(
      `SELECT payload_json AS payloadJson
       FROM raw_events
       WHERE run_id = ? AND event_type = 'assistant'
       ORDER BY id DESC
       LIMIT ${ASSISTANT_SCAN_LIMIT}`,
    )
    .all(runId) as DbPayloadRow[];

  let usedTokens: number | null = null;
  for (const row of assistantRows) {
    usedTokens = assistantUsedTokens(parseRow(row));
    if (usedTokens !== null) break;
  }

  const resultRows = db
    .prepare(
      `SELECT payload_json AS payloadJson
       FROM raw_events
       WHERE run_id = ? AND event_type = 'result'
       ORDER BY id DESC
       LIMIT ${RESULT_SCAN_LIMIT}`,
    )
    .all(runId) as DbPayloadRow[];

  let contextWindow: number | null = null;
  for (const row of resultRows) {
    contextWindow = resultContextWindow(parseRow(row));
    if (contextWindow !== null) break;
  }

  return { usedTokens, contextWindow };
}
