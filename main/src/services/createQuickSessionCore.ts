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
import {
  claudeRuntimeFromSubstrate,
  isWorkflowRunStorableRuntime,
  providerForRuntime,
  type AgentProvider,
  type SessionAgentRuntime,
  type WorkflowRunStorableRuntime,
} from '../../../shared/types/agentRuntime';
import { transitionToRunning } from './cyboflow/transitions';
import { assertTransitionAllowed } from '../../../shared/workflows/runStateMachine';
import { isPtyLane } from './panelLane';
import { normalizePathSeparators } from '../utils/posixPath';
import { isRemoteHostId, type HostsFeatureStatus, type HostView } from '../../../shared/types/hosts';
import { getRemoteCheckout } from './hosts/remoteCheckoutBridge';

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
  baseBranch?: string;
  baseCommittish?: string;
  toolType?: 'claude' | 'none';
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
  agentModel?: string | null;
  /** Work directly in the project checkout — no dedicated worktree (migration 047). */
  inPlace?: boolean;
  claudeConfig?: { model?: string; permissionMode?: 'approve' | 'ignore' };
  /** Remote environment (M2); absent = This Mac. Only a validated remote id is ever set. */
  hostId?: string | null;
}

/** The collaborators the core needs — structural so both IPC + boot wiring inject them. */
export interface CreateQuickSessionCoreDeps {
  taskQueue: {
    createSession(data: QuickSessionJobData): Promise<{ id: string }>;
    /** Job-failure feed (TaskQueue.onSessionJobFailed); returns the disposer. */
    onSessionJobFailed(listener: (jobId: string, error: Error) => void): () => void;
  };
  /** SessionManager EventEmitter surface (session-created fires when the worktree+row land). */
  sessionManager: {
    on(event: 'session-created', listener: (s: QuickSessionRow) => void): void;
    removeListener(event: 'session-created', listener: (s: QuickSessionRow) => void): void;
    /**
     * Hide a session row (SessionManager.archiveSession). Optional: used only to retire a REMOTE session that
     * surfaced after its waiter gave up, when no {@link CreateQuickSessionCoreDeps.dismissHalfCreatedSession} is wired.
     */
    archiveSession?(sessionId: string): Promise<void>;
  };
  workflowRegistry: {
    ensureQuickWorkflow(projectId: number): string;
    createRun(
      workflowId: string,
      requestedSubstrate?: CliSubstrate,
      sessionId?: string,
      requestedPermissionMode?: PermissionMode,
      opts?: {
        requestedModel?: string;
        requestedAgentProvider?: AgentProvider;
        /** STORABLE: the sentinel carries the SESSION's runtime — see below. */
        requestedAgentRuntime?: WorkflowRunStorableRuntime;
        requireSdkSubstrate?: boolean;
      },
    ): { runId: string; substrate: CliSubstrate };
    // NOTE: this structural interface only declares the subset of
    // WorkflowRegistry.createRun's opts the core actually threads (model /
    // provider / runtime / requireSdkSubstrate) — TypeScript structural typing
    // means the REAL WorkflowRegistry (whose createRun opts object carries many
    // more optional fields) still satisfies this shape at the real injection
    // site (cyboflow.workflowRegistry in ipc/session.ts).
  };
  getDb(): Database.Database;
  /**
   * Optional FULL session-dismiss (cancel hosted runs + remove worktree) used to
   * COMPENSATE a half-created session. The worktree + session row are provisioned
   * (taskQueue.createSession) BEFORE the sentinel `createRun` validates the
   * substrate/runtime combo, so a rejected combo (e.g. substrate 'interactive'
   * with agentRuntime 'codex-sdk') throws AFTER provisioning. Without this the
   * session + worktree leak — the caller never receives the id (the throw pre-empts
   * the return), so only the core, which holds the id, can clean it up. Wired to
   * dismissSessionFully by the boot layer; an absent callback keeps prior behavior.
   */
  dismissHalfCreatedSession?: (sessionId: string) => Promise<void>;
}

export interface CreateQuickSessionCoreOptions {
  projectId: number;
  /** Worktree branch/template name; the caller generates a stable hint. */
  nameHint: string;
  /** SHA-pin the worktree branch to an exact commit (A/B arms). */
  baseCommittish?: string;
  baseBranch?: string;
  toolType?: 'claude' | 'none';
  /** Persist ownership on the initial session INSERT, before session-created fires. */
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
  agentModel?: string | null;
  claudeConfig?: { model?: string; permissionMode?: 'approve' | 'ignore' };
  /** Per-run substrate/permission choice threaded into the sentinel createRun (quick handler). */
  requestedSubstrate?: CliSubstrate;
  requestedAgentMode?: PermissionMode;
  /**
   * Design Mode defense-in-depth (design-mode.md "Session plumbing —
   * SDK-pinned, fail-closed"): set true by the design branch of
   * sessions:create-quick to thread WorkflowRegistry.createRun's
   * requireSdkSubstrate guard, which throws post-resolution if the substrate
   * ladder resolves to anything other than 'sdk'. Undefined/false for every
   * non-design quick session (byte-identical behavior).
   */
  requireSdkSubstrate?: boolean;
  /**
   * Work directly in the project checkout — no dedicated worktree (migration 047,
   * quick handler only; A/B arms are always worktree-isolated so they never set
   * this). Switches session matching to the NAME fallback (worktreePath === the
   * project path, never `/${nameHint}`).
   */
  inPlace?: boolean;
  /**
   * Remote environment (M2) the session runs on — set ONLY by sessions:create-quick, after
   * {@link resolveQuickSessionHost} validated it. Every other caller omits it (This Mac).
   */
  hostId?: string | null;
  /**
   * Await budget for the session-created event (default 30s; a REMOTE session defaults to
   * {@link REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS}, its provisioning budget).
   */
  timeoutMs?: number;
}

export interface CreateQuickSessionCoreResult {
  session: QuickSessionRow;
  runId: string;
  resolvedSubstrate: CliSubstrate;
  jobId: string;
}

/** The local default await budget for the session-created event. */
const LOCAL_QUICK_SESSION_CREATE_TIMEOUT_MS = 30_000;

/**
 * The await budget for a REMOTE session's session-created event. A remote session-create job provisions the
 * environment worktree BEFORE session-created fires (services/taskQueue.ts → RemoteCheckout.ensureSessionWorktree),
 * so the waiter must outlast that work, not the local 30s. Mirrors the step budgets in services/hosts/remoteCheckout.ts:
 * the bare-repo lock wait (5 min) + its git steps, the base push of possibly the full history (30 min), the worktree
 * add (10 min), plus a few 60s git probes — rounded up to 50 minutes. KEEP IN SYNC with those constants.
 */
export const REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS = 50 * 60_000;

export const REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE =
  'Setting up the session on its environment took too long, so cyboflow stopped waiting. ' +
  'If the setup finishes later, the session is removed from the environment automatically. Try again, or check the environment from Environments.';

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
  const remote = isRemoteHostId(opts.hostId);

  // Job failures are subscribed BEFORE the job is enqueued: the processor's
  // throw is otherwise swallowed into a queue log line, and the only thing the
  // caller would ever see is its own 30s timeout (that is how a missing git /
  // git identity hid for a whole release). The id is not known until
  // createSession resolves, so failures that land in between are parked by id
  // and re-checked once it is.
  const failedJobs = new Map<string, Error>();
  let onJobFailed: (jobId: string, error: Error) => void = (jobId, error) => {
    failedJobs.set(jobId, error);
  };
  const unsubscribeJobFailed = taskQueue.onSessionJobFailed((jobId, error) => onJobFailed(jobId, error));

  const job = await taskQueue.createSession({
    prompt: '',
    worktreeTemplate: branchName,
    projectId: opts.projectId,
    baseBranch: opts.baseBranch,
    baseCommittish: opts.baseCommittish,
    toolType: opts.toolType ?? 'claude',
    agentProvider: opts.agentProvider,
    agentRuntime: opts.agentRuntime,
    agentModel: opts.agentModel,
    inPlace,
    claudeConfig: opts.claudeConfig,
    // Remote environment (M2): only a remote id rides the job, so a local payload is unchanged.
    ...(isRemoteHostId(opts.hostId) ? { hostId: opts.hostId } : {}),
  });

  // Await the session row via the session-created event. Concurrent create-quick
  // calls share the emitter, so filter by worktreePath: TaskQueue's
  // ensureUniqueNames may append a `-<n>` suffix on same-second collisions.
  const session = await new Promise<QuickSessionRow>((resolve, reject) => {
    // Path matching is separator-agnostic: worktreePath comes from path.join
    // (worktreeManager), so on Windows it carries BACKSLASHES
    // (C:\proj\.cyboflow\worktrees\<name>) and every '/'-anchored check below
    // would silently never fire. Normalize to '/' first, then compare the final
    // segment — covers the base form and any `<name>-<n>` collision suffix, on
    // both platforms (and a bare-name worktreePath with no separator at all).
    const suffixed = new RegExp(`/${branchName}-\\d+$`);
    // In-place sessions (migration 047) have worktreePath === the project path,
    // never `/${branchName}`, so the path match can never fire — fall back to the
    // session NAME (= worktree template), with the same ` <n>` (name) / `-<n>`
    // (worktree) collision suffixes. Scoped to in-place so worktree sessions keep
    // matching by path exactly as before. Names carry no separators, so this
    // branch needs no normalization.
    const nameSuffixed = new RegExp(`^${branchName}[ -]\\d+$`);
    const matchesThisCall = (createdSession: QuickSessionRow): boolean => {
      const wt = normalizePathSeparators(createdSession.worktreePath ?? '');
      const name = createdSession.name ?? '';
      return (
        wt.split('/').pop() === branchName ||
        suffixed.test(wt) ||
        (inPlace && (name === branchName || nameSuffixed.test(name)))
      );
    };
    const onCreated = (createdSession: QuickSessionRow) => {
      if (!matchesThisCall(createdSession)) return;
      // Claim the session id so a concurrent sibling call doesn't also resolve to it.
      if (claimedQuickSessionIds.has(createdSession.id)) return;
      claimedQuickSessionIds.add(createdSession.id);
      cleanup();
      resolve(createdSession);
    };
    const failWith = (error: Error) => {
      cleanup();
      reject(new Error(`Quick session creation failed: ${error.message}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      if (remote) {
        // The remote job is still provisioning and nobody will ever receive its id: retire it when it lands.
        watchForLateRemoteSession(deps, opts.hostId, job.id, matchesThisCall);
        reject(new Error(REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE));
        return;
      }
      reject(new Error('Timed out waiting for quick session to be created'));
    }, opts.timeoutMs ?? (remote ? REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS : LOCAL_QUICK_SESSION_CREATE_TIMEOUT_MS));
    const cleanup = () => {
      clearTimeout(timeout);
      sessionManager.removeListener('session-created', onCreated);
      unsubscribeJobFailed();
    };
    sessionManager.on('session-created', onCreated);
    onJobFailed = (jobId, error) => {
      if (jobId === job.id) failWith(error);
    };
    const alreadyFailed = failedJobs.get(job.id);
    if (alreadyFailed) failWith(alreadyFailed);
  });

  // Everything past here runs AFTER the worktree + session row are provisioned, so
  // any throw (notably createRun rejecting an invalid substrate/runtime combo) would
  // leak the half-created session + worktree. Compensate via dismissHalfCreatedSession
  // (best-effort) before rethrowing — the caller never sees the id on a throw, so this
  // is the only layer that can sweep the orphan.
  try {
    // Wire the __quick__ sentinel run so ApprovalRouter/chat gating work.
    const sentinelWorkflowId = workflowRegistry.ensureQuickWorkflow(opts.projectId);
    // The sentinel is a workflow_runs ROW, not a workflow launch: it must carry
    // whatever runtime the session actually resolved onto, because the dispatch
    // facade reads this row back to pick the owning manager. Gating it on the
    // LAUNCHABLE set instead would silently drop the identity of a runtime that
    // is session-legal but not yet offered as a flow target, misrouting it.
    const sentinelAgentRuntime = isWorkflowRunStorableRuntime(opts.agentRuntime)
      ? opts.agentRuntime
      : undefined;
    const { runId, substrate: resolvedSubstrate } = workflowRegistry.createRun(
      sentinelWorkflowId,
      opts.requestedSubstrate,
      session.id,
      opts.requestedAgentMode,
      {
        ...(sentinelAgentRuntime && opts.agentModel ? { requestedModel: opts.agentModel } : {}),
        ...(sentinelAgentRuntime && opts.agentProvider
          ? { requestedAgentProvider: opts.agentProvider }
          : {}),
        ...(sentinelAgentRuntime ? { requestedAgentRuntime: sentinelAgentRuntime } : {}),
        ...(opts.requireSdkSubstrate ? { requireSdkSubstrate: true } : {}),
      },
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
  } catch (err) {
    // A remote session's worktree lives on its environment: remove it there first (best-effort; the merge-back
    // row records any failure). The local dismiss below then only finds the session row to retire.
    if (isRemoteHostId(opts.hostId)) {
      await getRemoteCheckout()?.removeSessionWorktree(session.id).catch(() => false);
    }
    if (deps.dismissHalfCreatedSession) {
      await deps.dismissHalfCreatedSession(session.id).catch(() => {});
    }
    throw err;
  }
}

/**
 * After a REMOTE create's waiter timed out, the session-create job may still finish: its session-created would then
 * surface a session no caller holds (an orphan with a live environment worktree). Watch for it and retire it — remove
 * the environment worktree, then dismiss (or, unwired, archive) the row. A job that FAILS late needs nothing: the
 * task queue already compensated it. The watch claims the id (so a concurrent sibling waiter cannot resolve to the
 * orphan) and expires after another provisioning budget so a job that never settles cannot leak the listener.
 */
function watchForLateRemoteSession(
  deps: CreateQuickSessionCoreDeps,
  hostId: string | null | undefined,
  jobId: string,
  matches: (s: QuickSessionRow) => boolean,
): void {
  const { sessionManager, taskQueue } = deps;
  let unsubscribeFailed: () => void = () => {};
  const stop = (): void => {
    clearTimeout(expiry);
    sessionManager.removeListener('session-created', onLate);
    unsubscribeFailed();
  };
  const onLate = (late: QuickSessionRow): void => {
    if (!matches(late) || claimedQuickSessionIds.has(late.id)) return;
    claimedQuickSessionIds.add(late.id);
    stop();
    void compensateLateRemoteSession(deps, hostId, late.id);
  };
  const expiry = setTimeout(stop, REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS);
  expiry.unref?.();
  sessionManager.on('session-created', onLate);
  unsubscribeFailed = taskQueue.onSessionJobFailed((failedJobId) => {
    if (failedJobId === jobId) stop();
  });
}

async function compensateLateRemoteSession(
  deps: CreateQuickSessionCoreDeps,
  hostId: string | null | undefined,
  sessionId: string,
): Promise<void> {
  if (isRemoteHostId(hostId)) {
    await getRemoteCheckout()?.removeSessionWorktree(sessionId).catch(() => false);
  }
  if (deps.dismissHalfCreatedSession) {
    await deps.dismissHalfCreatedSession(sessionId).catch(() => {});
  } else if (deps.sessionManager.archiveSession) {
    await deps.sessionManager.archiveSession(sessionId).catch(() => {});
  }
}

/**
 * The STRUCTURED (non-PTY) runtime a quick launch resolves onto when it names a
 * PROVIDER but no runtime — the wizard never sends a bare provider for a
 * terminal launch, so the structured lane is the honest projection.
 *
 * An exhaustive Record so a provider added to the union cannot ship without
 * someone naming its lane here; the `claude` row exists to satisfy that
 * exhaustiveness and is deliberately NOT consulted by the create-quick handler
 * (Claude keeps its substrate ladder — see ipc/session.ts).
 */
export const QUICK_PROVIDER_SDK_RUNTIME: Readonly<Record<AgentProvider, SessionAgentRuntime>> = {
  claude: 'claude-sdk',
  codex: 'codex-sdk',
  omp: 'omp-sdk',
  pi: 'pi-sdk',
};

/**
 * The NON-Claude runtime a launch request resolves onto, or undefined when it
 * resolves onto Claude (whose runtime comes from the substrate instead) — i.e.
 * exactly what {@link QuickSessionRuntimeStampInput.sessionAgentRuntime} wants.
 *
 * Mirrors the `nonClaudeQuickRuntime` ladder in the `sessions:create-quick`
 * handler, minus the rungs only that handler has (the design-session pin and the
 * provider-access reroute, both of which resolve the provider BEFORE this
 * projection). The A/B quick-arm path (index.ts `createArmSession`) has neither
 * rung, so this is its whole derivation.
 *
 * Generic ON PURPOSE. The arm stamp used to test `agentRuntime === 'codex-sdk'`,
 * which meant an `omp-sdk` arm stamped no runtime at all and
 * {@link stampQuickSessionRuntimeConfig} derived `claude-sdk` from the SDK
 * substrate: the sentinel run row said omp-sdk while the session row said
 * claude-sdk, and every chat turn dispatched to Claude. A per-provider literal
 * is wrong here by construction — the answer is "whatever provider this runtime
 * belongs to", read from the registry.
 */
export function resolveNonClaudeSessionRuntime(request: {
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
}): SessionAgentRuntime | undefined {
  const runtime =
    request.agentRuntime ??
    (request.agentProvider !== undefined && request.agentProvider !== 'claude'
      ? QUICK_PROVIDER_SDK_RUNTIME[request.agentProvider]
      : undefined);
  if (runtime === undefined) return undefined;
  return providerForRuntime(runtime) === 'claude' ? undefined : runtime;
}

/** Input for {@link stampQuickSessionRuntimeConfig}. */
export interface QuickSessionRuntimeStampInput {
  /** The RESOLVED substrate returned by the core's sentinel createRun. */
  resolvedSubstrate: CliSubstrate;
  /**
   * The NON-Claude runtime this launch resolved onto, when it resolved onto one
   * ('codex-sdk' | 'codex-pty' | 'omp-sdk' | 'omp-pty'). Undefined means Claude,
   * whose runtime is derived from the resolved substrate instead.
   *
   * ONE field replaces the `useCodexSdk`/`useCodexPty` boolean pair: a third
   * provider would otherwise need a third pair here and at both call sites.
   */
  sessionAgentRuntime?: SessionAgentRuntime;
  /** Only stamped when explicitly chosen — undefined keeps the global default (NULL). */
  requestedAgentMode?: PermissionMode;
  /**
   * Explicit runtime override (OMP fleet). When present it wins over the
   * substrate-derived Claude runtime — an omp-fleet session has no substrate
   * axis, so the ordinary `claudeRuntimeFromSubstrate` derivation would stamp
   * it back to 'claude-sdk' and the dispatch seams would never see omp-fleet.
   */
  agentRuntimeOverride?: SessionAgentRuntime;
}

/**
 * Persist the per-session runtime config BOTH quick-session callers must stamp
 * after {@link createQuickSessionCore} returns — the SHARED chokepoint for the
 * `sessions:create-quick` IPC handler AND the experiment quick-arm path
 * (index.ts createArmSession), so the two can never drift:
 *
 * - `sessions.agent_permission_mode` (migration 021): read by the quick Claude
 *   panel spawn (resolveSessionAgentPermissionMode → getDbSession) and any
 *   restart. Only written when explicitly chosen — NULL keeps the global default.
 * - `sessions.substrate` + `sessions.agent_runtime` (migrations 027 + 059-064):
 *   read by the sessions:input relay branch, frontend substrate gates, and any
 *   REPL re-spawn. ALWAYS stamped with the RESOLVED values — a request without an
 *   explicit substrate can still resolve 'interactive' via the global default or
 *   CYBOFLOW_SUBSTRATE, and stamping only on explicit request would leave the
 *   run row saying interactive while the session behaved SDK. NULL remains the
 *   legacy/SDK meaning for pre-migration rows only.
 *
 * A PTY-transport runtime (codex-pty, omp-pty) also FORCES `substrate` to
 * 'interactive': the sentinel run only carries the STORABLE runtimes, so a PTY
 * launch reaches createRun with a substrate request and no runtime, and the
 * session row is where its terminal identity has to land.
 */
export function stampQuickSessionRuntimeConfig(
  db: Database.Database,
  sessionId: string,
  input: QuickSessionRuntimeStampInput,
): void {
  if (input.requestedAgentMode !== undefined) {
    db.prepare(`UPDATE sessions SET agent_permission_mode = ? WHERE id = ?`).run(
      input.requestedAgentMode,
      sessionId,
    );
  }
  const resolvedSessionAgentRuntime =
    input.agentRuntimeOverride ??
    input.sessionAgentRuntime ??
    claudeRuntimeFromSubstrate(input.resolvedSubstrate);
  // omp-fleet is NOT a PTY lane (it supervises a remote fleet, not a terminal):
  // its substrate stays whatever the sentinel resolved, exactly as before the
  // lane abstraction — isPtyLane covers the PTY-transport runtimes only.
  const resolvedSessionSubstrate =
    resolvedSessionAgentRuntime !== 'omp-fleet' && isPtyLane(resolvedSessionAgentRuntime)
      ? 'interactive'
      : input.resolvedSubstrate;
  db.prepare(
    `UPDATE sessions
        SET substrate = ?,
            agent_runtime = ?
      WHERE id = ?`,
  ).run(resolvedSessionSubstrate, resolvedSessionAgentRuntime, sessionId);
}

/** The slice of the hosts facade (orchestrator/hostsBridge.ts `HostsFacade`) the host resolver reads. */
export interface QuickSessionHostsReader {
  status(): HostsFeatureStatus;
  /** Throws when the id is unknown. */
  get(id: string): HostView;
}

/** What {@link resolveQuickSessionHost} needs to know about the launch being resolved. */
export interface QuickSessionHostInput {
  /** The raw IPC `hostId` (untrusted): a string names an environment, null = This Mac, absent = default. */
  requestedHostId: unknown;
  /** projects.default_host_id (migration 152). */
  projectDefaultHostId: string | null | undefined;
  /** The RESOLVED session runtime (undefined = Claude, decided by the substrate). */
  agentRuntime: SessionAgentRuntime | undefined;
  /** The substrate the launch requests (undefined = the substrate ladder decides — the PTY by default). */
  requestedSubstrate: CliSubstrate | undefined;
  inPlace: boolean;
  isDesignSession: boolean;
  ultracode: boolean;
  /** CYBOFLOW_DISABLE_ORCH_SOCK_AUTH is set: a remote agent could not authenticate to the orch socket. */
  orchSocketAuthDisabled: boolean;
}

export type QuickSessionHostResolution = { ok: true; hostId: string | null } | { ok: false; error: string };

export const REMOTE_ENVIRONMENTS_OFF_MESSAGE = 'Remote environments are turned off';

/**
 * The launch-shape reason this session cannot run on a remote environment, or null when it can. M2 hosts only
 * worktree-backed structured SDK sessions (Claude SDK / Codex SDK); PTY terminals, design, ultracode and in-place
 * sessions stay on This Mac.
 */
function remoteShapeRefusal(input: QuickSessionHostInput): string | null {
  if (input.inPlace) return 'In-place sessions run on This Mac only. Choose a worktree session to use a remote environment.';
  if (input.isDesignSession) return 'Design sessions run on This Mac only.';
  if (input.ultracode) return 'Ultracode sessions run on This Mac only.';
  const runtime = remoteSessionRuntime(input);
  if (runtime === null) {
    return 'Remote environments run Claude SDK or Codex SDK sessions only. Terminal and other agents run on This Mac.';
  }
  return null;
}

/** claude-sdk / codex-sdk on the SDK substrate, else null. Claude's runtime comes from the substrate. */
function remoteSessionRuntime(input: QuickSessionHostInput): 'claude-sdk' | 'codex-sdk' | null {
  if (input.requestedSubstrate !== 'sdk') return null;
  const runtime = input.agentRuntime ?? 'claude-sdk';
  return runtime === 'claude-sdk' || runtime === 'codex-sdk' ? runtime : null;
}

/**
 * Decide which environment a `sessions:create-quick` launch runs on, BEFORE anything is enqueued:
 * an explicit request (a string; 'local' = This Mac) > the project's default environment (only while
 * environments are running and not kill-switched, and only for a session shape a remote can host) > This Mac.
 * A remote pick is validated (exists, not archived, SSH, full tier, cyboflow tools installed, the runtime's SDK
 * available there); every refusal is a readable message the renderer shows. Local resolves to null — the
 * canonical stamp — so a local launch threads nothing.
 */
export function resolveQuickSessionHost(
  hosts: QuickSessionHostsReader | null,
  input: QuickSessionHostInput,
): QuickSessionHostResolution {
  const explicit = input.requestedHostId;
  const status = hosts?.status() ?? null;
  const featureOn = status !== null && status.running && !status.killed;

  let candidate: string | null;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    candidate = explicit.trim();
  } else if (explicit === null) {
    candidate = null;
  } else {
    // Absent (or a blank string — treated as "no choice").
    // No explicit choice: the project default applies only while the feature runs, and only to a session shape a
    // remote environment can host — a terminal or design launch in a remote-default project stays on This Mac.
    const fallback = featureOn ? input.projectDefaultHostId : null;
    candidate = isRemoteHostId(fallback) && remoteShapeRefusal(input) === null ? fallback : null;
  }
  if (!isRemoteHostId(candidate)) return { ok: true, hostId: null };

  if (!featureOn || hosts === null) return { ok: false, error: REMOTE_ENVIRONMENTS_OFF_MESSAGE };
  if (input.orchSocketAuthDisabled) {
    return { ok: false, error: 'Remote environments need orchestrator socket authentication, which is turned off (CYBOFLOW_DISABLE_ORCH_SOCK_AUTH).' };
  }
  const shapeRefusal = remoteShapeRefusal(input);
  if (shapeRefusal !== null) return { ok: false, error: shapeRefusal };

  let host: HostView;
  try {
    host = hosts.get(candidate);
  } catch {
    return { ok: false, error: 'That environment no longer exists. Pick another environment.' };
  }
  const name = host.label;
  if (host.archivedAt !== null) return { ok: false, error: `The environment "${name}" is archived.` };
  if (host.kind !== 'ssh') return { ok: false, error: `The environment "${name}" is not a remote machine.` };
  if (host.effectiveTier !== 'full') {
    return { ok: false, error: `The environment "${name}" cannot run SDK sessions yet. Run its check from Environments.` };
  }
  if (!host.remoteReady) {
    return { ok: false, error: `Install cyboflow tools on "${name}" (Environments) before starting a session there.` };
  }
  const runtime = remoteSessionRuntime(input);
  const runtimes = host.preflight?.runtimes;
  const available = runtime === 'claude-sdk' ? runtimes?.claudeSdk === true : runtimes?.codexSdk === true;
  if (!available) {
    const label = runtime === 'claude-sdk' ? 'Claude' : 'Codex';
    return { ok: false, error: `${label} is not available on "${name}". Check the machine from Environments.` };
  }
  return { ok: true, hostId: candidate };
}
