/**
 * Narrow structural contract for the `sessions` tRPC router's business logic —
 * batch 1 of the session-surface IPC→tRPC migration (docs/CODE-PATTERNS.md),
 * following the same seam as `configOps.ts` (the PILOT slice),
 * `workspaceFileOps.ts` (slice 2) and `sessionGitOps.ts` (slice 3): the router
 * (routers/sessions.ts) does zod input validation and delegates to this
 * interface; the concrete implementation (main/src/ipc/sessionOps.ts) wraps
 * SessionManager / DatabaseService / ConfigManager / GitStatusManager /
 * ArchiveProgressManager plus the summary scheduler and the quick-session
 * listing, and may freely import from main/src/services/*. Declaring the
 * interface here — rather than importing the concrete factory — keeps the tRPC
 * subtree's standalone-typecheck invariant intact (no 'electron',
 * 'better-sqlite3' or 'main/src/services/**' imports; only main/src/types/* and
 * shared/types/* are allowed, and anything else is declared here as a
 * structural mirror naming its source of truth).
 *
 * Every method returns the EXACT envelope shape the legacy `sessions:*` /
 * `archive:get-progress` ipcMain.handle channels (main/src/ipc/session.ts)
 * returned — same success/error keys, same error strings — so frontend call
 * sites keep their existing shape. Two envelope quirks are load-bearing and are
 * preserved deliberately rather than "cleaned up":
 *   • `updateAgentPermissionMode` answers an unrecognized mode with a RETURNED
 *     failure envelope (`{ success: false, error: 'Invalid agent permission
 *     mode: …' }`), not a thrown validation error — its router schema takes
 *     `mode` as a plain string so the isPermissionMode check stays in the ops
 *     body. `updateSessionMcps` / `updateSessionPlugins` do NOT share that
 *     quirk: their router schemas are strict (`z.array(z.string())`), so a
 *     malformed payload throws BAD_REQUEST at the zod boundary; their ops-body
 *     guards are defense-in-depth for direct ops callers only.
 *   • `getSummary`'s validation failure is `createValidationError`'s
 *     `{ success: false, error: '<Session x not found|is archived>' }`, which
 *     must survive byte-identical.
 *
 * `debug:get-table-structure` was NOT migrated — it was deleted outright (zero
 * preload/frontend callers), the same disposal `file:getPath` and
 * `sessions:check-rebase-conflicts` got in the earlier slices.
 * DatabaseService.getTableStructure itself is untouched.
 */
import type { Session } from '../../../types/session';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { SessionSummaryPayload } from '../../../../../shared/types/sessionSummary';

/** The failure half every one of these envelopes shares. */
export type SessionOpsError = { success: false; error: string };

/**
 * Structural mirror of the `projects` row (source of truth:
 * main/src/database/models.ts `Project`) — what `getAllWithProjects` spreads
 * into each entry before attaching its sessions and folders.
 */
export interface SessionProjectRow {
  id: number;
  name: string;
  path: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  default_permission_mode?: 'approve' | 'ignore';
  open_ide_command?: string | null;
  main_branch?: string | null;
  display_order?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  permission_trust?: 'trusted' | 'untrusted' | null;
}

/**
 * A folder as the renderer sees it — the camelCase projection
 * `convertDbFolderToFolder` (main/src/ipc/folders.ts, source of truth) makes of
 * the snake_case `folders` row.
 */
export interface SessionFolderRow {
  id: string;
  name: string;
  projectId: number;
  parentFolderId?: string | null;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** One entry of `getAllWithProjects`: a project plus its sessions and folders. */
export type ProjectWithSessions = SessionProjectRow & {
  sessions: Session[];
  folders: SessionFolderRow[];
};

/**
 * What `rename` echoes back: the updated row DatabaseService.updateSession
 * returns — the snake_case `sessions` DB row (source of truth:
 * main/src/database/models.ts `Session`), NOT the camelCase renderer
 * {@link Session}.
 *
 * DELIBERATELY NARROWER than the wire. The row carries ~40 columns and every
 * one of them still travels; only the two the rename path actually establishes
 * are declared, because no renderer call site reads any column at all (each
 * caller checks `success` and nothing else). Mirroring forty columns here would
 * buy nothing and drift the first time a migration adds one.
 */
export interface RenamedSessionRow {
  id: string;
  name: string;
}

/**
 * One in-flight archive task. Structural mirror of `SerializedArchiveTask`
 * (main/src/services/archiveProgressManager.ts — source of truth). The
 * renderer's twin is the local `ArchiveTask` interface in
 * frontend/src/components/ArchiveProgress.tsx.
 */
export interface ArchiveTaskSnapshot {
  sessionId: string;
  sessionName: string;
  worktreeName: string;
  projectName: string;
  status: 'pending' | 'queued' | 'removing-worktree' | 'cleaning-artifacts' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  error?: string;
}

/** `getArchiveProgress`'s payload. `activeCount` excludes completed/failed tasks. */
export interface ArchiveProgressPayload {
  tasks: ArchiveTaskSnapshot[];
  activeCount: number;
  totalCount: number;
}

/**
 * The `getStatistics` payload, mirroring the handler's object literal EXACTLY —
 * this is a wire shape the session meter and the Stats panel both read, so no
 * field may be added, dropped or renamed here without changing them too. The
 * renderer's twin is `SessionStatistics` in
 * frontend/src/components/panels/claude/SessionStats.tsx (and the narrower
 * runtime shape guard in frontend/src/hooks/useSessionMetrics.ts).
 *
 * Two notes carried over from the handler: `session.model` comes from the
 * session's Claude PANEL settings (model is panel-level, not a session column),
 * and the `tokens.run*` fields are workflow-run usage hosted by this session —
 * additive to, and disjoint from, the chat totals beside them, so a
 * whole-session figure is the SUM of the two per category.
 */
export interface SessionStatisticsPayload {
  session: {
    id: string;
    name: string;
    status: Session['status'];
    model: string | null;
    createdAt: Date;
    updatedAt: Date;
    duration: number;
    worktreePath: string;
    branch: string;
  };
  tokens: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    messageCount: number;
    runInputTokens: number;
    runOutputTokens: number;
    runCacheReadTokens: number;
    runCacheCreationTokens: number;
  };
  files: {
    totalFilesChanged: number;
    totalLinesAdded: number;
    totalLinesDeleted: number;
    filesModified: string[];
    executionCount: number;
  };
  activity: {
    promptCount: number;
    messageCount: number;
    outputCounts: { json: number; stdout: number; stderr: number };
    lastActivity: Date;
  };
  toolUsage: {
    tools: Array<{
      name: string;
      count: number;
      totalDuration: number;
      avgDuration: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    }>;
    totalToolCalls: number;
  };
}

export interface SessionOpsLike {
  /** Mirrors legacy `sessions:get-all`. Every non-archived session, renderer-shaped. */
  getAll(): Promise<{ success: true; data: Session[] } | SessionOpsError>;

  /** Mirrors legacy `sessions:get`. A missing session is `'Session not found'`, not a throw. */
  get(request: { sessionId: string }): Promise<{ success: true; data: Session } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:get-all-with-projects`. Every project with its
   * sessions and its (camelCased) folders attached.
   */
  getAllWithProjects(): Promise<{ success: true; data: ProjectWithSessions[] } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:get-summary`. `catchUp` DEFAULTS TO TRUE in the ops
   * impl (matching every existing caller): when the feature is enabled and there
   * is unsummarized content above the watermark, the read fires a
   * fire-and-forget summarizer kick. Pass `false` for a pure read with no side
   * effect. The failure envelope is `createValidationError`'s.
   */
  getSummary(request: {
    sessionId: string;
    catchUp?: boolean;
  }): Promise<{ success: true; data: SessionSummaryPayload } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:list-quick`. The live quick-session board: state is
   * DERIVED on read (`blocked` when the chat run has a pending question /
   * permission gate), a CACHE-ONLY git snapshot is attached, and a throttled
   * fire-and-forget git-cache warm rides the poll. `projectId` scopes to one
   * project; omit for the cross-project review home.
   */
  listQuick(request: { projectId?: number }): Promise<{ success: true; data: QuickSessionRow[] } | SessionOpsError>;

  /** Mirrors legacy `sessions:get-statistics`. See {@link SessionStatisticsPayload}. */
  getStatistics(request: {
    sessionId: string;
  }): Promise<{ success: true; data: SessionStatisticsPayload } | SessionOpsError>;

  /**
   * Mirrors legacy `archive:get-progress`. With no ArchiveProgressManager wired
   * this SUCCEEDS with an empty payload rather than failing — the sidebar panel
   * renders nothing for `totalCount: 0`.
   */
  getArchiveProgress(): Promise<{ success: true; data: ArchiveProgressPayload } | SessionOpsError>;

  /** Mirrors legacy `sessions:mark-viewed`. */
  markViewed(request: { sessionId: string }): Promise<{ success: true } | SessionOpsError>;

  /**
   * TASK-225: dismiss a quick session's stale summarizer ask (the "Dismiss"
   * action on a Needs-your-input card). Clears `session_summaries.state` /
   * `waiting_on` and stamps a dismissal hash of the cleared `waiting_on` text
   * so `listQuick`'s read-time filter keeps the card hidden if the summarizer
   * later repeats the exact same question — a genuinely different question
   * still resurfaces. No legacy IPC channel; new to this batch. The failure
   * envelope is `createValidationError`'s (mirrors `getSummary`).
   */
  dismissAsk(request: { sessionId: string }): Promise<{ success: true } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:rename`. Persists the name, mirrors it onto the
   * runtime session and emits 'session-updated'; echoes the updated DB row back.
   */
  rename(request: {
    sessionId: string;
    newName: string;
  }): Promise<{ success: true; data: RenamedSessionRow } | SessionOpsError>;

  /** Mirrors legacy `sessions:toggle-favorite`. Returns the NEW favorite state. */
  toggleFavorite(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { isFavorite: boolean } } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:update-agent-permission-mode`. An unrecognized mode
   * is a RETURNED envelope (`Invalid agent permission mode: <mode>`), which is
   * why `mode` is a plain string here and the check lives in the ops body.
   */
  updateAgentPermissionMode(request: {
    sessionId: string;
    mode: string;
  }): Promise<{ success: true } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:update-session-mcps`. The per-session MCP DENY
   * list. The `'Invalid MCP selection'` envelope only answers a malformed
   * payload from a DIRECT ops caller — via the router, zod throws BAD_REQUEST
   * first.
   */
  updateSessionMcps(request: {
    sessionId: string;
    disabledMcpServers: string[];
  }): Promise<{ success: true } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:update-session-plugins`. The per-session plugin
   * ALLOW list. Same validation posture as {@link updateSessionMcps}: the
   * `'Invalid plugin selection'` envelope is defense-in-depth for direct ops
   * callers; the router's zod schema throws BAD_REQUEST first.
   */
  updateSessionPlugins(request: {
    sessionId: string;
    enabledPlugins: string[];
  }): Promise<{ success: true } | SessionOpsError>;

  /** Mirrors legacy `sessions:reorder`. */
  reorder(request: {
    sessionOrders: Array<{ id: string; displayOrder: number }>;
  }): Promise<{ success: true } | SessionOpsError>;

  /**
   * Mirrors legacy `sessions:set-active-session`. Tells GitStatusManager which
   * session the user is looking at, so its polling can favour it. `null` clears
   * the selection.
   */
  setActiveSession(request: { sessionId: string | null }): Promise<{ success: true } | SessionOpsError>;
}
