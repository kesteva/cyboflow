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
import { assertTransitionAllowed } from './cyboflow/stateMachine';
import { isPtyLane } from './panelLane';

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
  toolType?: 'claude' | 'none';
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
  agentModel?: string | null;
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
  folderId?: string;
  toolType?: 'claude' | 'none';
  /** Persist ownership on the initial session INSERT, before session-created fires. */
  agentProvider?: AgentProvider;
  agentRuntime?: SessionAgentRuntime;
  agentModel?: string | null;
  claudeConfig?: { model?: string; permissionMode?: 'approve' | 'ignore'; ultrathink?: boolean };
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
    toolType: opts.toolType ?? 'claude',
    agentProvider: opts.agentProvider,
    agentRuntime: opts.agentRuntime,
    agentModel: opts.agentModel,
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
    if (deps.dismissHalfCreatedSession) {
      await deps.dismissHalfCreatedSession(session.id).catch(() => {});
    }
    throw err;
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
