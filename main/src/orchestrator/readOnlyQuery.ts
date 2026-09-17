/**
 * readOnlyQuery — the shared read-only SQL executor
 * (docs/proposals/CUSTOM-VIEWS.md §4.1).
 *
 * EXTRACTED VERBATIM from `mcpServer/mcpQueryHandler.ts` (the S0.4 global-agent
 * `cyboflow_db_query` validator + its readonly sibling connection and iterate
 * loop) so the custom-views widget engine executes user SQL through exactly the
 * same guarantees the assistant's tool does, rather than a second
 * implementation that can drift from it.
 *
 * Two layers of defence, unchanged by the move:
 *   1. `validateReadonlySql` — pure statement-shape validation. Defense in
 *      DEPTH only; it throws nothing and is not the read-only guarantee.
 *   2. `openReadonlySibling` — a dedicated `{ readonly: true }` better-sqlite3
 *      connection to the same file. SQLite itself refuses every write through
 *      it, whatever slips past the validator.
 *
 * Two profiles:
 *   - `agent`  — today's rules verbatim (SELECT / WITH / EXPLAIN readers, no
 *     ATTACH / PRAGMA, single statement).
 *   - `widget` — the agent rules PLUS two refusals a widget has no use for: a
 *     leading `EXPLAIN` (a widget must return data, not a plan) and any
 *     `WITH RECURSIVE` (the one construct that can spin indefinitely before
 *     producing a first row, with no data-size bound to stop it).
 *
 * This module may import better-sqlite3: mcpQueryHandler.ts, its only
 * pre-existing consumer inside the standalone MCP bundle's reach, already does.
 */
import BetterSqlite3Database from 'better-sqlite3';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Limits — the agent profile's caps (cyboflow_db_query). Widget callers pass
// their own from shared/types/customViews WIDGET_LIMITS.
// ---------------------------------------------------------------------------

export const DB_QUERY_MAX_ROWS = 200;
export const DB_QUERY_MAX_PAYLOAD_BYTES = 100_000;
export const DB_QUERY_MAX_STRING_LEN = 2000;

/** The agent profile's limits as one bag, for callers that want the defaults. */
export const AGENT_QUERY_LIMITS: ReadonlyQueryLimits = {
  maxRows: DB_QUERY_MAX_ROWS,
  maxPayloadBytes: DB_QUERY_MAX_PAYLOAD_BYTES,
  maxStringLen: DB_QUERY_MAX_STRING_LEN,
};

// ---------------------------------------------------------------------------
// Statement-shape validation
// ---------------------------------------------------------------------------

const READER_KEYWORD_RE = /^(SELECT|WITH|EXPLAIN)\b/i;
const FORBIDDEN_KEYWORD_RE = /\b(ATTACH|PRAGMA)\b/i;
const LEADING_EXPLAIN_RE = /^EXPLAIN\b/i;
const RECURSIVE_CTE_RE = /\bWITH\s+RECURSIVE\b/i;

/** Which rule set `validateReadonlySql` applies. */
export type ReadonlySqlProfile = 'agent' | 'widget';

/** Machine-readable refusal reasons; every one is surfaced to the caller verbatim. */
export type ReadonlySqlRejection =
  | 'empty_sql'
  | 'not_a_select'
  | 'multiple_statements'
  | 'forbidden_keyword'
  | 'explain_not_allowed'
  | 'recursive_not_allowed';

export type ReadonlySqlValidation = { ok: true; sql: string } | { ok: false; reason: ReadonlySqlRejection };

/** Strips leading whitespace and leading `--`/`/* *\/` comments (repeatedly,
 * since a query may open with several comment lines before the keyword). */
export function stripLeadingSqlComments(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      s = nl === -1 ? '' : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end === -1 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

/**
 * True when non-whitespace, non-comment SQL content follows the first
 * top-level `;` — i.e. more than one statement was submitted. Skips over
 * single-quoted string literals (SQL's `''` escape) and comments while
 * scanning so a `;` inside a string literal doesn't false-positive.
 */
export function hasTrailingStatement(sql: string): boolean {
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") { inString = true; i += 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') {
      return stripLeadingSqlComments(sql.slice(i + 1)).length > 0;
    }
    i += 1;
  }
  return false;
}

/**
 * Validate a statement's SHAPE. Pure, throws nothing.
 *
 * The `agent` profile (the default) is the pre-extraction behaviour verbatim,
 * including the order the rejections are evaluated in — `mcpDbQuery.test.ts`
 * pins that an `ATTACH` after a `;` reports `forbidden_keyword` rather than
 * `multiple_statements`.
 */
export function validateReadonlySql(
  rawSql: unknown,
  opts?: { profile?: ReadonlySqlProfile },
): ReadonlySqlValidation {
  if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return { ok: false, reason: 'empty_sql' };
  }
  const stripped = stripLeadingSqlComments(rawSql);
  if (stripped.length === 0) {
    return { ok: false, reason: 'empty_sql' };
  }
  if (!READER_KEYWORD_RE.test(stripped)) {
    return { ok: false, reason: 'not_a_select' };
  }
  // Scanned over the WHOLE raw string (not just the stripped head) — ATTACH /
  // PRAGMA are rejected wherever they appear, including mid-statement.
  if (FORBIDDEN_KEYWORD_RE.test(rawSql)) {
    return { ok: false, reason: 'forbidden_keyword' };
  }
  if (hasTrailingStatement(rawSql)) {
    return { ok: false, reason: 'multiple_statements' };
  }
  if ((opts?.profile ?? 'agent') === 'widget') {
    // A widget renders rows; an EXPLAIN returns a plan its shapes cannot draw.
    if (LEADING_EXPLAIN_RE.test(stripped)) {
      return { ok: false, reason: 'explain_not_allowed' };
    }
    // Word-boundary approximation: a `WITH RECURSIVE` inside a string literal
    // would also trip this. Refusing that false positive is the safe direction
    // (the author rewrites the literal), and no cheap parse distinguishes them.
    if (RECURSIVE_CTE_RE.test(stripped)) {
      return { ok: false, reason: 'recursive_not_allowed' };
    }
  }
  return { ok: true, sql: rawSql };
}

// ---------------------------------------------------------------------------
// Row-value sanitization
// ---------------------------------------------------------------------------

/** Row-value sanitization shared by every read-only query result path. */
export function sanitizeDbQueryValue(value: unknown, maxStringLen: number = DB_QUERY_MAX_STRING_LEN): unknown {
  if (typeof value === 'string') {
    return value.length > maxStringLen ? `${value.slice(0, maxStringLen)}…[truncated]` : value;
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<blob ${value.length} bytes>`;
  }
  return value;
}

export function sanitizeDbQueryRow(
  row: Record<string, unknown>,
  maxStringLen: number = DB_QUERY_MAX_STRING_LEN,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sanitizeDbQueryValue(value, maxStringLen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Readonly sibling connections
// ---------------------------------------------------------------------------

/**
 * One readonly handle per on-disk database path, shared by every caller in the
 * process (the MCP `cyboflow_db_query` handler and the widget data service both
 * point at the same `sessions.db`). Handles live for the process lifetime,
 * mirroring the main write connection; `closeReadonlySiblings` exists for tests.
 */
const readonlySiblings = new Map<string, BetterSqlite3Database.Database>();

/**
 * Returns the cached readonly sibling connection for `db`'s file, opening it on
 * first use. Throws (never returns a connection able to write) when `db.name`
 * is absent/empty or ':memory:' — an in-memory or adapter-less DatabaseLike has
 * no on-disk file for a sibling connection to point at (the common shape in
 * unit tests that don't go through makeDatabaseLike / dbAdapter). Read-only is
 * enforced BY CONSTRUCTION via `{ readonly: true }`.
 */
export function openReadonlySibling(db: DatabaseLike): BetterSqlite3Database.Database {
  const dbPath = db.name;
  if (!dbPath || dbPath === ':memory:') {
    throw new Error('db_query_unavailable: no on-disk database file for this connection');
  }
  const cached = readonlySiblings.get(dbPath);
  // A test that closes the handle out from under the cache (mcpDbQuery.test.ts
  // does, to release the file lock on Windows) must not poison the entry.
  if (cached && cached.open) return cached;
  const opened = new BetterSqlite3Database(dbPath, { readonly: true, fileMustExist: true });
  readonlySiblings.set(dbPath, opened);
  return opened;
}

/** Close and forget every cached readonly handle. Test-only cleanup. */
export function closeReadonlySiblings(): void {
  for (const handle of readonlySiblings.values()) {
    if (handle.open) handle.close();
  }
  readonlySiblings.clear();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Output caps for one query run. `maxRowBytes` is widget-only (see below). */
export interface ReadonlyQueryLimits {
  maxRows: number;
  maxPayloadBytes: number;
  maxStringLen: number;
  /**
   * When set, a SINGLE row larger than this fails the whole query with
   * `row_too_large` instead of being returned. The agent profile omits it and
   * keeps today's behaviour (an oversized row is returned, and the payload cap
   * stops the ones after it).
   */
  maxRowBytes?: number;
}

export interface ReadonlyQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  tookMs: number;
  /** Present ONLY on the non-reader short-circuit, whose reply carries it. */
  note?: string;
}

/** Values SQLite can bind. Booleans are coerced to 1/0 by `coerceBindParams`. */
export type BindableParams = Record<string, string | number | null>;

const MISSING_NAMED_PARAM_RE = /Missing named parameter "([^"]+)"/;

/**
 * Coerce resolved source params into SQLite-bindable values: booleans become
 * 1/0, strings / numbers / null pass through. Arrays and objects are rejected
 * by spec validation long before this point; the throw is defensive so an
 * unbindable value fails with a named reason instead of better-sqlite3's
 * generic type error.
 */
export function coerceBindParams(params: Record<string, unknown>): BindableParams {
  const out: BindableParams = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'boolean') {
      out[name] = value ? 1 : 0;
    } else if (typeof value === 'string' || typeof value === 'number' || value === null) {
      out[name] = value;
    } else {
      throw new Error(`unbindable_param:${name}`);
    }
  }
  return out;
}

/**
 * Prepare and run one validated read-only statement on `handle`, applying the
 * early-stop caps.
 *
 * A non-reader statement (e.g. `WITH x AS (SELECT 1) INSERT ...`, which the
 * shape validator accepts) is NEVER executed — calling `.run()` is exactly the
 * write attempt the readonly connection exists to prevent — so it short-circuits
 * to an empty result carrying `note`.
 *
 * Errors are left to propagate (unreachable file, SQLite syntax errors, unknown
 * tables, SQLite's own readonly-write refusal); callers turn them into their own
 * structured replies. The one translation is better-sqlite3's
 * `Missing named parameter "x"`, re-raised as `missing_param:x`.
 */
export function runReadonlyQuery(
  handle: BetterSqlite3Database.Database,
  sql: string,
  params: BindableParams,
  limits: ReadonlyQueryLimits,
): ReadonlyQueryResult {
  const startedAt = Date.now();
  const stmt = handle.prepare(sql);

  if (!stmt.reader) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      tookMs: Date.now() - startedAt,
      note: 'statement returned no rows',
    };
  }

  const columns = stmt.columns().map((c) => c.name);
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  let payloadBytes = 0;

  // The bag is ALWAYS passed, even when empty: better-sqlite3 tolerates `{}`
  // on a statement with no parameters, and it is what makes a missing binding
  // report the parameter's NAME (`Missing named parameter "flag"`) instead of
  // the nameless `Missing named parameters` the no-argument form raises.
  try {
    for (const rawRow of stmt.iterate(params)) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        break;
      }
      const sanitized = sanitizeDbQueryRow(rawRow as Record<string, unknown>, limits.maxStringLen);
      const size = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
      if (limits.maxRowBytes !== undefined && size > limits.maxRowBytes) {
        throw new Error('row_too_large');
      }
      if (rows.length > 0 && payloadBytes + size > limits.maxPayloadBytes) {
        truncated = true;
        break;
      }
      rows.push(sanitized);
      payloadBytes += size;
    }
  } catch (err) {
    const translated = translateBindError(err);
    if (translated) throw translated;
    throw err;
  }

  return { columns, rows, rowCount: rows.length, truncated, tookMs: Date.now() - startedAt };
}

/**
 * Map better-sqlite3's missing-parameter message onto a stable reason code.
 * Returns null for every other error so the caller rethrows the ORIGINAL —
 * SQLite errors carry a `.code` the handlers' replies quote.
 */
function translateBindError(err: unknown): Error | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = MISSING_NAMED_PARAM_RE.exec(message);
  return match ? new Error(`missing_param:${match[1]}`) : null;
}

/**
 * `EXPLAIN QUERY PLAN <sql>`'s `detail` lines, verbatim. Advisory only: any
 * failure (a statement the planner refuses, a closed handle) yields `[]` rather
 * than failing the query it was describing.
 */
export function collectQueryPlan(
  handle: BetterSqlite3Database.Database,
  sql: string,
  params: BindableParams,
): string[] {
  try {
    const stmt = handle.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    const rows = stmt.all(params) as Array<{ detail?: unknown }>;
    return rows.map((row) => (typeof row.detail === 'string' ? row.detail : '')).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
