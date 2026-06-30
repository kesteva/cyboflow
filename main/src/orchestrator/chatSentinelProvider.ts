import type { DatabaseLike, LoggerLike } from './types';
import type { WorkflowRegistry } from './workflowRegistry';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';

/**
 * The pure gate vehicle (permission-mode redesign §6, Option B).
 *
 * A chat turn must gate on a workflow_runs row that is `'running'` so the
 * ApprovalRouter's guarded `UPDATE … WHERE status='running'` can flip it to
 * `awaiting_review`. Coupling that gate to `sessions.run_id` (Role-D: the latest
 * FLOW run) silently denied every chat turn once the flow went terminal (#4).
 *
 * `chatSentinelProvider(sessionId)` resolves the session's DEDICATED, persistent
 * `__quick__` sentinel — `sessions.chat_run_id` — minting it on first read for a
 * flow-only/legacy session (chat_run_id NULL). The minted row is ALWAYS a
 * `__quick__` workflow run so `reviveQuickRunToRunning`'s JOIN guard matches on
 * the SDK path; it is advanced to `'running'` + worktree-stamped on mint so the
 * gate is immediately live on BOTH substrates (interactive has no revive seam).
 *
 * `'__quick__'` is `QUICK_WORKFLOW_NAME` (orchestrator/workflowRegistry). Inlined
 * here so this module never imports the heavyweight registry at runtime (the
 * registry instance is INJECTED) — the sentinel name is a DB-persisted constant.
 */
const QUICK_WORKFLOW_NAME = '__quick__';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATUSES);

/** Mints/returns the session's persistent `__quick__` chat-gate sentinel run id. */
export type ChatSentinelProvider = (sessionId: string) => string;

/**
 * Thrown by {@link makeChatSentinelProvider} when a chat turn is attempted while
 * the session's `run_id` FLOW run is non-terminal. The clean gate split (Role-G
 * on chat_run_id, Role-D on run_id) structurally permits a chat sentinel
 * `'running'` concurrently with a live flow run on the SAME worktree — two
 * `query()`s writing the same files. We reject the chat turn rather than regress
 * (permission-mode redesign §6 MED-3). The manager spawn seams let this propagate
 * so the chat turn fails loudly instead of corrupting the flow's worktree.
 */
export class ChatDuringActiveFlowError extends Error {
  readonly code = 'CHAT_DURING_ACTIVE_FLOW' as const;
  constructor(
    readonly sessionId: string,
    readonly flowRunId: string,
    readonly flowStatus: string,
  ) {
    super(
      `Cannot start a chat turn for session ${sessionId}: its flow run ${flowRunId} is still active (${flowStatus}). Finish or dismiss the flow first.`,
    );
    this.name = 'ChatDuringActiveFlowError';
  }
}

/** The columns chatSentinelProvider reads off the session row. */
interface SessionGateRow {
  id: string;
  project_id: number;
  substrate: CliSubstrate | null;
  worktree_path: string | null;
  agent_permission_mode: PermissionMode | null;
  run_id: string | null;
  chat_run_id: string | null;
}

export interface ChatSentinelProviderDeps {
  db: DatabaseLike;
  workflowRegistry: WorkflowRegistry;
  logger?: LoggerLike;
  /**
   * Invoked once, AFTER a fresh chat sentinel is minted + persisted, with the
   * session id. The mint writes `sessions.chat_run_id` via a raw UPDATE that
   * bypasses sessionManager, so the frontend never learns the new id until the
   * session is re-fetched — leaving the inline approval strip (keyed on
   * `session.chatRunId`) blank for the rest of the turn even though the approval
   * is already in the review queue. The electron layer wires this to emit
   * `session-updated` so the reactive session store resolves the gate runId
   * immediately. NOT called on reuse (the id is unchanged). Best-effort: a throw
   * here must never corrupt the gate, so the impl + caller swallow errors.
   */
  onMint?: (sessionId: string) => void;
}

/**
 * Construct the chat-sentinel provider at the orchestrator layer (where
 * WorkflowRegistry ownership lives) and inject the returned closure into the CLI
 * managers via `setChatSentinelProvider`. Synchronous + side-effecting: the mint
 * read-check-write is atomic within a single call (better-sqlite3 is sync,
 * single-threaded), so concurrent gate resolutions for the same session never
 * double-mint within one turn.
 */
export function makeChatSentinelProvider(deps: ChatSentinelProviderDeps): ChatSentinelProvider {
  const { db, workflowRegistry, logger, onMint } = deps;

  const selectSession = db.prepare(
    `SELECT id, project_id, substrate, worktree_path, agent_permission_mode, run_id, chat_run_id
       FROM sessions WHERE id = ?`,
  );
  const selectFlow = db.prepare(
    `SELECT w.name AS name, r.status AS status
       FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
      WHERE r.id = ?`,
  );
  const advanceRun = db.prepare(
    `UPDATE workflow_runs
        SET status = 'running',
            worktree_path = COALESCE(worktree_path, @worktree),
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = 'queued'`,
  );
  const persistChatRunId = db.prepare(
    `UPDATE sessions SET chat_run_id = @runId WHERE id = @sessionId AND chat_run_id IS NULL`,
  );

  return (sessionId: string): string => {
    const session = selectSession.get(sessionId) as SessionGateRow | undefined;
    if (!session) {
      throw new Error(`chatSentinelProvider: session ${sessionId} not found`);
    }

    // Chat-during-active-flow guard (§6 MED-3). A non-terminal NON-__quick__ run
    // pointed at by sessions.run_id is a live flow owning the worktree; reject the
    // concurrent chat turn. A __quick__ run_id (a pure chat session whose run_id IS
    // its own sentinel) and a TERMINAL flow run (#4 — chat-after-terminal-flow) do
    // NOT trip this guard.
    if (session.run_id) {
      const flow = selectFlow.get(session.run_id) as { name: string; status: string } | undefined;
      if (flow && flow.name !== QUICK_WORKFLOW_NAME && !TERMINAL_STATUSES.has(flow.status)) {
        throw new ChatDuringActiveFlowError(sessionId, session.run_id, flow.status);
      }
    }

    // Already have a persistent chat vehicle → reuse it (revive at SDK spawn flips
    // it back to 'running' if it drained/failed between turns).
    if (session.chat_run_id) return session.chat_run_id;

    // Mint-on-read: a flow-only/legacy session (chat_run_id NULL) gets a fresh
    // __quick__ sentinel as its chat vehicle, on the session's own substrate.
    const workflowId = workflowRegistry.ensureQuickWorkflow(session.project_id);
    const { runId } = workflowRegistry.createRun(
      workflowId,
      session.substrate ?? undefined,
      sessionId,
      session.agent_permission_mode ?? undefined,
    );
    // Advance queued → running + stamp the session worktree so the gate (and the
    // per-run MCP worktree allow-list) is live immediately on BOTH substrates —
    // the SDK revive seam alone would not cover the interactive REPL.
    advanceRun.run({ runId, worktree: session.worktree_path ?? null });
    persistChatRunId.run({ runId, sessionId });
    logger?.info(
      `chatSentinelProvider: minted __quick__ chat sentinel ${runId} for session ${sessionId}`,
    );
    // Push the new chat_run_id to the frontend (emit 'session-updated') so the
    // inline approval gate resolves without a manual re-fetch. Best-effort — the
    // sentinel is already minted + persisted, so a notify failure must not throw.
    try {
      onMint?.(sessionId);
    } catch (err) {
      logger?.warn(`chatSentinelProvider: onMint notify failed for ${sessionId}: ${String(err)}`);
    }
    return runId;
  };
}

/**
 * Resolve the approval-gate `runId` at a CLI-manager spawn seam (§6).
 *
 * Discriminator: does `getDbSession(sessionId)` resolve a real session row?
 *  - CHAT turn (real session UUID) → the persistent `__quick__` chat sentinel via
 *    the injected provider (minted on read). NO `?? run_id` arm in production —
 *    it re-introduced #4's terminal-flow silent-deny and could hijack a live flow
 *    run's gate.
 *  - FLOW step (`sessionId === runId`, getDbSession → undefined) → the flow run
 *    itself (`flowRunId` for interactive's `options.runId`, else `panelId`).
 *
 * The provider may be absent only in tests / pre-wiring boot; the fallback then
 * preserves the pre-redesign behavior (`run_id ?? panelId`) so a chat spawn is
 * never broken. Production always injects the provider, so that arm is dead there.
 */
export function resolveGateRunId(opts: {
  sessionRow: { run_id?: string | null } | undefined;
  panelId: string;
  sessionId: string;
  provider: ChatSentinelProvider | null;
  flowRunId?: string;
}): string {
  const { sessionRow, panelId, sessionId, provider, flowRunId } = opts;
  if (sessionRow) {
    if (provider) return provider(sessionId); // chat turn — minted-on-read sentinel
    return (sessionRow.run_id ?? null) ?? panelId; // uninjected fallback (tests/boot)
  }
  return flowRunId ?? panelId; // flow step — gate on the flow run
}
