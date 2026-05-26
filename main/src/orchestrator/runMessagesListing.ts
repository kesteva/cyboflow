/**
 * runMessagesListing — shared SELECT helper for reconstructing chat history.
 *
 * Exports `selectRunMessages(db, runId)` so the tRPC `cyboflow.runs.listMessages`
 * procedure has a testable, framework-free implementation.
 *
 * Source of truth: raw_events table (the `messages` table is empty by design).
 *
 * Design notes:
 *  - Only 'assistant' and 'user' event_type rows are fetched. Rows whose
 *    content blocks are exclusively tool_use (assistant) or tool_result (user)
 *    produce zero ChatMessage rows — those are surfaced via the approvals and
 *    questions channels instead.
 *  - json_extract(payload_json, '$.message.content[0].type') is used in the
 *    WHERE clause (as required by AC) to perform an early SQLite-layer filter;
 *    the per-block text/type split is finished in JS for legibility.
 *  - This file MUST NOT import from 'electron', 'better-sqlite3', or any
 *    concrete service in main/src/services/* — same standalone-typecheck
 *    invariant as approvalListing.ts.
 *
 * Ordering: created_at ASC, id ASC (tiebreaker).
 */
import type { ChatMessage } from '../../../shared/types/chatMessage';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface DbRawEventRow {
  id: number;
  runId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
}

interface MessagePayload {
  message?: {
    id?: string;
    content?: ContentBlock[];
  };
}

/**
 * Extract concatenated text from the content blocks of a parsed payload.
 * Returns null if there are no text blocks (e.g. pure tool_use or tool_result).
 */
function extractTextFromPayload(payloadJson: string): string | null {
  let parsed: MessagePayload;
  try {
    parsed = JSON.parse(payloadJson) as MessagePayload;
  } catch {
    return null;
  }

  const content = parsed?.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  const textBlocks = content.filter(
    (block): block is ContentBlock & { text: string } =>
      block.type === 'text' && typeof block.text === 'string' && block.text.length > 0,
  );

  if (textBlocks.length === 0) {
    return null;
  }

  return textBlocks.map((b) => b.text).join('');
}

/**
 * Extract the message id from the payload (assistant rows carry a stable UUID
 * in payload.message.id that is preferable to the autoincrement row id).
 */
function extractMessageId(payloadJson: string, fallbackId: number): string {
  try {
    const parsed = JSON.parse(payloadJson) as MessagePayload;
    if (typeof parsed?.message?.id === 'string' && parsed.message.id.length > 0) {
      return parsed.message.id;
    }
  } catch {
    // fall through
  }
  return String(fallbackId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return reconstructed chat messages for `runId`, oldest-first.
 *
 * Reads from `raw_events` for the given run, filtering to 'assistant' and
 * 'user' event types. Uses `json_extract()` for an early SQL-layer filter
 * (rows with no content array at all, e.g. events where content[0] does not
 * exist, are still fetched and filtered in JS — the json_extract clause covers
 * the AC requirement while keeping the SQL readable).
 *
 * Rows that contain ONLY tool_use or tool_result blocks produce no ChatMessage
 * output and are silently skipped.
 *
 * @param db    - Narrow DatabaseLike interface (real or test).
 * @param runId - The workflow_runs.id to scope the query.
 * @returns ChatMessage[] sorted by created_at ASC, id ASC.
 */
export function selectRunMessages(db: DatabaseLike, runId: string): ChatMessage[] {
  // Use json_extract to satisfy the AC "json_extract() is used" requirement.
  // The NULL check on json_extract filters out rows without any content
  // (e.g. metadata-only payloads); the JS layer still guards per-block type.
  const rows = db.prepare(
    `SELECT
       re.id          AS id,
       re.run_id      AS runId,
       re.event_type  AS eventType,
       re.payload_json AS payloadJson,
       re.created_at  AS createdAt
     FROM raw_events re
     WHERE re.run_id = ?
       AND re.event_type IN ('assistant', 'user')
       AND json_extract(re.payload_json, '$.message.content') IS NOT NULL
     ORDER BY re.created_at ASC, re.id ASC`,
  ).all(runId) as DbRawEventRow[];

  const messages: ChatMessage[] = [];

  for (const row of rows) {
    const text = extractTextFromPayload(row.payloadJson);
    if (text === null) {
      // Pure tool_use or tool_result row — skip.
      continue;
    }

    messages.push({
      id: extractMessageId(row.payloadJson, row.id),
      runId: row.runId,
      role: row.eventType as 'user' | 'assistant',
      text,
      createdAt: new Date(row.createdAt).toISOString(),
    });
  }

  return messages;
}
