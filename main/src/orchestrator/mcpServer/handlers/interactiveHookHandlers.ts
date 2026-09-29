/**
 * InteractiveHookHandlers — the INTERACTIVE-substrate hook family, split out
 * of mcpQueryHandler.ts (issue #19): the async-deferred shell PreToolUse gate
 * (IDEA-013 S5 / TASK-810) with its OMP deferred-approval twin, the Stop
 * turn-end ack (IDEA-030) and the AskUserQuestion notify.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import — the interactive
 * manager's notify callbacks arrive through McpQueryHandlerDeps.
 */
import * as net from 'net';
import type { DatabaseLike, LoggerLike } from '../../types';
import { isPermissionMode } from '../../../../../shared/types/workflows';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { ApprovalRouter, RunNotRunningError } from '../../approvalRouter';
import type { ApprovalDecision } from '../../../../../shared/types/approval';
import { isToolAllowed, loadMergedPermissionRules } from '../../permissionRules';
import { isAcceptEditsAutoApprovable } from '../../permissionModeMapper';
import { SprintLaneStore } from '../../sprintLaneStore';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';

/**
 * The context McpQueryHandler composes this family with. `writeResponse` and
 * `resolveRunWorktree` are private methods on the handler, handed over as
 * closures so they stay private there while the moved bodies keep calling
 * them as `this.<name>(...)` unchanged.
 */
export interface InteractiveHookContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  /** The run's worktree_path (its cwd) for the allow-list lookup, or null when the run row is absent. */
  resolveRunWorktree(runId: string): string | null;
}

/**
 * Provenance stamped on the folded permission review_item, per transport.
 *
 * Both the interactive Claude shell hook and the OMP gate extension reach
 * `handleShellApprovalRequest` over the same socket, so the source is the only
 * thing in the row that records which substrate is actually blocked.
 * (Codex has its own, `CODEX_APP_SERVER_APPROVAL_SOURCE`.)
 */
const APPROVAL_SOURCE_INTERACTIVE = 'approval:interactive';
const APPROVAL_SOURCE_OMP = 'approval:omp';

/**
 * One held-open shell-approval socket awaiting a human verdict.
 *
 * The async-deferred `shell-approval-request` branch retains the client socket
 * (no synchronous response) and registers an in-flight entry here so two
 * cleanup paths can find it later:
 *  - the socket's own 'close'/'error' (orchestrator-down / hook subprocess
 *    died) clears the pending approval so the run does not leak in
 *    awaiting_review; and
 *  - the per-run cancel affordance (denyInFlightShellApprovals) writes a deny
 *    verdict and closes every socket for the run so a torn-down PTY unblocks.
 */
interface InFlightShellApproval {
  client: net.Socket;
  requestId: string;
  /** Set once requestApproval's transaction commits — used by cancel cleanup. */
  approvalId?: string;
  /** Detaches the per-socket 'close'/'error' disconnect listeners. */
  detachListeners: () => void;
}

/**
 * One OMP tool call whose approval outlived its requester.
 *
 * The omp-sdk gate can only block for ~25s (OMP kills extension handlers at
 * 30s), so its socket routinely goes away while the question is still worth
 * asking. The approval stays pending — {@link ApprovalRouter.orphanPendingForRun}
 * — and this entry is how the two halves find each other again:
 *
 *   - `client === null` while nobody is waiting; the verdict, when it lands, is
 *     parked in `decision` instead of being written to a dead socket.
 *   - the model's RETRY of the identical call re-attaches its fresh socket here
 *     rather than opening a second approval, so one human answer maps to one
 *     execution and the queue does not fill with duplicates of the same ask.
 *
 * `parked` is SINGLE-USE: consumed by the first matching retry and deleted.
 * A human's "yes" authorizes the call they were shown, not every future call
 * that happens to serialize identically. It also EXPIRES — see
 * {@link OMP_PARKED_DECISION_MAX_AGE_MS}.
 */
/**
 * How long a verdict that arrived with no requester keeps authorizing a retry.
 *
 * The ENTRY itself is deliberately not reaped — it must survive across turns so
 * a retry re-attaches to its own card instead of opening a duplicate, and a TTL
 * on it destroys exactly that. A parked DECISION is a different object: it is a
 * consumable authorization, and the window it stays valid in used to be bounded
 * only by the gate's ~25s budget. Raising that budget to 30 minutes
 * (`OMP_RAISED_DECISION_BUDGET_MS`) turned an incidental bound into a real one:
 * without this, a "yes" the human gave could sit in memory for the rest of the
 * run and authorize a call the model issues much later, in a context the human
 * never saw.
 *
 * Expiry is not silent — the retry falls through to a FRESH approval, so the
 * human is asked again rather than the call being denied out from under them.
 * Two minutes is generous for the mechanism this serves: OMP retries an
 * identical call within the same turn, seconds after the handler returns.
 */
const OMP_PARKED_DECISION_MAX_AGE_MS = 120_000;

interface DeferredOmpApproval {
  /** Live requester, or null while the approval is orphaned. */
  client: net.Socket | null;
  /** requestId of the CURRENT requester — a retry replaces it. */
  requestId: string;
  /**
   * Verdict that arrived with no requester attached. Single-use, and stamped so
   * it can also expire: see {@link OMP_PARKED_DECISION_MAX_AGE_MS}. One object
   * rather than two optional fields, so "decided" and "when" cannot drift.
   */
  parked?: { decision: ApprovalDecision; at: number };
  /**
   * The approvals row this entry owns, once ApprovalRouter has minted it.
   *
   * Undefined only in the window between putDeferredOmpApproval and the
   * onCreated callback — a window a socket death can land in, which is why the
   * detach path re-checks rather than assuming it is set. Needed to mark the ask
   * un-awaited when the gate stops waiting, and awaited again when a retry
   * re-attaches.
   */
  approvalId?: string;
}

/**
 * Identity of a tool call for retry matching: name + a key-ordered serialization
 * of its arguments.
 *
 * Key-ORDERED rather than raw `JSON.stringify` because the retry is a fresh
 * serialization from the model, and object key order is not guaranteed stable
 * across turns; without the sort an identical call could miss its own orphaned
 * approval and open a duplicate card. Recursive so nested argument objects sort
 * too. Non-plain values fall back to their JSON form.
 */
function ompCallKey(toolName: string, toolInput: Record<string, unknown>): string {
  return `${toolName}\u0000${stableJson(toolInput)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The INTERACTIVE-substrate hook family: the async-deferred shell PreToolUse
 * gate (`shell-approval-request`, both the Claude shell hook and the OMP gate
 * extension), the Stop turn-end ack (`interactive-turn-end`) and the
 * AskUserQuestion notify (`interactive-question-open`). Split out of
 * McpQueryHandler (issue #19) with every method body verbatim; the handler
 * routes the three message types here and forwards its public
 * `cancelInFlightShellApprovals` to the one below.
 */
export class InteractiveHookHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: InteractiveHookContext['writeResponse'];
  private readonly resolveRunWorktree: InteractiveHookContext['resolveRunWorktree'];

  /**
   * In-flight shell-approval sockets, keyed by runId. The shell transport holds
   * the connection open across the multi-minute human-decision window, so the
   * socket must be reachable by both the disconnect-cleanup path and the cancel
   * affordance the interactive manager calls before killing the PTY.
   */
  private readonly inFlightShellApprovals = new Map<string, Set<InFlightShellApproval>>();

  /**
   * Orphaned OMP approvals, keyed runId → {@link ompCallKey} → entry. Populated
   * only on the omp-sdk lane; cleared with the run's in-flight sockets.
   */
  private readonly ompDeferredApprovals = new Map<string, Map<string, DeferredOmpApproval>>();

  constructor(ctx: InteractiveHookContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
    this.resolveRunWorktree = ctx.resolveRunWorktree;
  }

  // --------------------------------------------------------------------------
  // shell-approval-request (interactive substrate, IDEA-013 S5 / TASK-810)
  // --------------------------------------------------------------------------

  // OBSERVE-ONLY sprint-lane auto-derive lives in SprintLaneStore
  // .deriveLaneFromTaskDispatch (substrate-agnostic, shared with the SDK
  // PreToolUse seam in preToolUseHookHelper.ts). handleShellApprovalRequest
  // invokes it for the INTERACTIVE substrate; see the call at the top of that
  // method.

  /**
   * Async-deferred PreToolUse gate for the INTERACTIVE substrate.
   *
   * Unlike every other branch in this handler, this one does NOT writeResponse
   * synchronously. The hook subprocess (preToolUseShellHook.ts) blocks on the
   * held-open socket for the FULL human-decision window; we reply only once the
   * verdict is known — via the socketReply closure passed to requestApproval,
   * possibly minutes later. The per-connection socket therefore stays alive
   * across the wait (TASK-798's fire-and-forget dispatch tolerates this).
   *
   * Flow (mirrors the SDK PreToolUse hook at claudeCodeManager.ts:572-587):
   *   (a) reject the 'orchestrator' sentinel runId (parity with the checkpoint /
   *       report-step guards) — a deny with no approvals row;
   *   (a2) acceptEdits fast-path (Step F): when the run's effective mode (from
   *       permission_mode_snapshot) is 'acceptEdits' and the tool is in the
   *       acceptEdits auto-approve surface (Edit/Write/MultiEdit + the widened
   *       read-only surface — safe reads + provably read-only Bash/git, via
   *       isAcceptEditsAutoApprovable), AUTO-ALLOW with ZERO approvals row and NO
   *       folded review_item — SDK-mapper parity, applied BEFORE the allow-list check;
   *   (b) apply isToolAllowed(loadMergedPermissionRules(worktree)) and
   *       short-circuit ALLOW with ZERO approvals row (no double-prompt);
   *   (c) otherwise route through ApprovalRouter.requestApproval, writing the
   *       verdict back on the held-open socket from the socketReply closure.
   *
   * The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
   * interactive settingsWriter opt-out), so this handler is only reached under
   * 'default' (full gate) and 'acceptEdits' (the (a2) fast-path + gate for
   * non-edit tools).
   *
   * P4 fold: requestApproval co-writes a blocking permission review_item into the
   * unified inbox (source 'approval:interactive', or 'approval:omp' when the
   * requester is the OMP gate extension) inside its own transaction. The
   * socket-held-open contract is UNCHANGED — the review_item is purely additive
   * and the socketReply closure remains the only place a verdict is written.
   *
   * CYBOFLOW_RUN_ID precondition (TASK-800): if runId is not a real
   * workflow_runs.id (e.g. still the Claude session UUID), requestApproval's
   * guarded UPDATE finds changes===0 → RunNotRunningError → we surface a logged
   * precondition failure and reply deny — never a silent swallow.
   *
   * AskUserQuestion is intentionally NOT special-cased here: a shell PreToolUse
   * hook has no `updatedInput` channel, so QuestionRouter is never wired on this
   * substrate (native-TUI-only, Probe A2). It simply routes as a normal gate.
   */
  handleShellApprovalRequest(
    msg: Extract<McpQueryMessage, { type: 'shell-approval-request' }>,
    client: net.Socket,
  ): void {
    // AUTO-DERIVE sprint lane steps (observe-only). Fire-and-forget side-effect:
    // never writes to the socket, never alters the allow/deny verdict. Runs
    // BEFORE the gating flow so it is independent of the verdict path; the store
    // method is a strict no-op for non-sprint runs / non-Task tools / unknown
    // subagent_types / ambiguous attribution. getInstance() is wrapped because
    // some handler tests never initialize SprintLaneStore — a missing store must
    // not disturb the deny-gating contract below (byte-for-byte unchanged).
    try {
      SprintLaneStore.getInstance().deriveLaneFromTaskDispatch({
        runId: msg.runId,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
      });
    } catch {
      // SprintLaneStore not initialized — auto-derive is best-effort.
    }

    // (a) Orchestrator-sentinel guard — mirrors handleSubmitCheckpoint /
    // handleReportStep. The singleton MCP server runs with
    // CYBOFLOW_RUN_ID='orchestrator', which has no workflow_runs row.
    if (msg.runId === 'orchestrator') {
      this.writeShellVerdict(client, msg.requestId, { behavior: 'deny' });
      return;
    }

    // (a2) acceptEdits fast-path (Step F): when the run's effective 4-mode is
    // 'acceptEdits' and the tool is in the acceptEdits auto-approve surface
    // (Edit/Write/MultiEdit + the widened read-only surface), AUTO-ALLOW with
    // ZERO approvals row and NO folded review_item — parity with the SDK mapper's
    // acceptEdits branch (permissionModeMapper.ts shares the SAME
    // isAcceptEditsAutoApprovable predicate). This runs BEFORE the allow-list
    // check so a safe edit/read never needs a permissions.allow entry.
    //
    // The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
    // settingsWriter opt-out — interactiveClaudeManager.ts), so the hook does not
    // fire and this handler is not reached for them; 'default' falls through to
    // the existing allow-list + router gate unchanged.
    const effectiveMode = this.resolveRunPermissionMode(msg.runId);
    if (
      effectiveMode === 'acceptEdits' &&
      isAcceptEditsAutoApprovable(msg.toolName, msg.toolInput)
    ) {
      this.writeShellVerdict(client, msg.requestId, { behavior: 'allow' });
      return;
    }

    // (b) Resolve runId → worktree (the run cwd) for the allow-list lookup.
    const worktree = this.resolveRunWorktree(msg.runId);
    if (worktree !== null) {
      try {
        const rules = loadMergedPermissionRules(worktree);
        if (isToolAllowed(msg.toolName, msg.toolInput, rules)) {
          // SDK parity: auto-allow with ZERO approvals row, no router round-trip.
          this.writeShellVerdict(client, msg.requestId, { behavior: 'allow' });
          return;
        }
      } catch (err) {
        // A settings-read failure must not crash the gate — fall through to the
        // router so the human is still asked (conservative, never auto-allow).
        this.logger?.warn(
          '[Cyboflow MCP Query] shell-approval allow-list check failed; routing to ApprovalRouter',
          { runId: msg.runId, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // (c0) omp-sdk lane: does this call already have an approval in flight?
    // A retry of an identical call must land on the ORIGINAL ask rather than
    // opening a second one — see DeferredOmpApproval. Two hits are possible:
    // a verdict that arrived while nobody was waiting (answer it now, single
    // use), or an ask still sitting in the human's queue (re-attach and wait).
    const ompKey = msg.substrate === 'omp' ? ompCallKey(msg.toolName, msg.toolInput) : null;
    if (ompKey !== null) {
      const deferred = this.ompDeferredApprovals.get(msg.runId)?.get(ompKey);
      if (deferred?.parked !== undefined) {
        const { decision, at } = deferred.parked;
        // Consumed either way — a stale verdict is spent, not left to be picked
        // up by a later retry.
        this.dropDeferredOmpApproval(msg.runId, ompKey);
        if (Date.now() - at <= OMP_PARKED_DECISION_MAX_AGE_MS) {
          this.logger?.debug(
            '[Cyboflow MCP Query] omp retry matched a decided approval — replaying the human verdict',
            { runId: msg.runId, toolName: msg.toolName, decision: decision.behavior },
          );
          this.writeShellVerdict(client, msg.requestId, decision);
          return;
        }
        // Too old to stand in for consent. Falling through opens a fresh
        // approval below, so the human is ASKED again rather than denied.
        this.logger?.debug(
          '[Cyboflow MCP Query] omp parked verdict expired — asking the human again',
          { runId: msg.runId, toolName: msg.toolName, ageMs: Date.now() - at },
        );
      } else if (deferred !== undefined) {
        // Still awaiting the human. Adopt the fresh socket as the requester and
        // register it so ITS disconnect is observed too; no second approvals row.
        deferred.client = client;
        deferred.requestId = msg.requestId;
        this.registerInFlightShellApproval(msg.runId, msg.requestId, client, msg.substrate);
        // Someone is blocked on this ask again — undo the un-awaited mark the
        // previous hangup left, so the queue stops describing a live wait as a
        // standing question.
        if (deferred.approvalId !== undefined) {
          this.setOmpApprovalAwaited(deferred.approvalId, true);
        }
        this.logger?.debug(
          '[Cyboflow MCP Query] omp retry re-attached to the pending approval',
          { runId: msg.runId, toolName: msg.toolName },
        );
        return;
      }
      this.putDeferredOmpApproval(msg.runId, ompKey, { client, requestId: msg.requestId });
    }

    // (c) Route through ApprovalRouter. Register the held-open socket FIRST so a
    // disconnect during the (async) requestApproval transaction is observed.
    const entry = this.registerInFlightShellApproval(
      msg.runId,
      msg.requestId,
      client,
      msg.substrate,
    );

    const router = ApprovalRouter.getInstance();
    void router
      .requestApproval(
        msg.runId,
        msg.toolName,
        msg.toolInput,
        (decision) => {
          // socketReply: the ONLY place a verdict is written for this transport.
          // (Under the SDK path this closure is a no-op; the shell transport uses
          // it — load-bearing, held open across the human-decision window.)
          this.completeInFlightShellApproval(msg.runId, entry);
          // On the omp lane the requester may have changed (a retry re-attached)
          // or gone (budget expired), so the deferred entry — not this closure's
          // captured socket — is the authority on where the verdict goes.
          if (ompKey !== null) {
            this.deliverDeferredOmpVerdict(msg.runId, ompKey, decision);
            return;
          }
          this.writeShellVerdict(client, msg.requestId, decision);
        },
        // P4: stamp the folded permission review_item with the substrate that
        // actually asked. Both transports arrive here, and reading every OMP ask
        // as an interactive-shell one makes the inbox lie about which agent is
        // blocked — the same attribution gap the pending-approval card had.
        // The co-write happens inside requestApproval's transaction (commit 1);
        // the socketReply closure above is unchanged.
        ompKey === null ? APPROVAL_SOURCE_INTERACTIVE : APPROVAL_SOURCE_OMP,
        // omp lane only: record which approval this deferred entry owns, so the
        // ~25s hangup can mark it un-awaited. The entry may already be gone (a
        // fail-closed catch dropped it); then there is nothing to record.
        ompKey === null
          ? undefined
          : (approvalId) => {
              const entry = this.ompDeferredApprovals.get(msg.runId)?.get(ompKey);
              if (entry === undefined) return;
              entry.approvalId = approvalId;
              // The gate can hang up DURING requestApproval's transaction, which
              // parks the entry before it ever learns its id. Reconcile here
              // rather than leaving the card claiming a wait that already ended.
              if (entry.client === null) this.setOmpApprovalAwaited(approvalId, false);
            },
      )
      .then((decision) => {
        // requestApproval resolves with the SAME decision the socketReply got
        // (or a synthetic deny when the run was canceled before the socketReply
        // fired). If the socketReply never ran (cancel/supersede path), settle
        // the held-open socket so the PTY does not hang.
        if (this.completeInFlightShellApproval(msg.runId, entry)) {
          if (ompKey !== null) {
            this.deliverDeferredOmpVerdict(msg.runId, ompKey, decision);
            return;
          }
          this.writeShellVerdict(client, msg.requestId, decision);
        }
      })
      .catch((err) => {
        // Precondition failure (TASK-800): a non-real runId binds a non-existent
        // workflow_runs row → guarded UPDATE changes===0 → RunNotRunningError.
        // Surface it loudly and fail closed (deny) rather than silently swallow.
        if (err instanceof RunNotRunningError) {
          this.logger?.error(
            '[Cyboflow MCP Query] shell-approval precondition failed: runId is not a running workflow_runs.id ' +
              '(is CYBOFLOW_RUN_ID the session UUID instead of workflow_runs.id?) — failing closed (deny)',
            { runId: msg.runId },
          );
        } else {
          this.logger?.error('[Cyboflow MCP Query] shell-approval requestApproval failed — failing closed (deny)', {
            runId: msg.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.completeInFlightShellApproval(msg.runId, entry)) {
          const failClosed: ApprovalDecision = {
            behavior: 'deny',
            message: 'cyboflow approval precondition failed',
          };
          // A precondition failure is terminal for this ask: drop the deferred
          // entry so a retry re-asks cleanly rather than replaying the deny.
          if (ompKey !== null) this.dropDeferredOmpApproval(msg.runId, ompKey);
          this.writeShellVerdict(client, msg.requestId, failClosed);
        }
      });
  }

  /**
   * Deny-and-close every in-flight shell-approval socket for `runId`.
   *
   * This is the transport-aware twin of ApprovalRouter.clearPendingForRun,
   * which deliberately does NOT invoke socketReply ("the run is being torn down;
   * the socket is no longer meaningful") — correct for the in-process SDK
   * transport but WRONG for the shell transport, where a real socket is blocking
   * a real PTY. The interactive manager's cleanupCliResources (TASK-808) calls
   * this BEFORE killing the PTY so the blocked hook subprocess unblocks; it then
   * calls clearPendingForRun to settle the router's DB rows.
   *
   * For each in-flight socket: write a deny verdict (so the hook's fail-closed
   * path fires) and end the connection. Idempotent — safe to call when nothing
   * is in flight.
   *
   * @returns the number of sockets denied/closed.
   */
  cancelInFlightShellApprovals(runId: string): number {
    const set = this.inFlightShellApprovals.get(runId);
    if (!set || set.size === 0) return 0;

    // Snapshot before mutating — completeInFlightShellApproval deletes entries.
    const entries = [...set];
    for (const entry of entries) {
      if (!this.completeInFlightShellApproval(runId, entry)) continue;
      try {
        this.writeShellVerdict(entry.client, entry.requestId, {
          behavior: 'deny',
          message: 'Run was canceled before approval could be processed',
        });
      } catch (err) {
        this.logger?.debug('[Cyboflow MCP Query] shell-approval cancel write failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        entry.client.end();
      } catch {
        // best-effort close
      }
    }
    // Run teardown ends every deferred ask too: the parked verdicts and
    // still-pending entries are meaningless once the run is gone, and
    // clearPendingForRun's DB sweep settles their rows.
    this.ompDeferredApprovals.delete(runId);
    this.logger?.debug('[Cyboflow MCP Query] denied in-flight shell-approval sockets on cancel', {
      runId,
      count: entries.length,
    });
    return entries.length;
  }

  // --------------------------------------------------------------------------
  // interactive-turn-end (INTERACTIVE substrate Stop hook, IDEA-030)
  // --------------------------------------------------------------------------

  /**
   * Fire-and-ack: unlike shell-approval-request, there is no verdict to defer
   * — the Stop hook (stopShellHook.ts) does not gate anything, it only reports
   * that a turn ended, and it already applies its OWN bounded wait for this ack.
   * Routes to the injected `onInteractiveTurnEnd` dep (absent in tests/hosts
   * that never wired it — e.g. a bare OrchSocketServer in a unit test), which
   * this layer cannot reach directly (ORCHESTRATOR LAYERING RULE: no
   * main/src/services imports here).
   *
   * `ok:true` iff a live interactive run for `runId` was found and notified;
   * `ok:false` with `error:'turn_end_unavailable'` when the dep is missing OR
   * it reports no matching run — either way the hook script (which exits 0
   * unconditionally regardless of this response) has nothing to act on.
   */
  handleInteractiveTurnEnd(
    msg: Extract<McpQueryMessage, { type: 'interactive-turn-end' }>,
    client: net.Socket,
  ): void {
    const notified = typeof msg.runId === 'string' && msg.runId.length > 0
      ? (this.deps.onInteractiveTurnEnd?.(msg.runId) ?? false)
      : false;

    if (!notified) {
      this.logger?.debug('[Cyboflow MCP Query] interactive-turn-end had no effect', {
        runId: msg.runId,
        depWired: this.deps.onInteractiveTurnEnd !== undefined,
      });
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: notified,
      ...(notified ? {} : { error: 'turn_end_unavailable' }),
    });
  }

  /**
   * "Parked on an AskUserQuestion gate" signal from the interactive
   * PreToolUse(AskUserQuestion) notify hook. Flips the run's quick-session board
   * state to `blocked` via the injected dep (interactiveClaudeManager
   * .notifyQuestionOpen). Fire-and-ack — the hook never gates the question, so we
   * always reply `ok:true` (the notification is best-effort; a missing dep just
   * means the board won't show `blocked` for this PTY session).
   */
  handleInteractiveQuestionOpen(
    msg: Extract<McpQueryMessage, { type: 'interactive-question-open' }>,
    client: net.Socket,
  ): void {
    if (typeof msg.runId === 'string' && msg.runId.length > 0) {
      this.deps.onInteractiveQuestionOpen?.(msg.runId);
    }
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
    });
  }

  /**
   * Resolve the run's effective 4-mode agentPermissionMode from its owning
   * SESSION (`sessions.agent_permission_mode`), keyed on the run via the
   * `workflow_runs → sessions` join (permission-mode redesign §3c#3). The
   * session is the execution authority; the `permission_mode_snapshot` column is
   * demoted to audit-only.
   *
   * Returns null when the run row is absent, the join misses (a legacy sentinel
   * whose `session_id` was never backfilled ⇒ LEFT JOIN yields NULL), or the
   * column holds an unrecognized value — the caller then falls through to the
   * existing allow-list + router gate (conservative; never auto-allows on an
   * unknown/absent mode). The join-miss case cannot strand a dontAsk/acceptEdits
   * session in prompt-everything beyond the first mint-on-read turn (the
   * sentinel's `session_id` is stamped at creation). Used by the acceptEdits
   * fast-path; the 'auto'/'dontAsk' modes never reach this handler (no shell hook
   * installed).
   */
  private resolveRunPermissionMode(runId: string): PermissionMode | null {
    const row = this.db
      .prepare(
        `SELECT s.agent_permission_mode AS m
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { m?: unknown } | undefined;
    const m: unknown = row?.m;
    return isPermissionMode(m) ? m : null;
  }

  /**
   * Register a held-open shell-approval socket so the disconnect-cleanup and
   * cancel paths can find it. Attaches one-shot 'close'/'error' listeners that
   * clear the pending approval if the socket dies before a verdict (so the run
   * does not leak in awaiting_review).
   */
  private registerInFlightShellApproval(
    runId: string,
    requestId: string,
    client: net.Socket,
    substrate?: 'omp',
  ): InFlightShellApproval {
    const onDisconnect = (): void => {
      // Socket died before a verdict (orchestrator-down / hook subprocess died).
      if (!this.completeInFlightShellApproval(runId, entry)) return;

      // omp-sdk: the requester stopping is EXPECTED, not a death. OMP caps
      // extension handlers at 30s, so the gate hangs up at 25s on every ask a
      // human has not answered yet — settling here is what turned 17 live
      // approvals into 17 system rejections on 2026-08-19. Keep the ask (and its
      // review-queue card) alive, park the requester, and hand the run's gate
      // back so the session keeps executing.
      if (substrate === 'omp') {
        this.detachDeferredOmpRequester(runId, client);
        this.logger?.debug(
          '[Cyboflow MCP Query] omp gate stopped waiting — approval stays pending for the human',
          { runId },
        );
        try {
          ApprovalRouter.getInstance().orphanPendingForRun(runId);
        } catch (err) {
          this.logger?.debug('[Cyboflow MCP Query] orphanPendingForRun on disconnect failed', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      this.logger?.warn(
        '[Cyboflow MCP Query] shell-approval socket disconnected before verdict — clearing pending approval',
        { runId },
      );
      // Clear the pending approval so the run does not leak in awaiting_review.
      // ABANDONMENT, not termination: the run is still executing, only its
      // requester went away (gate-extension decision budget expired, hook
      // subprocess died). abandonPendingForRun therefore also restores
      // awaiting_review → running — clearPendingForRun would settle the approval
      // and leave the run wedged, making every later requestApproval loop in the
      // 'wait' branch with no row inserted and no gate ever shown. It is a no-op
      // socketReply path (correct here — the socket is already gone) and
      // idempotently settles the DB row.
      try {
        ApprovalRouter.getInstance().abandonPendingForRun(runId);
      } catch (err) {
        this.logger?.debug('[Cyboflow MCP Query] abandonPendingForRun on disconnect failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    client.on('close', onDisconnect);
    client.on('error', onDisconnect);

    const entry: InFlightShellApproval = {
      client,
      requestId,
      detachListeners: () => {
        client.off('close', onDisconnect);
        client.off('error', onDisconnect);
      },
    };

    let set = this.inFlightShellApprovals.get(runId);
    if (!set) {
      set = new Set<InFlightShellApproval>();
      this.inFlightShellApprovals.set(runId, set);
    }
    set.add(entry);

    this.logger?.debug('[Cyboflow MCP Query] shell-approval registered (held open)', { runId, requestId });
    return entry;
  }

  /**
   * Remove an in-flight entry and detach its disconnect listeners.
   *
   * @returns true if THIS call removed a live entry (so the caller should write
   *   the verdict); false if the entry was already settled by a concurrent path
   *   (disconnect / cancel / a prior resolve) — the caller must then NOT write,
   *   preserving the exactly-once verdict contract.
   */
  /** Record a fresh omp-lane ask so its retries and its verdict can find it. */
  private putDeferredOmpApproval(runId: string, key: string, entry: DeferredOmpApproval): void {
    let byKey = this.ompDeferredApprovals.get(runId);
    if (!byKey) {
      byKey = new Map<string, DeferredOmpApproval>();
      this.ompDeferredApprovals.set(runId, byKey);
    }
    byKey.set(key, entry);
  }

  private dropDeferredOmpApproval(runId: string, key: string): void {
    const byKey = this.ompDeferredApprovals.get(runId);
    if (!byKey) return;
    byKey.delete(key);
    if (byKey.size === 0) this.ompDeferredApprovals.delete(runId);
  }

  /**
   * Park the requester whose socket just died, WITHOUT touching the ask.
   *
   * Matched by socket identity, not by key: a retry may already have adopted
   * this entry with a newer socket, and the older socket's late 'close' must not
   * unhook the live one.
   */
  private detachDeferredOmpRequester(runId: string, client: net.Socket): void {
    const byKey = this.ompDeferredApprovals.get(runId);
    if (!byKey) return;
    for (const entry of byKey.values()) {
      if (entry.client !== client) continue;
      entry.client = null;
      // Nothing is blocked on this ask any more. The row stays pending — a
      // retry can still collect the verdict, even in a later turn — but the
      // queue must stop painting it as a halted agent.
      if (entry.approvalId !== undefined) this.setOmpApprovalAwaited(entry.approvalId, false);
    }
  }

  /**
   * Mark an omp approval awaited / un-awaited, fail-soft.
   *
   * Wrapped because both callers sit on hot, un-catchable paths — a socket
   * 'close' listener and the router's own onCreated callback — where a throw
   * would take down the disconnect handler or roll back a committed grab.
   */
  private setOmpApprovalAwaited(approvalId: string, awaited: boolean): void {
    try {
      ApprovalRouter.getInstance().setAwaited(approvalId, awaited);
    } catch (err) {
      this.logger?.debug('[Cyboflow MCP Query] setAwaited failed', {
        approvalId,
        awaited,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deliver an omp-lane verdict to whoever is waiting — or to nobody.
   *
   * With a requester attached this writes the verdict and the ask is done. With
   * none (the gate's budget expired and no retry has arrived yet) the decision
   * is PARKED for the next identical call, so a human answering a minute late
   * still authorizes the work instead of the model re-asking from scratch.
   */
  private deliverDeferredOmpVerdict(
    runId: string,
    key: string,
    decision: ApprovalDecision,
  ): void {
    const entry = this.ompDeferredApprovals.get(runId)?.get(key);
    if (!entry) return;
    if (entry.client === null) {
      entry.parked = { decision, at: Date.now() };
      this.logger?.debug(
        '[Cyboflow MCP Query] omp verdict arrived with no requester — parked for the retry',
        { runId, decision: decision.behavior },
      );
      return;
    }
    const { client, requestId } = entry;
    this.dropDeferredOmpApproval(runId, key);
    this.writeShellVerdict(client, requestId, decision);
  }

  private completeInFlightShellApproval(runId: string, entry: InFlightShellApproval): boolean {
    const set = this.inFlightShellApprovals.get(runId);
    if (!set || !set.has(entry)) return false;
    set.delete(entry);
    if (set.size === 0) this.inFlightShellApprovals.delete(runId);
    entry.detachListeners();
    return true;
  }

  /**
   * Write a PreToolUse verdict back to a held-open shell-approval socket. The
   * wire shape mirrors the synchronous branches:
   *   {type:'mcp-query-response',requestId,ok:true,data:{permissionDecision,...}}
   * The hook subprocess correlates the response by requestId on the shared socket.
   */
  private writeShellVerdict(
    client: net.Socket,
    requestId: string,
    decision: ApprovalDecision,
  ): void {
    const data: { permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string } = {
      permissionDecision: decision.behavior,
      ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
    };
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: true,
      data,
    });
  }
}
