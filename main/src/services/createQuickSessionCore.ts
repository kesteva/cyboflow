/**
 * createQuickSessionCore — the SHARED session+sentinel+base-persist path behind a
 * "quick" (flow-less) worktree session.
 *
 * Extracted from the body of the `sessions:create-quick` IPC handler so TWO
 * callers use ONE path:
 *   1. `sessions:create-quick` (ipc/session.ts) — the user's quick session.
 *   2. `experiments.startSideBySide` (via the injected `createArmSession` dep) —
 *      each A/B arm session, whose worktree is SHA-pinned to the experiment's
 *      base commit (baseCommittish) so both arms cut from the identical base.
 *
 * The core performs the run-agnostic prefix: enqueue the session-create job
 * (worktree + session row, optionally SHA-pinned), await the session-created
 * event, wire the `__quick__` sentinel run (createRun → queued→starting→running),
 * stamp its worktree_path, and backfill sessions.run_id + chat_run_id. The
 * IPC handler layers its per-session config (agent mode / substrate / effort /
 * MCP / eager PTY spawn) on top of the returned value; the experiment arm needs
 * only the headless session + sentinel.
 */
import type Database from 'better-sqlite3';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';
import { transitionToRunning } from './cyboflow/transitions';
import { assertTransitionAllowed } from './cyboflow/stateMachine';

/** Minimal session shape the core resolves + returns (a real `Session`). */
export interface QuickSessionRow {
  id: string;
  worktreePath: string;
  /** Session name (= worktree template). Used by the in-place name matcher. */
  name?: string;
  permissionMode?: 'approve' | 'ignore';
}

/** Session-create job payload (subset of CreateSessionJob the core sets). */
export interface QuickSessionJobData {
  prompt: string;
  worktreeTemplate: string;
  projectId: number;
  folderId?: string;
  baseBranch?: string;
  baseCommittish?: string;
  autoCommit?: boolean;
  toolType?: 'claude' | 'none';
  commitMode?: 'structured' | 'checkpoint' | 'disabled';
  commitModeSettings?: string;
  /** Work directly in the project checkout — no dedicated worktree (migration 047). */
  inPlace?: boolean;
  claudeConfig?: { model?: string; permissionMode?: 'approve' | 'ignore'; ultrathink?: boolean };
}

/** The collaborators the core needs — structural so both IPC + boot wiring inject them. */
export interface CreateQuickSessionCoreDeps {
  taskQueue: { createSession(data: QuickSessionJobData): Promise<{ id: string }> };
  /** SessionManager EventEmitter surface (session-created fires when the worktree+row land). */
  sessionManager: {
    on(event: 'session-created', listener: (s: QuickSessionRow) => void): void;
    removeListener(event: 'session-created', listener: (s: QuickSessionRow) => void): void;
  };
  workflowRegistry: {
    ensureQuickWorkflow(projectId: number): string;
    createRun(
      workflowId: string,
      requestedSubstrate?: CliSubstrate,
      sessionId?: string,
      requestedPermissionMode?: PermissionMode,
    ): { runId: string; substrate: CliSubstrate };
  };
  getDb(): Database.Database;
}

export interface CreateQuickSessionCoreOptions {
  projectId: number;
  /** Worktree branch/template name; the caller generates a stable hint. */
  nameHint: string;
  /** SHA-pin the worktree branch to an exact commit (A/B arms). */
  baseCommittish?: string;
  baseBranch?: string;
  folderId?: string;
  autoCommit?: boolean;
  toolType?: 'claude' | 'none';
  commitMode?: 'structured' | 'checkpoint' | 'disabled';
  commitModeSettings?: string;
  claudeConfig?: { model?: string; permissionMode?: 'approve' | 'ignore'; ultrathink?: boolean };
  /** Per-run substrate/permission choice threaded into the sentinel createRun (quick handler). */
  requestedSubstrate?: CliSubstrate;
  requestedAgentMode?: PermissionMode;
  /**
   * Work directly in the project checkout — no dedicated worktree (migration 047,
   * quick handler only; A/B arms are always worktree-isolated so they never set
   * this). Forces auto-commit off + commitMode disabled (an in-place `git add -A`
   * would sweep the user's unrelated dirty files) and switches session matching to
   * the NAME fallback (worktreePath === the project path, never `/${nameHint}`).
   */
  inPlace?: boolean;
  /** Await budget for the session-created event (default 30s). */
  timeoutMs?: number;
}

export interface CreateQuickSessionCoreResult {
  session: QuickSessionRow;
  runId: string;
  resolvedSubstrate: CliSubstrate;
  jobId: string;
}

/**
 * Session ids already claimed by an in-flight core call's session-created
 * listener. Same-second concurrent calls share one nameHint, and BOTH matchers
 * accept BOTH resulting sessions (base + `-<n>` suffixed forms); without a claim,
 * both callers would resolve to the FIRST session, orphaning the second. Shared
 * across callers (session id is globally unique) — the first listener to see a
 * session claims its id, the other keeps waiting for the sibling event. Listeners
 * run synchronously on the same emit, so the claim is race-free.
 */
const claimedQuickSessionIds = new Set<string>();

/**
 * Test-only: clear the claimed-session-id set. Production ids are unique UUIDs
 * so the set never needs clearing there; test fixtures reuse constant session
 * ids across cases, and a stale claim makes every later await time out.
 */
export function _resetClaimedQuickSessionIdsForTesting(): void {
  claimedQuickSessionIds.clear();
}

/**
 * Create a quick (flow-less) worktree session + its `__quick__` sentinel run and
 * advance it to running. See the module header for the two callers. Throws on a
 * session-create timeout or a sentinel transition failure (the caller decides
 * fail-soft policy).
 */
export async function createQuickSessionCore(
  deps: CreateQuickSessionCoreDeps,
  opts: CreateQuickSessionCoreOptions,
): Promise<CreateQuickSessionCoreResult> {
  const { taskQueue, sessionManager, workflowRegistry } = deps;
  const branchName = opts.nameHint;
  const inPlace = opts.inPlace === true;

  const job = await taskQueue.createSession({
    prompt: '',
    worktreeTemplate: branchName,
    projectId: opts.projectId,
    folderId: opts.folderId,
    baseBranch: opts.baseBranch,
    baseCommittish: opts.baseCommittish,
    // In-place sessions share the user's real checkout, so checkpoint auto-commit
    // (a `git add -A` in the session cwd) must never run — force it off + disable
    // commit mode (the request's own autoCommit/commitMode are ignored in-place).
    autoCommit: inPlace ? false : opts.autoCommit,
    toolType: opts.toolType ?? 'claude',
    commitMode: inPlace ? 'disabled' : opts.commitMode,
    commitModeSettings: opts.commitModeSettings,
    inPlace,
    claudeConfig: opts.claudeConfig,
  });

  // Await the session row via the session-created event. Concurrent create-quick
  // calls share the emitter, so filter by worktreePath: TaskQueue's
  // ensureUniqueNames may append a `-<n>` suffix on same-second collisions.
  const session = await new Promise<QuickSessionRow>((resolve, reject) => {
    const suffixed = new RegExp(`/${branchName}-\\d+$`);
    // In-place sessions (migration 047) have worktreePath === the project path,
    // never `/${branchName}`, so the path match can never fire — fall back to the
    // session NAME (= worktree template), with the same ` <n>` (name) / `-<n>`
    // (worktree) collision suffixes. Scoped to in-place so worktree sessions keep
    // matching by path exactly as before.
    const nameSuffixed = new RegExp(`^${branchName}[ -]\\d+$`);
    const onCreated = (createdSession: QuickSessionRow) => {
      const wt = createdSession.worktreePath ?? '';
      const name = createdSession.name ?? '';
      const matches =
        wt.endsWith(`/${branchName}`) ||
        suffixed.test(wt) ||
        (inPlace && (name === branchName || nameSuffixed.test(name)));
      if (!matches) return;
      // Claim the session id so a concurrent sibling call doesn't also resolve to it.
      if (claimedQuickSessionIds.has(createdSession.id)) return;
      claimedQuickSessionIds.add(createdSession.id);
      clearTimeout(timeout);
      sessionManager.removeListener('session-created', onCreated);
      resolve(createdSession);
    };
    const timeout = setTimeout(() => {
      sessionManager.removeListener('session-created', onCreated);
      reject(new Error('Timed out waiting for quick session to be created'));
    }, opts.timeoutMs ?? 30_000);
    sessionManager.on('session-created', onCreated);
  });

  // Wire the __quick__ sentinel run so ApprovalRouter/chat gating work.
  const sentinelWorkflowId = workflowRegistry.ensureQuickWorkflow(opts.projectId);
  const { runId, substrate: resolvedSubstrate } = workflowRegistry.createRun(
    sentinelWorkflowId,
    opts.requestedSubstrate,
    session.id,
    opts.requestedAgentMode,
  );

  const db = deps.getDb();

  // queued -> starting (guarded UPDATE) -> running (guarded helper).
  assertTransitionAllowed('queued', 'starting', runId);
  const startingResult = db
    .prepare(
      `UPDATE workflow_runs SET status = 'starting', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'`,
    )
    .run(runId);
  if (startingResult.changes === 0) {
    throw new Error(`Failed to advance run ${runId} from queued to starting`);
  }
  transitionToRunning(db, { runId });

  // Stamp the session worktree onto the sentinel run (mcpQueryHandler per-run
  // worktree allow-list keys off this) + backfill run_id/chat_run_id.
  db.prepare(`UPDATE workflow_runs SET worktree_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    session.worktreePath,
    runId,
  );
  db.prepare(`UPDATE sessions SET run_id = ?, chat_run_id = ? WHERE id = ?`).run(runId, runId, session.id);

  return { session, runId, resolvedSubstrate, jobId: job.id };
}
