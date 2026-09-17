/**
 * globalAgentToolHandlers — the cyboflow_db_query / cyboflow_fs_read /
 * cyboflow_fs_list / cyboflow_fs_grep / cyboflow_history MCP handler family,
 * extracted from mcpQueryHandler.ts (GitHub issue #19, the god-file split,
 * step 3).
 *
 * A CLASS rather than free functions (contrast workflowConfigHandlers.ts):
 * this family owns process-lifetime state, the lazily-opened readonly sibling
 * sqlite connection (`globalAgentReadonlyDb`), which must stay cached for the
 * life of the handler rather than being rebuilt per call. Bodies below are
 * moved verbatim apart from the mechanical `this.x` -> `this.ctx.x` rewrite;
 * calls among the moved methods stay `this.x(`.
 */

import * as net from 'net';
import * as path from 'path';
import { readFileSync, realpathSync, statSync, lstatSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import type { Dirent, Stats } from 'fs';
import BetterSqlite3Database from 'better-sqlite3';
import {
  AGENT_QUERY_LIMITS,
  openReadonlySibling,
  runReadonlyQuery,
  validateReadonlySql,
} from '../../readOnlyQuery';
import type { DatabaseLike, LoggerLike } from '../../types';
import type { McpQueryMessage, McpQueryResponse, McpQueryHandlerDeps } from '../mcpQueryMessages';
import { resolveGlobalAgentContext } from '../globalAgentContext';
import {
  isPathWithinRoots,
  isSecretPath,
  bufferLooksBinary,
  compileBasenameGlob,
  matchesBasenameGlob,
  FS_READ_MAX_BYTES,
  FS_LIST_MAX_ENTRIES,
  FS_GREP_MAX_RESULTS,
  FS_GREP_MAX_FILES,
  FS_GREP_MAX_LINE_LEN,
  FS_GREP_MAX_FILE_BYTES,
  BINARY_SNIFF_BYTES,
  GREP_SKIP_DIRS,
} from '../fsAccessGuard';
import { extractTurnText, excerptAround, truncateHead, TURN_TEXT_MAX_CHARS } from '../../agentThread/transcriptSearch';

/**
 * Everything the global-agent tool handlers need from McpQueryHandler, built
 * once in its constructor and reused for every call (see `globalAgentTools`
 * there).
 */
export interface GlobalAgentToolContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
}

// ---------------------------------------------------------------------------
// cyboflow_history caps (mcp-history). The transcript table grows without
// bound — it is the assistant's permanent memory — so every read of it is
// bounded on FOUR independent axes: how many turns come back (limit), how many
// rows may be examined to find them (scan cap), how many rows are pulled per
// round-trip (batch), and how large the serialized reply may get (payload
// ceiling). Whichever binds first stops the walk and sets `truncated`, with
// `nextBeforeId` telling the caller exactly where to resume.
// ---------------------------------------------------------------------------

/** Default number of turns returned when the caller passes no `limit`. */
const HISTORY_DEFAULT_LIMIT = 20;
/** Hard ceiling on `limit` — a memory search is a lookup, not a bulk export. */
const HISTORY_MAX_LIMIT = 50;
/** Rows fetched per SQL round-trip while paging id-descending. */
const HISTORY_BATCH_ROWS = 500;
/** Rows examined before the walk gives up (mostly-plumbing threads page fast). */
const HISTORY_MAX_SCAN_ROWS = 10_000;
/** Serialized-turn budget for one reply, mirroring cyboflow_db_query's ceiling. */
const HISTORY_MAX_PAYLOAD_BYTES = 100_000;
/**
 * Ceiling on `daysBack` (~100 years). Not a usability limit — a guard against
 * SQLite's datetime() overflow: datetime('now', '-N days') silently returns
 * NULL once N leaves the julian-day range (measured: N=3,650,000 → NULL), and
 * `created_at >= NULL` filters out EVERY row, so an assistant reaching for a
 * huge number to mean "search everything" would get a confident false
 * "no memory of it". Clamped, the widest window just includes the whole table.
 */
const HISTORY_MAX_DAYS_BACK = 36_500;

/** One row of the transcript scan (the four columns mcp-history selects). */
interface AgentThreadEventScanRow {
  id: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

/** One turn as returned to the assistant by cyboflow_history. */
interface HistoryTurn {
  eventId: number;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  /** Present (true) only in search mode, where `text` is a match excerpt. */
  matched?: boolean;
}

export class GlobalAgentToolHandlers {
  /**
   * Lazily-opened, cached readonly sibling connection backing
   * cyboflow_db_query (mcp-db-query). Opened once on first use against
   * `this.ctx.db.name` (the on-disk file path the injected DatabaseLike
   * wraps) and reused for the process lifetime.
   */
  private globalAgentReadonlyDb: BetterSqlite3Database.Database | null = null;

  constructor(private readonly ctx: GlobalAgentToolContext) {}

  /**
   * Returns the cached readonly sibling connection, opening it on first use.
   * Throws (never returns a connection able to write) when `this.ctx.db.name` is
   * absent/empty or ':memory:' — an in-memory or adapter-less DatabaseLike
   * has no on-disk file for a sibling connection to point at (this is the
   * common shape in unit tests that don't go through makeDatabaseLike/
   * dbAdapter). Read-only is enforced BY CONSTRUCTION by `openReadonlySibling`
   * via `{ readonly: true }` — SQLite itself refuses any write attempted
   * through this handle, independent of validateReadonlySql's statement-shape
   * checks. The handle is also cached on this instance because tests reach for
   * `globalAgentReadonlyDb` directly to release the file lock.
   */
  private getGlobalAgentReadonlyDb(): BetterSqlite3Database.Database {
    if (this.globalAgentReadonlyDb?.open) return this.globalAgentReadonlyDb;
    this.globalAgentReadonlyDb = openReadonlySibling(this.ctx.db);
    return this.globalAgentReadonlyDb;
  }

  handleAgentDbQuery(
    msg: Extract<McpQueryMessage, { type: 'mcp-db-query' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const validation = validateReadonlySql(msg.sql, { profile: 'agent' });
    if (!validation.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: validation.reason });
      return;
    }

    // Errors from here (unreachable db file, sqlite syntax errors, unknown
    // tables, or SQLite's own readonly-connection write refusal) are left to
    // propagate — handleMessage's outer try/catch turns them into a
    // structured ok:false response carrying sqlite's message, same as every
    // other handler in this file.
    const readonlyDb = this.getGlobalAgentReadonlyDb();
    const result = runReadonlyQuery(readonlyDb, validation.sql, {}, AGENT_QUERY_LIMITS);

    if (result.note !== undefined) {
      // A non-reader statement (e.g. a write form that slipped past
      // validateReadonlySql, such as `WITH x AS (SELECT 1) INSERT ...`) is
      // NEVER executed — calling .run() is exactly the write attempt the
      // readonly connection exists to prevent, so we simply decline rather
      // than let SQLite throw mid-write.
      this.ctx.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          note: result.note,
        },
      });
      return;
    }

    this.ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated },
    });
  }

  // --------------------------------------------------------------------------
  // Global-agent filesystem tools (cyboflow_fs_read / _list / _grep)
  //
  // READ-ONLY and FOLDER-SCOPED. Enforcement is entirely server-side here — the
  // agent's isolation contract (tools:[], PreToolUse allowing only
  // mcp__cyboflow__*) is untouched. The allowed roots are the registered
  // project paths PLUS the user-configured assistantFolderAccess extras; every
  // target is canonicalized with realpathSync and must land inside a
  // canonicalized root (defeating symlink escapes), and read/grep content
  // access additionally refuses secret files even when they are in scope.
  // --------------------------------------------------------------------------

  /**
   * The canonicalized set of folders the fs tools may read: every registered
   * `projects.path` plus every `getAssistantFolderAccess()` extra, each passed
   * through realpathSync (so a symlinked root is compared as its real target).
   * Roots that don't exist on disk are DROPPED rather than throwing — a stale
   * project row must never break the tools for the live folders. Cheap enough
   * to recompute per call (no caching).
   */
  private resolveFsAllowedRoots(): string[] {
    const raw = new Set<string>();
    // Project folders the user toggled off — subtracted from the project roots
    // below (compared by the raw stored path, exactly what the Settings UI
    // toggles off). Extras are never excluded.
    const excludedProjects = new Set(this.ctx.deps.getAssistantExcludedProjectPaths?.() ?? []);
    try {
      const rows = this.ctx.db.prepare('SELECT path FROM projects').all() as Array<{ path?: unknown }>;
      for (const row of rows) {
        if (typeof row.path === 'string' && row.path.length > 0 && !excludedProjects.has(row.path)) {
          raw.add(row.path);
        }
      }
    } catch {
      // A missing projects table (bare test fixture) simply yields no project
      // roots — the configured extras still apply.
    }
    const extras = this.ctx.deps.getAssistantFolderAccess?.() ?? [];
    for (const entry of extras) {
      if (typeof entry === 'string' && entry.length > 0) raw.add(entry);
    }
    const canonical: string[] = [];
    for (const root of raw) {
      try {
        canonical.push(realpathSync(root));
      } catch {
        // Skip a root that no longer exists — never throw.
      }
    }
    return canonical;
  }

  /**
   * Resolve + scope-check a requested path for the fs tools. Canonicalizes with
   * realpathSync (a nonexistent target throws → 'not_found') then requires the
   * real path to be inside one of the allowed roots (else 'scope_denied', whose
   * message names the roots so the model can self-correct). Shared by all three
   * fs handlers.
   */
  private resolveFsTarget(
    requestedPath: unknown,
  ):
    | { ok: true; real: string; roots: string[] }
    | { ok: false; error: string } {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      return { ok: false, error: 'invalid_arguments: path must be a non-empty string' };
    }
    const roots = this.resolveFsAllowedRoots();
    let real: string;
    try {
      real = realpathSync(requestedPath);
    } catch {
      return { ok: false, error: 'not_found' };
    }
    if (!isPathWithinRoots(real, roots)) {
      const rootList = roots.length > 0 ? roots.join(', ') : '(none registered)';
      return { ok: false, error: `scope_denied (allowed roots: ${rootList})` };
    }
    return { ok: true, real, roots };
  }

  /** True when a file's first BINARY_SNIFF_BYTES contain a NUL byte. */
  private fileLooksBinary(absPath: string): boolean {
    const fd = openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const read = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
      return bufferLooksBinary(buf.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  }

  handleFsRead(
    msg: Extract<McpQueryMessage, { type: 'mcp-fs-read' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const resolved = this.resolveFsTarget(msg.path);
    if (!resolved.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: resolved.error });
      return;
    }
    if (isSecretPath(resolved.real)) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'denied_secret_pattern' });
      return;
    }
    let stat: Stats;
    try {
      stat = statSync(resolved.real);
    } catch {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    if (stat.isDirectory()) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'is_a_directory' });
      return;
    }
    if (this.fileLooksBinary(resolved.real)) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'binary_file' });
      return;
    }

    const buffer = readFileSync(resolved.real);
    const totalBytes = buffer.length;

    // Line-window paging (1-based offsetLine) for large files, else a raw
    // byte-capped slice. Either way the returned content is floored at
    // FS_READ_MAX_BYTES with `truncated` set when content was dropped.
    let content: string;
    let truncated = false;
    const hasLineWindow =
      (typeof msg.offsetLine === 'number' && msg.offsetLine > 0) ||
      (typeof msg.limitLines === 'number' && msg.limitLines > 0);
    if (hasLineWindow) {
      const lines = buffer.toString('utf8').split('\n');
      const start = typeof msg.offsetLine === 'number' && msg.offsetLine > 0 ? msg.offsetLine - 1 : 0;
      const count = typeof msg.limitLines === 'number' && msg.limitLines > 0 ? msg.limitLines : lines.length;
      const windowText = lines.slice(start, start + count).join('\n');
      if (start + count < lines.length || start > 0) truncated = true;
      const windowBuf = Buffer.from(windowText, 'utf8');
      if (windowBuf.length > FS_READ_MAX_BYTES) {
        content = windowBuf.subarray(0, FS_READ_MAX_BYTES).toString('utf8');
        truncated = true;
      } else {
        content = windowText;
      }
    } else if (totalBytes > FS_READ_MAX_BYTES) {
      content = buffer.subarray(0, FS_READ_MAX_BYTES).toString('utf8');
      truncated = true;
    } else {
      content = buffer.toString('utf8');
    }

    this.ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { path: resolved.real, content, truncated, totalBytes },
    });
  }

  handleFsList(
    msg: Extract<McpQueryMessage, { type: 'mcp-fs-list' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const resolved = this.resolveFsTarget(msg.path);
    if (!resolved.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: resolved.error });
      return;
    }
    let stat: Stats;
    try {
      stat = statSync(resolved.real);
    } catch {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    if (!stat.isDirectory()) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_a_directory' });
      return;
    }

    // Listing is metadata-only (NOT secret-filtered): a secret file's name is
    // surfaced but its content stays unreachable via read/grep.
    const dirents = readdirSync(resolved.real, { withFileTypes: true });
    const entries: Array<{ name: string; type: 'file' | 'dir' | 'symlink'; size: number }> = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (entries.length >= FS_LIST_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      let type: 'file' | 'dir' | 'symlink';
      if (dirent.isSymbolicLink()) type = 'symlink';
      else if (dirent.isDirectory()) type = 'dir';
      else type = 'file';
      let size = 0;
      try {
        // lstat so a symlink (esp. a broken one) reports its own size, never
        // its (possibly out-of-scope / missing) target.
        size = lstatSync(path.join(resolved.real, dirent.name)).size;
      } catch {
        size = 0;
      }
      entries.push({ name: dirent.name, type, size });
    }

    this.ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { path: resolved.real, entries, truncated },
    });
  }

  handleFsGrep(
    msg: Extract<McpQueryMessage, { type: 'mcp-fs-grep' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    if (typeof msg.pattern !== 'string' || msg.pattern.length === 0) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_arguments: pattern must be a non-empty string' });
      return;
    }
    const resolved = this.resolveFsTarget(msg.path);
    if (!resolved.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: resolved.error });
      return;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(msg.pattern, msg.caseSensitive === true ? '' : 'i');
    } catch {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_regex' });
      return;
    }

    const maxResults = Math.max(
      1,
      Math.min(
        typeof msg.maxResults === 'number' && msg.maxResults > 0 ? Math.floor(msg.maxResults) : FS_GREP_MAX_RESULTS,
        FS_GREP_MAX_RESULTS,
      ),
    );
    const globRe = compileBasenameGlob(typeof msg.glob === 'string' ? msg.glob : '');

    const matches: Array<{ file: string; line: number; text: string }> = [];
    let filesScanned = 0;
    let truncated = false;

    // Grep a single file's content into `matches`. Returns false to signal the
    // caller to stop the whole walk (a cap was hit).
    const grepFile = (absPath: string): boolean => {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        return true; // unreadable — skip, keep walking
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
        const raw = lines[i];
        matches.push({
          file: absPath,
          line: i + 1,
          text: raw.length > FS_GREP_MAX_LINE_LEN ? `${raw.slice(0, FS_GREP_MAX_LINE_LEN)}…` : raw,
        });
      }
      return true;
    };

    // Depth-first walk with its OWN recursion — never follows symlinks (dir or
    // file) and skips GREP_SKIP_DIRS. Returns false when a cap stops the walk.
    const walk = (dir: string): boolean => {
      let dirents: Dirent[];
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return true; // unreadable dir — skip
      }
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue; // never follow symlinks
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (GREP_SKIP_DIRS.has(dirent.name)) continue;
          if (!walk(full)) return false;
          continue;
        }
        if (!dirent.isFile()) continue;
        if (!matchesBasenameGlob(dirent.name, globRe)) continue;
        if (isSecretPath(full)) continue; // deny content of secret files
        if (filesScanned >= FS_GREP_MAX_FILES) {
          truncated = true;
          return false;
        }
        filesScanned += 1;
        try {
          // Oversized files are skipped outright — grepFile reads the whole
          // file into memory, so a giant in-scope log must not balloon the
          // main process.
          if (lstatSync(full).size > FS_GREP_MAX_FILE_BYTES) continue;
          if (this.fileLooksBinary(full)) continue; // skip binaries
        } catch {
          continue;
        }
        if (!grepFile(full)) return false;
      }
      return true;
    };

    let rootStat: Stats;
    try {
      rootStat = statSync(resolved.real);
    } catch {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    if (rootStat.isDirectory()) {
      walk(resolved.real);
    } else if (rootStat.isFile()) {
      // A single-file grep target: apply the same secret guard directly.
      if (isSecretPath(resolved.real)) {
        this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'denied_secret_pattern' });
        return;
      }
      if (matchesBasenameGlob(path.basename(resolved.real), globRe)) {
        filesScanned += 1;
        try {
          if (
            lstatSync(resolved.real).size <= FS_GREP_MAX_FILE_BYTES &&
            !this.fileLooksBinary(resolved.real)
          ) {
            grepFile(resolved.real);
          }
        } catch {
          /* unreadable — leave matches empty */
        }
      }
    }

    this.ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { matches, truncated, filesScanned },
    });
  }

  /**
   * cyboflow_history (mcp-history) — READ-ONLY search/paging over the CALLING
   * assistant thread's own `agent_thread_events` rows.
   *
   * THREAD SCOPING IS THE LOAD-BEARING GUARANTEE: `thread_id` is bound from
   * resolveGlobalAgentContext(msg.runId), which rejects any non-`agent:` runId
   * BEFORE a single DB read (mirroring handleAgentQueue). There is no
   * caller-supplied thread argument at all, so no argument can widen the scope
   * past the thread that is asking.
   *
   * TWO MODES over one walk:
   *   search (query given) — keep turns whose decoded text contains the
   *                          case-insensitive substring, each returned as an
   *                          excerpt around its FIRST occurrence, `matched:
   *                          true`. Plain indexOf, NEVER a caller regex — see
   *                          the mcp-history union member's doc for why.
   *   browse (no query)    — keep every decoded turn, head-truncated.
   *
   * The walk pages id-DESCENDING in HISTORY_BATCH_ROWS batches (never
   * `SELECT *` over the whole table — this table is append-only and permanent)
   * and stops at the first cap it hits: HISTORY_MAX_SCAN_ROWS rows examined,
   * HISTORY_MAX_PAYLOAD_BYTES of serialized turns, or a (limit+1)th qualifying
   * turn FOUND — the page is full and that unreturned find is the proof more
   * exists. Any of those sets `truncated` and reports `nextBeforeId` — the id
   * of the last FULLY PROCESSED row — so a follow-up call resumes exactly
   * where this one stopped, never re-emitting and never skipping. A walk that
   * fills the page exactly and then runs out of rows is NOT truncated: the
   * scan keeps going after the limit is reached purely to learn whether more
   * qualifying turns exist (bounded by the same scan cap), so `truncated:true`
   * always means "there is more". Rows running out ends the walk with
   * `truncated:false`, `nextBeforeId:null`.
   *
   * Rows whose payload carries no turn text (SDK tool_result plumbing, tool_use
   * -only assistant events, corrupt JSON) decode to null and are skipped — they
   * still count toward `scanned`, which is why the scan cap exists separately
   * from `limit`.
   */
  handleAgentHistory(
    msg: Extract<McpQueryMessage, { type: 'mcp-history' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // --- argument validation ------------------------------------------------
    if (msg.role !== undefined && msg.role !== 'user' && msg.role !== 'assistant') {
      this.ctx.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: "invalid_arguments: role must be 'user' or 'assistant'",
      });
      return;
    }
    for (const [name, value] of [
      ['daysBack', msg.daysBack],
      ['beforeId', msg.beforeId],
      ['limit', msg.limit],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        this.ctx.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `invalid_arguments: ${name} must be a positive finite number`,
        });
        return;
      }
    }

    // An omitted OR empty query means browse mode (an empty needle would match
    // every turn, making the two modes differ only in excerpt shape — browsing
    // is the clearer contract for "no search term"). The needle is matched as
    // a case-insensitive PLAIN SUBSTRING via indexOf on lowercased text —
    // deliberately not a RegExp: this handler runs synchronously on the main
    // process, and a model-authored pattern with catastrophic backtracking
    // would wedge the entire app (see the mcp-history union member's doc).
    let needle: string | null = null;
    if (msg.query !== undefined) {
      if (typeof msg.query !== 'string') {
        this.ctx.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'invalid_arguments: query must be a string',
        });
        return;
      }
      if (msg.query.length > 0) {
        needle = msg.query.toLowerCase();
      }
    }

    const limit = Math.max(
      1,
      Math.min(msg.limit !== undefined ? Math.floor(msg.limit) : HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
    );
    const roleFilter = msg.role;
    // Bound as a PARAMETER to datetime('now', ?) — never interpolated into the
    // SQL text, even though it is derived from a validated number. Clamped to
    // HISTORY_MAX_DAYS_BACK: past the julian-day range datetime() returns NULL
    // and `created_at >= NULL` silently filters out EVERY row (see the
    // constant's doc) — a clamped huge value instead means "the whole table".
    const dayModifier =
      msg.daysBack !== undefined
        ? `-${Math.min(Math.max(1, Math.floor(msg.daysBack)), HISTORY_MAX_DAYS_BACK)} days`
        : null;

    // --- the id-descending walk ---------------------------------------------
    const turns: HistoryTurn[] = [];
    let cursor: number | null = msg.beforeId !== undefined ? Math.floor(msg.beforeId) : null;
    /** Id of the last row processed to completion — the resume point. */
    let lastProcessedId: number | null = null;
    let scanned = 0;
    let payloadBytes = 0;
    let truncated = false;
    let stopped = false;

    while (!stopped) {
      const clauses = [
        'thread_id = ?',
        "event_type IN ('user', 'assistant', 'agent_user', 'agent_assistant')",
      ];
      const params: unknown[] = [ctx.threadId];
      if (cursor !== null) {
        clauses.push('id < ?');
        params.push(cursor);
      }
      if (dayModifier !== null) {
        clauses.push("created_at >= datetime('now', ?)");
        params.push(dayModifier);
      }
      params.push(HISTORY_BATCH_ROWS);

      const rows = this.ctx.db
        .prepare(
          `SELECT id, event_type, payload_json, created_at
             FROM agent_thread_events
            WHERE ${clauses.join(' AND ')}
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(...params) as AgentThreadEventScanRow[];
      if (rows.length === 0) break; // exhausted — no more transcript to page

      for (const row of rows) {
        if (scanned >= HISTORY_MAX_SCAN_ROWS) {
          truncated = true;
          stopped = true;
          break;
        }
        scanned += 1;
        cursor = row.id;

        const turn = extractTurnText(row.event_type, row.payload_json);
        if (turn !== null && (roleFilter === undefined || turn.role === roleFilter)) {
          let text: string;
          let matched = false;
          if (needle !== null) {
            // Lowercase-both indexOf: unconditionally O(n), immune to the
            // backtracking blowups a caller regex could smuggle in. The rare
            // Unicode where toLowerCase changes string length can drift the
            // excerpt window a few chars — excerptAround clamps, so the worst
            // case is a slightly off-center excerpt, never a crash or a miss.
            const matchIndex = turn.text.toLowerCase().indexOf(needle);
            if (matchIndex === -1) {
              lastProcessedId = row.id;
              continue; // searched and missed — row is fully processed
            }
            text = excerptAround(turn.text, matchIndex);
            matched = true;
          } else {
            text = truncateHead(turn.text, TURN_TEXT_MAX_CHARS);
          }

          // Page already full? Then THIS qualifying turn is the proof that
          // more exists: report truncated WITHOUT emitting it, leaving
          // lastProcessedId pointing above it so the next page starts here.
          // (The scan deliberately continues past `limit` to reach this point
          // — an exact-limit walk that runs out of rows instead is complete,
          // not truncated, and never costs the caller a wasted empty page.)
          if (turns.length >= limit) {
            truncated = true;
            stopped = true;
            break;
          }

          const entry: HistoryTurn = {
            eventId: row.id,
            at: row.created_at,
            role: turn.role,
            text,
            ...(matched ? { matched: true } : {}),
          };
          const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
          // A single oversized turn is still returned when it would otherwise
          // be the empty answer — returning nothing would look like "no such
          // memory" rather than "one very long memory".
          if (turns.length > 0 && payloadBytes + entryBytes > HISTORY_MAX_PAYLOAD_BYTES) {
            truncated = true;
            stopped = true;
            break; // row NOT processed — lastProcessedId still points above it
          }
          turns.push(entry);
          payloadBytes += entryBytes;
        }

        lastProcessedId = row.id;
      }

      if (!stopped && rows.length < HISTORY_BATCH_ROWS) break; // short batch = exhausted
    }

    this.ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        turns,
        truncated,
        nextBeforeId: truncated ? lastProcessedId : null,
        scanned,
      },
    });
  }
}
