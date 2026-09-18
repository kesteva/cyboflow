/**
 * VerificationScheduler — the main-process singleton that owns the DB-backed
 * verification_requests queue, the ResourceLeasePool (built over the shared
 * `mutex`), and the waterfall drain loop (see docs/proposals/visual-verification-design.md
 * §4 + "The collision story"). It is the producer-side scheduler for the layered
 * visual-verification MVP: lane agents fire a request (INSERT 'queued' + nudge),
 * never block; this scheduler drains them on ITS OWN setImmediate loop, leases the
 * scarce resources a chosen backend needs, captures + judges, then writes a
 * terminal verdict.
 *
 * Singleton lifecycle mirrors SprintLaneStore / TaskChangeRouter (initialize /
 * getInstance / _resetForTesting). Pass `logger` at initialize time from
 * main/src/index.ts — omitting it silently disables diagnostics (CODE-PATTERNS.md
 * optional-logger rule).
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', 'fs', or any concrete service in main/src/services/*. The DB
 * is injected as the narrow DatabaseLike, the logger as LoggerLike, the backends
 * as a VerificationBackendRegistry, the judge as a VlmJudge, and the artifacts-dir
 * resolver as a plain function — all renderer-safe shared types or primitives.
 *
 * The collision doctrine in one line: SCARCE RESOURCES SERIALIZE, LANES KEEP
 * FLOWING. If no lease a chosen backend needs is free, the REQUEST stays 'queued'
 * and is retried on the next drain — the lane (a task already on its own
 * RunQueueRegistry PQueue) is never held. nudge() schedules the drain on this
 * scheduler's OWN setImmediate loop, deliberately NOT on RunQueueRegistry
 * (no-recursive-enqueue rule, RunQueueRegistry.ts:9-13 — the request arrives FROM
 * a task already on that concurrency:1 queue, so enqueuing there self-deadlocks).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseLike, LoggerLike } from '../types';
import type {
  DeliverableVerifyConfig,
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerificationBackendRegistry,
  VerificationModality,
  VerificationRequestInput,
  VerificationTaskV1,
  VerificationType,
  VerifyChainEntry,
  VisualBackend,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import {
  VERIFY_PORT_ANY,
  VISUAL_VERIFY_DEFAULTS,
  isVerificationModality,
  resolveTaskModality,
  runbookBootstrapKillSwitchEngaged,
} from '../../../../shared/types/visualVerification';
import type { VerifyRunbookStatusDetail, VerifyRunbookStore } from './runbookStore';
import { type BootstrapDecision, type BootstrapDeclineReason } from './bootstrapEligibility';
import { runbookBootstrapPreflight } from './runbookBootstrapPreflight';
import type { BootstrapRunOutcome, RunbookBootstrapArgs } from './runbookBootstrapRunner';
import type { VerifyRunbookModality } from '../../../../shared/types/verifyRunbook';
import {
  AGENT_REQUEST_TIMEOUT_CEILING_MS,
  BATCH_MUTEX_MAX_QUEUED_HOLDERS,
  DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SSIM_MATCH_THRESHOLD,
  HEALTH_CHECK_MEMO_TTL_MS,
} from './verificationSchedulerContracts';
import type {
  DevServerContextResolver,
  OnVerdict,
  ProvenRunbookRevision,
  VerificationSchedulerDeps,
} from './verificationSchedulerContracts';
import {
  ResourceLeasePool,
  sprintVerifyBatchLease,
  verifyPortLease,
  verifySimLease,
} from './verificationLeases';
import type { LeaseHandle } from './verificationLeases';
import {
  AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
  AWAIT_TERMINAL_POLL_INTERVAL_MS,
  AWAIT_TERMINAL_TIMEOUT_MESSAGE,
  isRequestStatus,
  isTerminalRequestStatus,
  orderAgentDrainRows,
  parseRequestInput,
  parseVerdictFeedback,
} from './verificationRequestRows';
import type {
  AwaitTerminalOutcome,
  VerificationRequestRow,
  VerificationRequestSummary,
} from './verificationRequestRows';
import { TerminalDelivery } from './terminalDelivery';
import { CapturePipeline } from './capturePipeline';
import { AgentEngine } from './agentEngine';

// Re-exported for existing consumers — the type moved to shared so the
// screenshots-artifact payload (shared/types/artifacts.ts) can carry it without a
// shared->main import.
export type { CaptureOrigin } from '../../../../shared/types/visualVerification';


// ---------------------------------------------------------------------------
// Re-exports (issue #19 step 5). The scheduler's contracts, lease vocabulary,
// skip reasons, and row helpers now live in sibling modules; everything that was
// exported from here still is, so importers and tests are unchanged.
// ---------------------------------------------------------------------------

export {
  verificationEvents,
  verificationChannel,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_RETRY_MAX_MS,
  DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_CEILING_MS,
  HEALTH_CHECK_MEMO_TTL_MS,
  DEFAULT_SSIM_MATCH_THRESHOLD,
  BATCH_MUTEX_MAX_QUEUED_HOLDERS,
} from './verificationSchedulerContracts';
export type {
  VerificationTerminalEvent,
  DevServerSpawnArgs,
  DevServerHandle,
  DevServerProvider,
  DevServerContextResolver,
  StaticServerSpawnArgs,
  StaticServerHandle,
  StaticServerProvider,
  StaticHtmlContextResolver,
  TerminalExtra,
  BaselinePreDiffResult,
  BaselinePreDiffResolver,
  OnVerdict,
  VerificationSchedulerDeps,
  RunbookStatus,
  ProvenRunbookRevision,
  CapabilityBreakerFindingFn,
} from './verificationSchedulerContracts';
export {
  VERIFY_SCREEN_LEASE,
  VERIFY_AGENT_LEASE,
  verifyAgentSlot,
  verifyPortLease,
  verifySimLease,
  sprintVerifyBatchLease,
  ResourceLeasePool,
  AbortRaceError,
  raceWithAbort,
} from './verificationLeases';
export type {
  LeaseHandle,
} from './verificationLeases';
export {
  VERIFY_NO_RUNBOOK_REASON,
  VERIFY_RUNBOOK_ELSEWHERE_REASON,
  VERIFY_RUNBOOK_DRIFTED_REASON,
  VERIFY_RUNBOOK_UNREADABLE_REASON,
  runbookDeclineForSkipReason,
  VERIFY_UNPROVEN_SKIP_BLOCKED,
} from './verificationSkipReasons';
export {
  SETUP_PROOF_PROMOTION_MS,
  orderAgentDrainRows,
  NON_TERMINAL_REQUEST_STATUSES,
  isTerminalRequestStatus,
  AWAIT_TERMINAL_POLL_INTERVAL_MS,
  AWAIT_TERMINAL_TIMEOUT_MESSAGE,
  AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
} from './verificationRequestRows';
export type {
  AgentDrainOrderRow,
  AwaitTerminalOutcome,
  VerificationRequestSummary,
} from './verificationRequestRows';

// ---------------------------------------------------------------------------
// VerificationScheduler
// ---------------------------------------------------------------------------

export class VerificationScheduler {
  private static instance: VerificationScheduler | null = null;

  private readonly db: DatabaseLike;
  private readonly backends: VerificationBackendRegistry;
  private readonly artifactsDirResolver: (runId: string) => string;
  private readonly logger?: LoggerLike;
  private readonly config: ResolvedVisualVerifyConfig;
  private readonly liveConfig: (() => ResolvedVisualVerifyConfig) | null;
  private readonly onVerdict?: OnVerdict;
  private readonly leasePool: ResourceLeasePool;
  private readonly requestTimeoutMs: number;
  private readonly devServerContextResolver?: DevServerContextResolver;
  private readonly now: () => number;
  private readonly queuedAgeCeilingMs: number;
  private readonly legacyKillSwitch: () => boolean;
  private readonly runbookStatus: (
    projectId: number,
    modality: VerificationModality,
    probePath?: string,
  ) => Promise<VerifyRunbookStatusDetail>;
  private readonly runbookStore?: VerifyRunbookStore;
  private readonly runbookBootstrap?: (args: RunbookBootstrapArgs) => Promise<BootstrapRunOutcome>;

  /**
   * The single COALESCED fallback timer armed while any row is `queued` (§5.6). It
   * fires nudge() at the earliest queued-age expiry so a starved row is terminalized
   * even when NO lease release / enqueue would otherwise wake the drain (the
   * hasQueuedRequests re-nudge only fires when this pass leased in-flight work). One
   * timer at a time — re-armed at the end of every drain pass, cleared when the
   * queue empties. Never a second drain loop; it merely wakes the existing one.
   */
  private queuedAgeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Terminal write + verdict delivery (§5.6 delivery outbox), including the
   * in-process delivery-retry sweep — owned by {@link TerminalDelivery}
   * (terminalDelivery.ts, issue #19 step 6), so the scheduler itself holds no
   * delivery state. Constructed over the same db / logger / onVerdict.
   */
  private readonly delivery: TerminalDelivery;

  /**
   * The legacy capture engine — dev/static server spawn → backend capture →
   * deterministic / SSIM / VLM verdict → terminal delivery — owned by
   * {@link CapturePipeline} (capturePipeline.ts, issue #19 step 7). It shares this
   * scheduler's inFlight registry and delivery, and is handed the drain/agent
   * helpers it needs (batch mutex, budget, port parsing) as closures.
   */
  private readonly capture: CapturePipeline;

  /**
   * The verification-AGENT engine (redesign §5.4/§5.7) — the phase-0 gates, the
   * slot lease + SDK deployment, terminal settlement, runbook-proof and
   * capability-ledger write-back — owned by {@link AgentEngine} (agentEngine.ts,
   * issue #19 step 8). Like the capture pipeline it shares this scheduler's
   * inFlight registry, delivery, lease pool, and the row/path helpers it is
   * handed as closures; the drain dispatches an agent-stamped row to it.
   */
  private readonly agent: AgentEngine;

  /**
   * Per-backend healthCheck memo (R2 #2): backend id → { ok, at } where `at` is the
   * `now()` timestamp the probe ran. A hit within HEALTH_CHECK_MEMO_TTL_MS is reused;
   * a miss (or an expired entry) re-probes. This is the second selection gate that
   * makes an unhealthy backend behave exactly like an unregistered one.
   */
  private readonly healthMemo = new Map<VisualBackendId, { ok: boolean; at: number }>();

  /** True while a drain pass is in flight — coalesces concurrent nudges into one loop. */
  private draining = false;
  /** True when a nudge arrived during a drain — triggers exactly one more pass. */
  private rescanRequested = false;

  /**
   * The AbortController of every CURRENTLY in-flight (running) request, keyed by
   * requestId. Populated when runChosen starts the detached capture+judge work and
   * deleted in its finally. This is the handle cancelForRun(runId) / the per-request
   * timeout reach for to `.abort()` the live capture/judge of a row that is already
   * leased + running (a pure DB UPDATE alone would NOT stop the in-flight promise).
   */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(deps: VerificationSchedulerDeps) {
    this.db = deps.db;
    this.backends = deps.backends;
    this.artifactsDirResolver = deps.artifactsDirResolver;
    this.logger = deps.logger;
    this.config = deps.config ?? VISUAL_VERIFY_DEFAULTS;
    this.liveConfig = deps.liveConfig ?? null;
    this.onVerdict = deps.onVerdict;
    this.delivery = new TerminalDelivery({ db: this.db, logger: this.logger, onVerdict: this.onVerdict });
    this.leasePool = deps.leasePool ?? new ResourceLeasePool();
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.devServerContextResolver = deps.devServerContextResolver;
    this.now = deps.now ?? (() => Date.now());
    this.queuedAgeCeilingMs = deps.queuedAgeCeilingMs ?? this.config.queuedAgeCeilingMs;
    this.legacyKillSwitch = deps.legacyKillSwitch ?? (() => process.env.CYBOFLOW_VERIFY_LEGACY === '1');
    // §3.2: an UNWIRED deployment has no way to know a project proved anything —
    // 'absent' is the honest default, not a placeholder. (Phase 2 wires the real
    // store at index.ts; this default is what legacy tests and a pre-096 DB get.)
    this.runbookStatus =
      deps.runbookStatus ??
      // Unwired ⇒ the honest pre-phase-2 answer: nothing was ever derived.
      (async (): Promise<VerifyRunbookStatusDetail> => ({ status: 'absent', reason: 'no-record' }));
    this.runbookStore = deps.runbookStore;
    this.runbookBootstrap = deps.runbookBootstrap;
    this.capture = new CapturePipeline({
      judge: deps.judge,
      logger: this.logger,
      config: this.config,
      artifactsDirResolver: this.artifactsDirResolver,
      requestTimeoutMs: this.requestTimeoutMs,
      baselineMatchThreshold: deps.baselineMatchThreshold ?? DEFAULT_SSIM_MATCH_THRESHOLD,
      devServerProvider: deps.devServerProvider,
      staticServerProvider: deps.staticServerProvider,
      staticHtmlContextResolver: deps.staticHtmlContextResolver,
      baselinePreDiff: deps.baselinePreDiff,
      delivery: this.delivery,
      inFlight: this.inFlight,
      portFromLease: (name) => this.portFromLease(name),
      inputDeclaresDevServer: (input) => this.inputDeclaresDevServer(input),
      acquireBatchMutex: (runId) => this.acquireBatchMutex(runId),
      isProjectBudgetExhausted: (projectId) => this.isProjectBudgetExhausted(projectId),
      incrementJudgeCallsUsed: (id) => this.incrementJudgeCallsUsed(id),
    });
    this.agent = new AgentEngine({
      db: this.db,
      logger: this.logger,
      config: this.config,
      leasePool: this.leasePool,
      artifactsDirResolver: this.artifactsDirResolver,
      agentRunner: deps.agentRunner,
      agentRequestTimeoutMs: deps.agentRequestTimeoutMs ?? DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
      agentRequestCeilingMs: deps.agentRequestCeilingMs ?? AGENT_REQUEST_TIMEOUT_CEILING_MS,
      portFreeProbe: deps.portFreeProbe ?? (async () => true),
      capabilityStore: deps.capabilityStore,
      capabilityFinding: deps.capabilityFinding,
      // §4: deliberately NOT defaulted to an always-true thunk — absent means "no
      // probe ran", which the gate reads as unsupported (phase-0 behavior).
      nativeCaptureProbe: deps.nativeCaptureProbe,
      runbookStatus: this.runbookStatus,
      runbookStore: this.runbookStore,
      delivery: this.delivery,
      inFlight: this.inFlight,
      agentGateColumnsForRow: (id) => this.agentGateColumnsForRow(id),
      worktreePathForRun: (runId) => this.worktreePathForRun(runId),
      projectPathFor: (projectId) => this.projectPathFor(projectId),
      acquireBatchMutex: (runId) => this.acquireBatchMutex(runId),
      isProjectBudgetExhausted: (projectId) => this.isProjectBudgetExhausted(projectId),
      incrementJudgeCallsUsed: (id) => this.incrementJudgeCallsUsed(id),
      portFromLease: (name) => this.portFromLease(name),
    });
  }

  // --------------------------------------------------------------------------
  // Lifecycle (singleton)
  // --------------------------------------------------------------------------

  static initialize(deps: VerificationSchedulerDeps): VerificationScheduler {
    VerificationScheduler.instance = new VerificationScheduler(deps);
    return VerificationScheduler.instance;
  }

  static getInstance(): VerificationScheduler {
    if (!VerificationScheduler.instance) {
      throw new Error(
        'VerificationScheduler has not been initialized. Call VerificationScheduler.initialize() from main/src/index.ts.',
      );
    }
    return VerificationScheduler.instance;
  }

  /** Best-effort accessor: returns the instance or null without throwing. */
  static tryGetInstance(): VerificationScheduler | null {
    return VerificationScheduler.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    VerificationScheduler.instance = null;
  }

  // --------------------------------------------------------------------------
  // runRecovery — crash recovery for orphaned leased/running rows
  // --------------------------------------------------------------------------

  /**
   * Re-drain rows stranded mid-flight by a PRIOR process. After a crash/restart a
   * row may be persisted 'leased' or 'running' even though the capture/judge that
   * owned it is gone (its in-memory AbortController, lease, and detached promise all
   * died with the process). These CANNOT resume — the scheduler is brand new and
   * holds no in-flight handle for them — so they are marked 'timeout' (lease already
   * dropped with the dead process; the freshly-constructed `mutex` holds nothing).
   *
   * R4 — routes EACH orphan through the SAME markTerminalAndDeliver chokepoint a
   * live timeout uses, rather than a bare UPDATE. That is what un-wedges a sprint
   * after a restart: the delivery drives the parked lane OFF `awaiting-verify`
   * (applyMergeGateVerdict advances it) AND raises the non-blocking timeout finding,
   * exactly like a live timeout. The terminal event also fires; recovery runs before
   * any event subscriber exists, but events are best-effort — the LANE write is the
   * load-bearing part, and it is synchronous through the router.
   *
   * Mirrors recoverActiveStateOrphans (runRecovery.ts): "no in-process worker → the
   * row is an orphan; force it terminal so nothing waits on it forever". Called ONCE
   * at scheduler init from index.ts boot recovery, BEFORE any nudge, so a stale row
   * can never be confused with a live in-flight one (inFlight is empty at boot).
   * Returns the number of rows re-drained. Idempotent: a second call finds none.
   */
  async runRecovery(): Promise<number> {
    // §5.8 kill-switch boot terminalization — read the flag ONCE for this whole
    // recovery pass (never per-row) and, when active, terminalize every
    // queued/leased/running row whose RUN is agent-stamped BEFORE the generic
    // orphan-timeout sweep below runs. Both that sweep and the queued-age sweep
    // further down are status-guarded to `IN ('queued','leased','running')`
    // (markTerminal), so a row this step already flipped to 'skipped' simply drops
    // out of their SELECTs — no row is ever double-terminalized, and a
    // legacy-stamped row is untouched by this step (isAgentStampedRun returns
    // false for it, so it falls through to the pre-existing recovery behavior
    // unchanged).
    const killSwitchTerminalized = await this.terminalizeAgentRowsOnLegacyKillSwitch(this.legacyKillSwitch());

    const rows = this.db
      .prepare(
        `SELECT id, run_id, project_id, status, verify_type, deliverable_json,
                chain_json, current_backend, attempt, enqueued_at
           FROM verification_requests
          WHERE status IN ('leased', 'running')
          ORDER BY enqueued_at ASC, id ASC`,
      )
      .all() as VerificationRequestRow[];
    let recovered = 0;
    for (const row of rows) {
      // Parse the input so the delivery can attribute the lane (deliverable_json →
      // taskRef); an unparseable row still recovers to 'timeout' with no attribution.
      const input = parseRequestInput(row.deliverable_json) ?? undefined;
      await this.delivery.markTerminalAndDeliver(
        row,
        'timeout',
        { error: 'orphaned by process restart' },
        undefined,
        [],
        input,
      );
      recovered += 1;
    }
    if (recovered > 0) {
      this.logger?.info('[VerificationScheduler] re-drained orphaned requests on boot', {
        timedOut: recovered,
      });
    }

    // §5.6 boot sweep for STALE queued rows: a row left 'queued' by a prior process
    // (no live worker to lease it, and — until the first post-boot enqueue — nothing
    // to nudge the drain) whose enqueue-age already exceeds the ceiling is
    // terminalized 'skipped' through the SAME delivery path so its parked lane is
    // driven off awaiting-verify. Non-stale queued rows are LEFT queued; the closing
    // nudge below arms the fallback timer for them.
    const expired = await this.expireOverAgeQueued();

    // §5.6 delivery-outbox boot replay: every TERMINAL row still marked
    // delivery_state='pending' (its terminal status committed but a crash struck
    // before/within the three verdict deliveries) is re-delivered through the same
    // idempotent deliver() path, then stamped 'delivered'. Legacy rows (NULL
    // delivery_state — pre-078 or terminalized by an old binary) are self-excluded
    // by the WHERE clause and never replayed.
    const replayed = await this.delivery.replayPendingDeliveries();

    // Wake the drain once so any REMAINING (non-stale) queued rows are processed and
    // the queued-age fallback timer is armed for them (runRecovery runs before any
    // enqueue would otherwise nudge). No-op when the queue is empty.
    if (this.hasQueuedRequests()) this.nudge();

    return recovered + expired + replayed + killSwitchTerminalized;
  }

  /**
   * §5.8 kill-switch boot terminalization (the missing "boot" half — the NEW-run
   * stamping half already lives in `workflowRegistry.ts`). When `enabled`, every
   * row still `queued`/`leased`/`running` whose RUN is stamped `verify_chain:
   * ['agent']` (isAgentStampedRun) is terminalized 'skipped' through the normal
   * `markTerminalAndDeliver` chokepoint — never a silent UPDATE — so a lane parked
   * at `awaiting-verify` behind a now-disabled engine advances with a
   * non-blocking finding instead of wedging forever. `captureOrigin: 'agent'` is
   * stamped for the same human-facing provenance reason `expireOverAgeQueued`
   * stamps it on an agent-stamped expiry. A legacy-stamped row is never selected
   * by isAgentStampedRun and falls through completely untouched by this step.
   * `enabled === false` (the default posture) is a pure no-op — byte-identical to
   * pre-§5.8 recovery. Returns the count terminalized.
   */
  private async terminalizeAgentRowsOnLegacyKillSwitch(enabled: boolean): Promise<number> {
    if (!enabled) return 0;
    const rows = this.db
      .prepare(
        `SELECT id, run_id, project_id, status, verify_type, deliverable_json,
                chain_json, current_backend, attempt, enqueued_at
           FROM verification_requests
          WHERE status IN ('queued', 'leased', 'running')
          ORDER BY enqueued_at ASC, id ASC`,
      )
      .all() as VerificationRequestRow[];
    let terminalized = 0;
    for (const row of rows) {
      if (!this.isAgentEngineRequest(row)) continue;
      const input = parseRequestInput(row.deliverable_json) ?? undefined;
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        { error: 'agent engine disabled (CYBOFLOW_VERIFY_LEGACY)', captureOrigin: 'agent' },
        undefined,
        [],
        input,
      );
      terminalized += 1;
    }
    if (terminalized > 0) {
      this.logger?.warn(
        '[VerificationScheduler] terminalized in-flight agent-chain requests — CYBOFLOW_VERIFY_LEGACY kill switch active',
        { terminalized },
      );
    }
    return terminalized;
  }

  // --------------------------------------------------------------------------
  // enqueue — INSERT a 'queued' request and kick the drain
  // --------------------------------------------------------------------------

  /**
   * Insert ONE verification request as 'queued' and return its id immediately.
   * Called by the mcp-request-verification handler (P6); the lane never blocks on
   * the outcome. The chain is stamped from chain_json (resolved live chain); the
   * scheduler picks the cheapest usable backend within it at drain time.
   *
   * DUAL-WRITE (redesign §5.2/§5.13, migration 078): `deliverable_json` is ALWAYS
   * written from `req.input` exactly as before — every legacy reader (recovery
   * sweep, Verify-Queue projection, runRecovery) keeps working unchanged. When
   * `req.task` is supplied, `task_json` is ADDITIONALLY written (serialized
   * verbatim); otherwise it is NULL. `req.snapshotSha`, when supplied, is written
   * to `snapshot_sha`; otherwise NULL. This slice only OPENS these two channels —
   * no caller in this slice populates `task`/`snapshotSha` yet (later slices own
   * snapshot capture and the typed step-output enqueue path). `report_json` /
   * `delivery_state` are NOT touched here — those are written by the terminal
   * delivery path (§5.6, a later slice).
   *
   * IDEMPOTENT ENQUEUE (redesign §5.3): when `req.enqueueKey` is supplied, an
   * existing NON-canceled row sharing that key is returned AS-IS (no new INSERT,
   * no nudge) — a controller re-walking the chain after a crash or a merge-gate
   * loopback must never double-enqueue for the same attempt. "Canceled" mirrors
   * cancelForRun's sweep signature (`status='timeout' AND error_message='canceled'`)
   * — a canceled row does NOT block a fresh enqueue, so a genuinely fresh attempt
   * re-fires normally. `req.enqueueKey` absent ⇒ no dedup lookup, always inserts
   * (byte-identical to the pre-dedup behavior).
   */
  enqueue(req: {
    runId: string;
    projectId: number;
    type: VerificationType;
    input: VerificationRequestInput;
    /**
     * The backend chain persisted to `chain_json`. Typed `VerifyChainEntry[]`
     * (not `VisualBackendId[]`) because the single-member `['agent']` ENGINE
     * SELECTOR is a legal value here: the `__quick__` chat sentinel resolves its
     * posture at call time and writes the resolved chain verbatim, which is the
     * first rung of {@link VerificationScheduler.isAgentEngineRequest}. Flow runs
     * still pass the host-capability intersection (`[]` under the agent engine).
     * The legacy waterfall reads this column back through `parseChain`, which
     * narrows to `VisualBackendId[]` and drops the 'agent' member.
     */
    chain: VerifyChainEntry[];
    /** The composed task (§5.1), when this request was enqueued via the dual-format contract. Absent ⇒ task_json stays NULL. */
    task?: VerificationTaskV1;
    /** The git sha the verification agent's snapshot worktree was built at (§5.5). Absent/null ⇒ snapshot_sha stays NULL. */
    snapshotSha?: string | null;
    /** Idempotency key (§5.3), caller-opaque — convention `${runId}:${taskRef}:${attempt}`. Absent ⇒ no dedup. */
    enqueueKey?: string;
    /**
     * §3.6 — this request is a phase-2 SETUP/PROOF run ("test-execute the derived
     * runbook"), not ordinary lane traffic. Stamped to migration 095's
     * `setup_proof` and load-bearing in three places: the project's lifetime
     * verification budget is BYPASSED for it (a proof run must never silently
     * fail-open to 'skipped' because lane traffic exhausted the budget first), it
     * never increments `judge_calls_used`, and it is EXEMPT from the §3.2 degrade
     * gate — proving the runbook is precisely how a project stops being
     * "unproven", so gating it on already having a proven runbook would be a
     * bootstrap deadlock. Defaults to false (ordinary counted lane traffic).
     */
    setupProof?: boolean;
    /**
     * The LANE-DRIVEN bootstrap proof (docs/proposals/lane-runbook-bootstrap.md
     * §5). Stamped to migration 107's `bootstrap_proof`, and deliberately NOT a
     * synonym for {@link setupProof} — it claims exactly ONE of that flag's three
     * privileges:
     *
     *   - EXEMPT from the §3.2 degrade gate, for the identical bootstrap-deadlock
     *     reason (you cannot prove a runbook if being unproven blocks the proof);
     *   - but COUNTED against the project's lifetime budget and charged like any
     *     lane request, because a budget exemption is safe for a flow a human
     *     launches once per project and unsafe for something a lane reaches on
     *     every sprint;
     *   - and drained at ORDINARY priority, because it BLOCKS a live lane and so
     *     has no business queueing behind one.
     *
     * It is also not a wire field: `mcpQueryHandler` never reads it, so the only
     * writer is the in-process controller seam. That makes it strictly narrower
     * than `setupProof`, whose workflow-identity check exists to stop a lane from
     * claiming the budget exemption.
     *
     * A bootstrap proof must NEVER drive a sprint lane — it carries the runbook's
     * build/serve, not the lane's acceptance criteria — so both lane-driving
     * policy sites exclude on this flag; see verdictDelivery and
     * SchedulerVisualVerifyGate.
     */
    bootstrapProof?: boolean;
    /**
     * §5.2 seam 3 — the PIN. `runbookHash` content-addresses the portable half
     * the composed `task` was merged from; `runbookLocalVersion` is the
     * machine-local record's CAS version at enqueue. Both are resolved by the
     * caller's {@link VerificationScheduler.resolveProvenRunbook} (or supplied
     * verbatim by a setup-proof request, which pins the DRAFT it is trying to
     * prove) and written to migration 096's columns in the same INSERT as the
     * task itself, so the row records the exact revision it must execute.
     *
     * Absent ⇒ NULL columns, and the runner's pin validation does not run —
     * which is the correct posture for the degenerate pre-live tasks that
     * bypass the §3.2 degrade gate entirely (they derive no environment, so
     * there is no runbook for them to be pinned to).
     */
    runbookHash?: string | null;
    runbookLocalVersion?: number | null;
  }): string {
    if (req.enqueueKey !== undefined) {
      const existingId = this.findLiveRequestByEnqueueKey(req.enqueueKey);
      if (existingId !== undefined) {
        this.logger?.debug('[VerificationScheduler] idempotent enqueue — reusing existing request', {
          requestId: existingId,
          runId: req.runId,
          enqueueKey: req.enqueueKey,
        });
        return existingId;
      }
    }

    const id = `vr_${randomUUID().replace(/-/g, '')}`;
    // The §4 modality axis is resolved and STAMPED here, at enqueue, from the
    // (type, task) pair — the drain must not have to re-derive it, and the
    // capability ledger (§3.3/§3.4) is keyed on it. A pre-095 DB has neither
    // column, so the widened INSERT is attempted first and falls back to the
    // legacy column list on a `prepare` failure (which happens BEFORE any row is
    // written — the fallback can never double-insert).
    const modality = resolveTaskModality(req.type, req.task ?? null);
    const values: [string, string, number, VerificationType, string, string, string | null, string | null, string | null] =
      [
        id,
        req.runId,
        req.projectId,
        req.type,
        JSON.stringify(req.input),
        JSON.stringify(req.chain),
        req.task !== undefined ? JSON.stringify(req.task) : null,
        req.snapshotSha ?? null,
        req.enqueueKey ?? null,
      ];
    // The INSERT widens ONE generation at a time (096 pin → 095 gate columns →
    // the 078 legacy list), each attempt falling back on a `prepare` failure.
    // `prepare` throws on an unknown column BEFORE any row is written, so a
    // fallback can never double-insert; the ladder is what lets one build serve
    // a DB at any of the three migration levels.
    const gateValues: [VerificationModality, number] = [modality, req.setupProof === true ? 1 : 0];
    const pinValues: [string | null, number | null] = [
      req.runbookHash ?? null,
      req.runbookLocalVersion ?? null,
    ];
    const bootstrapValue: [number] = [req.bootstrapProof === true ? 1 : 0];
    try {
      this.db
        .prepare(
          `INSERT INTO verification_requests
             (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, task_json, snapshot_sha, enqueue_key, modality, setup_proof, runbook_hash, runbook_local_version, bootstrap_proof)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values, ...gateValues, ...pinValues, ...bootstrapValue);
    } catch (bootstrapErr) {
      // A pre-105 DB has no `bootstrap_proof`. Falling back DROPS the flag, which
      // is the only safe direction: an unstamped row is read back as an ordinary
      // request, so it is gated and budgeted normally and can never promote a
      // runbook. The bootstrap simply cannot run on such a DB, which is correct —
      // the feature is younger than the column.
      this.logger?.debug('[VerificationScheduler] bootstrap_proof column unavailable; enqueuing without it', {
        requestId: id,
        error: bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr),
      });
      try {
        this.db
          .prepare(
            `INSERT INTO verification_requests
               (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, task_json, snapshot_sha, enqueue_key, modality, setup_proof, runbook_hash, runbook_local_version)
             VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...values, ...gateValues, ...pinValues);
      } catch (pinErr) {
        this.logger?.debug('[VerificationScheduler] runbook pin columns unavailable; enqueuing without a pin', {
          requestId: id,
          error: pinErr instanceof Error ? pinErr.message : String(pinErr),
        });
        try {
          this.db
            .prepare(
              `INSERT INTO verification_requests
                 (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, task_json, snapshot_sha, enqueue_key, modality, setup_proof)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
            )
            .run(...values, ...gateValues);
        } catch (err) {
          this.logger?.debug('[VerificationScheduler] modality/setup_proof columns unavailable; legacy enqueue', {
            requestId: id,
            error: err instanceof Error ? err.message : String(err),
          });
          this.db
            .prepare(
              `INSERT INTO verification_requests
                 (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, task_json, snapshot_sha, enqueue_key)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?)`,
            )
            .run(...values);
        }
      }
    }
    this.logger?.debug('[VerificationScheduler] enqueued request', {
      requestId: id,
      runId: req.runId,
      type: req.type,
      chain: req.chain,
      modality,
      setupProof: req.setupProof === true,
      bootstrapProof: req.bootstrapProof === true,
      hasTask: req.task !== undefined,
      hasEnqueueKey: req.enqueueKey !== undefined,
      runbookHash: req.runbookHash ?? null,
      runbookLocalVersion: req.runbookLocalVersion ?? null,
    });
    this.nudge();
    return id;
  }

  /**
   * Idempotent-enqueue lookup (§5.3): the newest row sharing `enqueueKey` whose
   * status is NOT the cancelForRun sweep signature (`status='timeout' AND
   * error_message='canceled'`). Any other status — including a genuine (non-
   * cancel) 'timeout' or any terminal verdict — is a live dedup hit, since the
   * caller's concern is "does a request for this exact attempt already exist
   * anywhere in its lifecycle", not merely "is one still queued". A canceled row
   * is deliberately excluded so a fresh attempt after cancellation re-fires.
   */
  private findLiveRequestByEnqueueKey(enqueueKey: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM verification_requests
          WHERE enqueue_key = ?
            AND NOT (status = 'timeout' AND error_message = 'canceled')
          ORDER BY enqueued_at DESC
          LIMIT 1`,
      )
      .get(enqueueKey) as { id: string } | undefined;
    return row?.id;
  }

  // --------------------------------------------------------------------------
  // awaitTerminal — the SYNCHRONOUS proof primitive (§5.2 seam 2)
  // --------------------------------------------------------------------------

  /**
   * Block until `requestId` settles, then hand back its verdict inline
   * (docs/proposals/verification-setup-flow.md §5.2 seam 2).
   *
   * WHY THIS EXISTS AT ALL. Every other consumer of this queue is
   * fire-and-continue, and that is correct FOR THEM: a sprint lane enqueues,
   * parks at `awaiting-verify`, and the verdict is DRIVEN onto it later by the
   * merge gate — the lane agent's turn has already ended, so there is nobody left
   * to hand a verdict to. The phase-2 setup flow is the first caller with the
   * opposite shape: its whole job is "derive → PROVE BY RUNNING → diagnose →
   * adjust → re-prove", and every one of those arrows needs the outcome of the
   * previous step IN THE SAME TURN. Without this seam the flow's only options are
   * to poll the DB itself (it has no DB access) or to end its turn and hope
   * something resumes it (nothing would) — which is exactly why §5.2 names the
   * "wait-for-verdict seam, bounded, with the verdict surfaced inline" as a thing
   * that must be BUILT rather than assumed.
   *
   * POLLING THE ROW, NOT SUBSCRIBING TO THE EVENT. `verificationEvents` looks like
   * the natural wake source, but it is a fire-once in-process emit: a request that
   * terminalized between the caller's enqueue and its await (a fast skip — an
   * unsupported modality, a suppressed capability, an exhausted queue-age) has
   * ALREADY emitted, and a subscriber would then wait out the full deadline for an
   * event that can never fire again. Boot recovery has the same shape across a
   * restart. The ROW is the durable record of the outcome; re-reading it is
   * correct whether the terminal happened a second ago or before this call
   * existed, and a once-a-second read of one indexed row is not a cost worth
   * optimizing against that.
   *
   * BOUNDED, AND HONEST ABOUT THE BOUND. On expiry the request's CURRENT status is
   * returned as-is (queued/leased/running) with {@link AWAIT_TERMINAL_TIMEOUT_MESSAGE}
   * — the caller stopped waiting, the request did not stop running, and the two
   * must not be conflated. Nothing is canceled: the request keeps draining and its
   * verdict still lands on the artifact + review queue through the normal delivery
   * path, so a proof that merely outran a caller's patience is not lost.
   *
   * `pollIntervalMs` exists so a test can drive the loop without a real second per
   * iteration; production callers take the default. The sleep is clamped to the
   * remaining budget, so the deadline is honored to within one DB read rather than
   * overshot by up to a full interval. The deadline itself is measured on the
   * scheduler's INJECTED clock (`deps.now`) — the same one the drain ages rows on
   * — so a test that freezes the clock freezes this deadline with it.
   */
  async awaitTerminal(
    requestId: string,
    timeoutMs: number,
    pollIntervalMs: number = AWAIT_TERMINAL_POLL_INTERVAL_MS,
  ): Promise<AwaitTerminalOutcome> {
    const startedMs = this.now();
    for (;;) {
      const snapshot = this.readAwaitSnapshot(requestId);
      if (snapshot === null) {
        return {
          status: 'skipped',
          errorMessage: AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
          failureClass: null,
          feedback: null,
        };
      }
      if (isTerminalRequestStatus(snapshot.status)) return snapshot;

      const remainingMs = timeoutMs - (this.now() - startedMs);
      if (remainingMs <= 0) {
        return { ...snapshot, errorMessage: AWAIT_TERMINAL_TIMEOUT_MESSAGE };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollIntervalMs, remainingMs));
      });
    }
  }

  /**
   * One poll of {@link VerificationScheduler.awaitTerminal}: the request's status
   * plus the three human-facing fields, or `null` when the id resolves to nothing
   * (never enqueued, already reaped) or the read itself failed.
   *
   * The migration-095 `failure_class` is fetched through the SAME widen-then-fall-
   * back ladder as {@link agentGateColumnsForRow} / {@link runbookPinForRow}: a
   * pre-095 DB throws on `prepare` (before any read), and losing the STATUS to
   * that throw would make every await on such a binary answer "not found" forever.
   * The fallback drops only the attribution, which such a DB genuinely never had.
   */
  private readAwaitSnapshot(requestId: string): AwaitTerminalOutcome | null {
    interface AwaitRow {
      status: unknown;
      error_message: unknown;
      verdict_json: unknown;
      failure_class?: unknown;
    }
    let row: AwaitRow | undefined;
    try {
      row = this.db
        .prepare(
          'SELECT status, error_message, verdict_json, failure_class FROM verification_requests WHERE id = ?',
        )
        .get(requestId) as AwaitRow | undefined;
    } catch {
      try {
        row = this.db
          .prepare('SELECT status, error_message, verdict_json FROM verification_requests WHERE id = ?')
          .get(requestId) as AwaitRow | undefined;
      } catch (err) {
        this.logger?.warn('[VerificationScheduler] await snapshot read failed (fail-soft)', {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    if (!row) return null;

    // An unrecognized status (a hand-edited row, or one written by a newer
    // binary) is reported as 'running': non-terminal, so the caller keeps waiting
    // within its own deadline rather than being handed a verdict-shaped answer
    // this scheduler cannot vouch for.
    const status: RequestStatus = isRequestStatus(row.status) ? row.status : 'running';
    return {
      status,
      errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
      failureClass:
        typeof row.failure_class === 'string' && row.failure_class.length > 0 ? row.failure_class : null,
      feedback: parseVerdictFeedback(row.verdict_json),
    };
  }

  /**
   * Every verification request belonging to `runId`, newest first — the cold read
   * behind the `cyboflow_get_verifications` MCP tool. `requestId` narrows to a
   * single row (still run-scoped: a foreign id yields an empty list, so the caller
   * cannot use this to read another run's verdict).
   *
   * Run-scoping is enforced HERE in the SQL rather than by filtering afterwards,
   * so there is no shape in which a row from another run is materialized at all.
   *
   * Column availability is handled with the SAME widen-then-fall-back ladder as
   * {@link readAwaitSnapshot}: a pre-078/pre-095 DB throws on `prepare` before any
   * read, and losing the whole listing to that throw would make this tool answer
   * "no verifications" on a binary that genuinely has them. The fallback drops only
   * the columns such a DB never had.
   *
   * Fail-soft to `[]` on an unreadable table — an empty listing is the honest
   * answer for a caller that cannot be shown the rows.
   */
  listRequestsForRun(runId: string, requestId?: string): VerificationRequestSummary[] {
    interface ListRow {
      id: unknown;
      status: unknown;
      verify_type: unknown;
      attempt: unknown;
      error_message: unknown;
      verdict_json: unknown;
      enqueued_at: unknown;
      ended_at: unknown;
      failure_class?: unknown;
      snapshot_sha?: unknown;
      report_json?: unknown;
    }
    const narrow = 'id, status, verify_type, attempt, error_message, verdict_json, enqueued_at, ended_at';
    const wide = `${narrow}, failure_class, snapshot_sha, report_json`;
    const where = `WHERE run_id = ?${requestId === undefined ? '' : ' AND id = ?'}`;
    const params = requestId === undefined ? [runId] : [runId, requestId];
    const order = 'ORDER BY enqueued_at DESC, id DESC';

    const read = (columns: string): ListRow[] =>
      this.db
        .prepare(`SELECT ${columns} FROM verification_requests ${where} ${order}`)
        .all(...params) as ListRow[];

    let rows: ListRow[];
    try {
      rows = read(wide);
    } catch {
      try {
        rows = read(narrow);
      } catch (err) {
        this.logger?.warn('[VerificationScheduler] request listing read failed (fail-soft)', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    }

    return rows.map((row) => ({
      id: typeof row.id === 'string' ? row.id : '',
      // An unrecognized status is reported as 'running' for the same reason
      // readAwaitSnapshot does it: non-terminal is the safe reading of a row this
      // scheduler cannot vouch for, and it never looks like a verdict.
      status: isRequestStatus(row.status) ? row.status : 'running',
      verifyType: typeof row.verify_type === 'string' ? row.verify_type : null,
      attempt: typeof row.attempt === 'number' ? row.attempt : 0,
      errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
      failureClass:
        typeof row.failure_class === 'string' && row.failure_class.length > 0 ? row.failure_class : null,
      feedback: parseVerdictFeedback(row.verdict_json),
      enqueuedAt: typeof row.enqueued_at === 'string' ? row.enqueued_at : null,
      endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
      snapshotSha: typeof row.snapshot_sha === 'string' && row.snapshot_sha.length > 0 ? row.snapshot_sha : null,
      screenshotFiles: this.reportScreenshotFileNames(row.report_json),
    }));
  }

  /**
   * The screenshot basenames THIS request's agent report recorded, or `null` when
   * the row carries no `report_json` at all (the legacy capture path, or a request
   * that never reached a terminal). Shares the extraction shape with
   * {@link deriveReplayFileNames}; kept separate because that one falls back to the
   * verdict's `judgedFileNames` for the artifact merge, whereas a caller being told
   * "these are THIS request's screenshots" must get `null` rather than a
   * best-effort list it would relay as exact.
   */
  private reportScreenshotFileNames(reportJson: unknown): string[] | null {
    if (typeof reportJson !== 'string' || reportJson.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(reportJson);
      if (parsed === null || typeof parsed !== 'object') return null;
      const shots = (parsed as { screenshots?: unknown }).screenshots;
      if (!Array.isArray(shots)) return null;
      return shots
        .map((s) => (s !== null && typeof s === 'object' ? (s as { fileName?: unknown }).fileName : undefined))
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // nudge — schedule a drain on THIS scheduler's OWN setImmediate loop
  // --------------------------------------------------------------------------

  /**
   * Schedule a drain pass. CRITICAL: the drain runs on the scheduler's OWN
   * setImmediate loop, NEVER on RunQueueRegistry — the request arrives from a task
   * already on that run's concurrency:1 PQueue, so re-enqueuing there would
   * self-deadlock (no-recursive-enqueue rule, RunQueueRegistry.ts:9-13).
   *
   * Concurrent nudges coalesce: a nudge during an in-flight drain sets
   * rescanRequested so exactly one more pass runs after the current one settles.
   */
  nudge(): void {
    if (this.draining) {
      this.rescanRequested = true;
      return;
    }
    this.draining = true;
    setImmediate(() => {
      void this.runDrainLoop();
    });
  }

  /** Run drain passes until no rescan is pending; clears the draining flag at the end. */
  private async runDrainLoop(): Promise<void> {
    try {
      do {
        this.rescanRequested = false;
        await this.drain();
      } while (this.rescanRequested);
    } catch (err) {
      this.logger?.error('[VerificationScheduler] drain loop error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.draining = false;
    }
  }

  // --------------------------------------------------------------------------
  // drain — FIFO over 'queued' rows; lease scarce resources, capture + judge
  // --------------------------------------------------------------------------

  /**
   * One drain pass. SELECT all 'queued' rows ordered (enqueued_at, id) for fair
   * round-robin. For each row we SYNCHRONOUSLY (within this loop, no await on the
   * capture itself) pick the cheapest backend whose lease is free, acquire it, and
   * transition the row 'leased'→'running'; the actual capture → judge → terminal
   * verdict runs as a DETACHED promise that release()s its lease in finally. This
   * is what makes the doctrine hold: holding the screen lease synchronously means
   * the very next row's lease probe sees it busy (SERIALIZED), while two null-lease
   * rows each start their detached work back-to-back (PARALLEL, under the OS/CPU
   * cap). The lease-selection step is single-threaded in this loop, so the
   * check-then-acquire on the shared mutex has no intra-scheduler race.
   *
   * If NO usable backend's lease is free the row stays 'queued' (the LANE never
   * blocks — retried next drain). If the chain is empty / no listed backend is in
   * the registry → 'skipped' (a missing precondition is SKIPPED, never failed). We
   * await all detached captures before the pass returns so a rescan pass sees a
   * settled world (freed leases) rather than re-racing in-flight work.
   */
  async drain(): Promise<void> {
    // §5.6 queued-age deadline: BEFORE lease selection, terminalize any queued row
    // whose enqueue-age exceeds the ceiling (it never leased in time). Runs every
    // pass so a released-lease re-nudge OR the fallback timer both expire starved
    // rows through the normal delivery path. Expired rows drop out of selectQueued.
    await this.expireOverAgeQueued();

    // §5.4 priority classes, applied to the FIFO SELECT rather than folded into
    // it (the SQL must keep working on a pre-095 DB — see orderAgentDrainRows).
    // The setup-proof flag is read per row through the same fail-soft query the
    // agent gates use, so a legacy row reports false and keeps its FIFO slot.
    const rows = orderAgentDrainRows(
      this.selectQueued().map((row) => ({
        ...row,
        setupProof: this.agentGateColumnsForRow(row.id).setupProof,
      })),
      this.now(),
    );
    const inFlight: Array<Promise<void>> = [];
    for (const row of rows) {
      // processRow resolves to a { work } HOLDER (never the bare work promise) —
      // an async function auto-awaits a thenable RETURN value, so returning the
      // detached work promise directly would re-serialize the loop. Wrapping it in
      // a plain object keeps `await this.processRow(...)` resolving as soon as the
      // synchronous lease + 'running' transition is done, leaving `work` in flight.
      const { work } = await this.processRow(row);
      if (work) inFlight.push(work);
    }
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
      // RE-NUDGE ON LEASE RELEASE (R1 #2): the in-flight work we just awaited has
      // released its lease(s). A row left 'queued' this pass may have been blocked
      // ONLY on a lease that just freed (lease contention — e.g. two lanes wanting
      // the single 'verify:screen'). Schedule one more drain pass so a released lease
      // with queued work deterministically re-scans — no polling timer. Guarded on
      // inFlight.length > 0 so a pass that leased NOTHING (pool held externally, no
      // work of ours to free it) does NOT spin: it waits for a future enqueue /
      // cancel to nudge instead. nudge() coalesces into the current runDrainLoop via
      // rescanRequested (or schedules a fresh loop when drain() was called directly).
      if (this.hasQueuedRequests()) {
        this.nudge();
      }
    }

    // §5.6 fallback timer: arm (or re-arm / clear) the single coalesced queued-age
    // timer for whatever remains queued after this pass. This is the ONLY wake path
    // for a row that is queued with NO in-flight work of ours to release a lease
    // (e.g. an externally-held pool, or a lone request the health gate keeps
    // skipping-not-leasing) — without it such a row could age past the ceiling
    // unnoticed until the next unrelated enqueue.
    this.armQueuedAgeTimer();
  }

  /**
   * Terminalize every 'queued' row whose enqueue-age exceeds `queuedAgeCeilingMs`
   * (§5.6) as 'skipped' (fail-open) with the concrete lease/queue reason, through
   * the NORMAL markTerminalAndDeliver path (never a silent UPDATE) so its parked
   * merge-gate lane is driven off awaiting-verify with a non-blocking finding.
   * Returns the count expired. Fail-soft per row: a delivery throw is swallowed by
   * markTerminalAndDeliver's own wrapper. The cancel-guarded markTerminal means a
   * row swept concurrently to 'timeout' is a 0-change no-op (no double delivery).
   */
  private async expireOverAgeQueued(): Promise<number> {
    const nowMs = this.now();
    const rows = this.selectQueued();
    let expired = 0;
    for (const row of rows) {
      const enqueuedMs = Date.parse(row.enqueued_at);
      // An unparseable enqueued_at (should not happen — the column is a DB default
      // ISO string) is treated as NOT expired so a clock/parse glitch never mass-
      // skips the live backlog.
      if (!Number.isFinite(enqueuedMs)) continue;
      const ageMs = nowMs - enqueuedMs;
      if (ageMs < this.queuedAgeCeilingMs) continue;
      const input = parseRequestInput(row.deliverable_json) ?? undefined;
      const ageMin = Math.round(ageMs / 60000);
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        {
          error: `queued-age deadline exceeded — request never acquired a lease within ${ageMin} min (persistent resource contention or a wedged pool)`,
          ...(this.isAgentEngineRequest(row) ? { captureOrigin: 'agent' as const } : {}),
        },
        undefined,
        [],
        input,
      );
      expired += 1;
    }
    if (expired > 0) {
      this.logger?.warn('[VerificationScheduler] expired over-age queued requests', { expired });
    }
    return expired;
  }

  /**
   * Arm the single coalesced queued-age fallback timer at the EARLIEST remaining
   * queued-age expiry, or clear it when nothing is queued (§5.6). Re-armed at the
   * end of every drain pass — cheap (one min-scan + one setTimeout). On fire it
   * calls nudge(), funneling into the EXISTING drain loop (no second loop); the
   * next drain's expireOverAgeQueued does the terminalization. `unref`ed so it
   * never keeps the process alive.
   */
  private armQueuedAgeTimer(): void {
    if (this.queuedAgeTimer !== null) {
      clearTimeout(this.queuedAgeTimer);
      this.queuedAgeTimer = null;
    }
    const row = this.db
      .prepare(`SELECT MIN(enqueued_at) AS earliest FROM verification_requests WHERE status = 'queued'`)
      .get() as { earliest: string | null } | undefined;
    const earliest = row?.earliest ?? null;
    if (earliest === null) return; // nothing queued — no timer
    const earliestMs = Date.parse(earliest);
    if (!Number.isFinite(earliestMs)) return;
    const delay = Math.max(0, earliestMs + this.queuedAgeCeilingMs - this.now());
    const timer = setTimeout(() => {
      this.queuedAgeTimer = null;
      this.nudge();
    }, delay);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.queuedAgeTimer = timer;
  }

  /** True when at least one request row is still awaiting a drain ('queued'). */
  private hasQueuedRequests(): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM verification_requests WHERE status = 'queued' LIMIT 1`)
      .get();
    return row !== undefined;
  }

  /** SELECT the 'queued' backlog in fair FIFO order. */
  private selectQueued(): VerificationRequestRow[] {
    return this.db
      .prepare(
        `SELECT id, run_id, project_id, status, verify_type, deliverable_json,
                chain_json, current_backend, attempt, enqueued_at
           FROM verification_requests
          WHERE status = 'queued'
          ORDER BY enqueued_at ASC, id ASC`,
      )
      .all() as VerificationRequestRow[];
  }

  /**
   * Process ONE queued row up to the SYNCHRONOUS lease + status transition, then
   * return the DETACHED capture→judge→terminal work as a promise (or null when the
   * row settled inline — skip — or could not lease — left queued). The lease is
   * acquired and the row marked 'leased'→'running' BEFORE returning, so when the
   * drain loop moves to the next row a held single-screen lease is already visible
   * as busy (serialization), while a null-lease row imposes no such hold (the next
   * null-lease row starts immediately → parallel).
   *
   * Returns a { work } holder (NOT the bare promise — see drain()):
   *   - { work: null }          → settled inline (skipped) OR no free lease (queued).
   *   - { work: Promise<void> } → the in-flight capture work (drain awaits all).
   */
  private async processRow(row: VerificationRequestRow): Promise<{ work: Promise<void> | null }> {
    const type = row.verify_type as VerificationType;
    const parsed = parseRequestInput(row.deliverable_json);
    if (!parsed) {
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        { error: 'unparseable deliverable_json' },
        undefined,
        [],
      );
      return { work: null };
    }

    // DISPATCH ON THE ENGINE KEY (redesign §5.8): an agent-engine request routes
    // to the VerificationAgentRunner instead of the capture-backend + VLM
    // waterfall below. `isAgentEngineRequest` reads the request's own
    // `chain_json` first (the `__quick__` late-binding case, where posture is
    // resolved at call time and the run stamp cannot carry it) and falls back to
    // the RUN stamp for everything else — which is what every flow run hits, since
    // its request's chain_json is always the empty intersection. A legacy stamp
    // (or an unreadable one — fail-soft) falls through byte-identically.
    if (this.isAgentEngineRequest(row)) {
      return this.agent.processAgentRow(row, parsed);
    }

    // ROOT-CAUSE FIX (S8): hydrate the request input from the run's verify.json
    // deliverable recipe BEFORE lease selection, so a startable deliverable's
    // `start` is on `input` by the time the Rung-1 Playwright backend's
    // requiredLease(input) runs — that is the SINGLE signal it keys off to ask for a
    // `verify:port` lease (inputDeclaresDevServer). Without this the resolver was
    // only read INSIDE maybeSpawnDevServer (AFTER the lease was chosen), so input
    // never carried `start`, the backend never leased a port, and no dev server ever
    // spawned — the dev-build verification path was inert. Resolve ONCE here and
    // thread the result into maybeSpawnDevServer so verify.json is loaded a single
    // time per request. Fail-soft: a resolver throw / no provider / no matching
    // deliverable leaves the resolution null and input unhydrated (no `start` ⇒ no
    // port lease ⇒ no dev server ⇒ the static url/htmlPath capture path runs exactly
    // as before this layer).
    const resolved = await this.resolveDeliverableContext(row, parsed);
    const input = this.hydrateInput(parsed, resolved?.deliverable);

    const chain = this.parseChain(row.chain_json);
    // Select the candidate backends through the three ordered gates (registry →
    // health → dev-server-need), cheapest rung first. An empty result is a MISSING
    // PRECONDITION and resolves 'skipped' (never a fabricated FAIL) with a reason.
    const { candidates, skipReason } = await this.selectCandidates(chain, input);
    if (candidates.length === 0) {
      // Empty/absent/unhealthy chain OR a dev-server input with no port-capable
      // backend — a missing precondition. SKIP, never fail (a missing TCC grant /
      // uninstalled chromium / static-only chain for a startable deliverable must
      // not wedge a sprint with a blocking finding + merge-gate loopbacks).
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        { error: skipReason ?? 'no usable backend' },
        undefined,
        [],
        input,
      );
      return { work: null };
    }

    // Pick the cheapest backend whose required lease is currently free.
    let chosen: VisualBackend | null = null;
    let lease: LeaseHandle | null = null;
    for (const backend of candidates) {
      const acquired = await this.acquireLeaseFor(backend, input);
      if (acquired) {
        chosen = backend;
        lease = acquired;
        break;
      }
    }

    if (!chosen || !lease) {
      // Every usable backend's lease is held. Leave 'queued' — the LANE does not
      // block; we retry on the next drain.
      this.logger?.debug('[VerificationScheduler] no free lease; leaving queued', {
        requestId: row.id,
        chain: candidates.map((b) => b.id),
      });
      return { work: null };
    }

    // Transition leased→running SYNCHRONOUSLY (the lease is already held), then
    // detach the capture work so the drain loop proceeds to the next row at once.
    //
    // CANCEL-SAFE TRANSITION (R1 #3a): markLeased is status-guarded to
    // `status = 'queued'`. If cancelForRun swept this row to 'timeout' during the
    // await windows above (deliverable-context resolve / lease acquire), the guarded
    // UPDATE changes 0 rows — the row is no longer ours to run. Release the
    // just-acquired lease and return WITHOUT capturing/judging (which would spend a
    // paid VLM call and clobber the canceled status). The row keeps its canceled
    // 'timeout'; no delivery fires (nothing to enrich / no lane to advance).
    const leasedChanges = this.markLeased(row.id, chosen.id);
    if (leasedChanges === 0) {
      lease.release();
      this.logger?.debug('[VerificationScheduler] row no longer queued at lease time; releasing lease, skipping capture', {
        requestId: row.id,
        backend: chosen.id,
      });
      return { work: null };
    }
    this.markRunning(row.id, chosen.id);
    return { work: this.capture.runChosen(row, type, input, chosen, lease, resolved) };
  }

  // --------------------------------------------------------------------------
  // Verification-AGENT engine (redesign §5.4/§5.7) — the dispatch predicates and
  // the row/path readers the engine shares with the drain and the runbook
  // bootstrap. The engine itself (gates → slot lease → deploy → settle) is
  // AgentEngine in agentEngine.ts (issue #19 step 8).
  // --------------------------------------------------------------------------

  /**
   * True when a persisted chain JSON is exactly `['agent']` (the agent engine,
   * §5.8). Parsed defensively — accepting the 'agent' member the legacy
   * VisualBackendId parse would drop — and fail-soft to false (legacy path) on
   * malformed JSON. Shared by the run-stamp read and the request-row read so both
   * halves of the dispatch key agree on what "agent" looks like on the wire.
   */
  private chainJsonIsAgent(raw: unknown): boolean {
    if (typeof raw !== 'string' || raw.length === 0) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length === 1 && parsed[0] === 'agent';
    } catch {
      return false;
    }
  }

  /**
   * THE dispatch key: does this request run on the agent engine?
   *
   * Two rungs, request-row FIRST:
   *
   *   1. `chain_json === '["agent"]'` — the request carries its OWN resolved
   *      engine. Only the `__quick__` chat sentinel writes this: its posture is
   *      resolved at CALL time (the sentinel is minted once per session, long
   *      before the global toggle is consulted, and `verify_chain` has no UPDATE
   *      path — see visualVerificationResolver.ts:5-7), so the run stamp cannot
   *      carry it. A request row is never re-enqueued, so this is every bit as
   *      immutable as the run stamp it stands in for.
   *   2. Otherwise the RUN stamp (`isAgentStampedRun`) — the original §5.8 key,
   *      unchanged.
   *
   * FLOW RUNS ARE BYTE-IDENTICAL under this change. An agent-stamped flow run's
   * request already persists `chain_json: '[]'`, because the MCP handler
   * intersects `FALLBACK_CHAINS[type]` with a chain narrowed to `VisualBackendId[]`
   * — and 'agent' is not one, so the intersection is always empty. Rung 1 misses,
   * rung 2 decides exactly as before.
   *
   * Every consumer of the key goes through THIS method — drain dispatch, the
   * `CYBOFLOW_VERIFY_LEGACY` boot sweep, and the queued-age expiry's provenance
   * stamp — so a quick request is swept and attributed with the same provenance
   * as a flow run's rather than being stranded by a sweep that only knew about
   * the run stamp.
   */
  private isAgentEngineRequest(row: { run_id: string; chain_json: string | null }): boolean {
    if (this.chainJsonIsAgent(row.chain_json)) return true;
    return this.isAgentStampedRun(row.run_id);
  }

  /**
   * True when the row's RUN is stamped `verify_chain: ['agent']` (the agent
   * engine, §5.8). Fail-soft to false (legacy path) when workflow_runs / the
   * column is unavailable (a minimal test DB with only verification_requests).
   * Read fresh per row from the injected db; the stamp is immutable per run, so
   * there is no staleness concern.
   *
   * Prefer {@link isAgentEngineRequest} at any site that has the request row —
   * this one alone cannot see a `__quick__` request's call-time-resolved posture.
   */
  private isAgentStampedRun(runId: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT verify_chain FROM workflow_runs WHERE id = ?')
        .get(runId) as { verify_chain: string | null } | undefined;
      return this.chainJsonIsAgent(row?.verify_chain);
    } catch {
      return false;
    }
  }

  /** Read `workflow_runs.worktree_path` for a run (the snapshot source / fallback cwd); null when unavailable. */
  private worktreePathForRun(runId: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
        .get(runId) as { worktree_path: string | null } | undefined;
      const p = row?.worktree_path;
      return typeof p === 'string' && p.trim().length > 0 ? p : null;
    } catch {
      return null;
    }
  }

  /**
   * The migration-095 gate columns, read in their OWN defensive query rather
   * than folded into {@link agentColumnsForRow}: on a pre-095 DB the widened
   * SELECT throws, and losing `task_json` to that throw would silently degrade
   * every agent row to the synthesized bare-intent task. Fail-soft answers are
   * the pre-phase-0 posture — no stamped modality (the caller re-derives it) and
   * neither kind of proof run (counted, gated, exactly as today).
   *
   * TWO RUNGS, for the same reason this method exists at all: migration 107's
   * `bootstrap_proof` is younger than 095's `setup_proof`, so a DB at 095/096
   * throws on the widened SELECT. Falling back to the narrower one keeps the
   * modality and the setup flag rather than losing all three, and reports
   * `bootstrapProof: false` — which is not a guess but the truth for every row
   * such a DB can contain.
   */
  private agentGateColumnsForRow(id: string): {
    modality: VerificationModality | null;
    setupProof: boolean;
    bootstrapProof: boolean;
  } {
    try {
      const row = this.db
        .prepare('SELECT modality, setup_proof, bootstrap_proof FROM verification_requests WHERE id = ?')
        .get(id) as { modality: unknown; setup_proof: unknown; bootstrap_proof: unknown } | undefined;
      return {
        modality: isVerificationModality(row?.modality) ? row.modality : null,
        setupProof: row?.setup_proof === 1 || row?.setup_proof === true,
        bootstrapProof: row?.bootstrap_proof === 1 || row?.bootstrap_proof === true,
      };
    } catch {
      try {
        const row = this.db
          .prepare('SELECT modality, setup_proof FROM verification_requests WHERE id = ?')
          .get(id) as { modality: unknown; setup_proof: unknown } | undefined;
        return {
          modality: isVerificationModality(row?.modality) ? row.modality : null,
          setupProof: row?.setup_proof === 1 || row?.setup_proof === true,
          bootstrapProof: false,
        };
      } catch {
        return { modality: null, setupProof: false, bootstrapProof: false };
      }
    }
  }

  /** The project's checkout path (`projects.path`); null when unknown/unreadable. */
  private projectPathFor(projectId: number): string | null {
    try {
      const row = this.db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
        | { path: unknown }
        | undefined;
      return typeof row?.path === 'string' && row.path.trim().length > 0 ? row.path : null;
    } catch {
      return null;
    }
  }

  /**
   * §5.2 seam 3, ENQUEUE half — resolve the PROVEN runbook revision a request
   * for this (project, modality) must be pinned to, or `null` when there is
   * none. Public because BOTH enqueue entry points (the MCP handler and the
   * programmatic `enqueueTaskVerification` seam) need the identical answer and
   * the store is injected HERE, not into either of them; the shared merge +
   * validation logic that consumes this lives in one place too
   * (`enqueueFromTask.prepareVerificationEnqueue`).
   *
   * WHY THE PROBE PATH IS THE RUN'S WORKTREE FIRST. `status()` re-validates the
   * proof against the portable file at a specific tree, and the tree that
   * matters is the one the requesting run is actually changing — a run whose
   * branch edited (or has not yet merged) the runbook must be judged by ITS
   * copy, not by the project's main checkout. That is the same worktree-first
   * ladder `verifyConfigLoader` walks, for the same reason. The project path is
   * the fallback for a run with no worktree; with neither, there is nothing to
   * probe and the answer is `null` (no pin ⇒ the §3.2 degrade gate decides).
   *
   * A null answer is NEVER an error path — it is "this request executes
   * unpinned", which for a build/serve task means the degrade gate skips it with
   * a setup CTA, and for a degenerate pre-live task means nothing changes at
   * all.
   */
  /**
   * F5 ∘ F4 composition — does ANY runbook record (proven, drifted, or a
   * registered/file-only draft) exist for this (project, modality) on the probed
   * tree? `resolveProvenRunbook` answers only for a PROVEN one, and since F4 made
   * drift non-writing a project can sit in `drifted` for a long stretch; an
   * undeclared lane that consulted proven records alone would then resolve to
   * `web` and the bootstrap would derive a rival web runbook next to the
   * drifted cdp-app one. Presence lets the lane keep pointing at the modality
   * that has a record, so the bootstrap takes F4's re-prove path (drifted) or
   * the derive path (draft) for THAT modality. Same probe ladder as
   * `resolveProvenRunbook`; never throws (a hiccup answers "absent").
   */
  async runbookRecordPresent(args: {
    projectId: number;
    runId: string;
    modality: VerificationModality;
    probePath?: string;
  }): Promise<boolean> {
    const probePath =
      args.probePath ?? this.worktreePathForRun(args.runId) ?? this.projectPathFor(args.projectId);
    if (probePath === null || probePath === undefined) return false;
    try {
      const detail = await this.runbookStatus(args.projectId, args.modality, probePath);
      return detail.status !== 'absent';
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] runbook presence probe failed (fail-soft: absent)', {
        projectId: args.projectId,
        runId: args.runId,
        modality: args.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async resolveProvenRunbook(args: {
    projectId: number;
    runId: string;
    modality: VerificationModality;
    /** The caller's own worktree, when it has one (skips the run-row lookup). */
    probePath?: string;
  }): Promise<ProvenRunbookRevision | null> {
    const store = this.runbookStore;
    if (!store) return null;
    const probePath =
      args.probePath ?? this.worktreePathForRun(args.runId) ?? this.projectPathFor(args.projectId);
    if (probePath === null || probePath === undefined) return null;
    try {
      const status = await store.status(args.projectId, probePath, args.modality);
      if (status !== 'proven') return null;
      const current = store.getCurrent(args.projectId, args.modality);
      if (current === null) return null;
      // The cast is safe by construction: `parseVerifyRunbookV1` only ever
      // populates keys from VERIFY_RUNBOOK_MODALITIES, so a VerificationModality
      // outside that subset ('mobile') simply misses — the same narrowing the
      // store's own `declaresModality` does.
      const entry = current.runbook.modalities[args.modality as VerifyRunbookModality];
      if (entry === undefined) return null;
      return { hash: current.hash, version: current.version, entry };
    } catch (err) {
      // A resolution hiccup must never fail an enqueue: answer "unpinned" and
      // let the gate speak.
      this.logger?.warn('[VerificationScheduler] proven-runbook resolution failed (fail-soft)', {
        projectId: args.projectId,
        runId: args.runId,
        modality: args.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * §12 step 1 — the runbook-bootstrap PREFLIGHT, asked by the enqueue seam
   * BEFORE a request row exists.
   *
   * Lives on the scheduler because the scheduler already holds all three inputs
   * and nobody else holds any of them: the resolved `visualVerify` config (the
   * toggle), the `runbookStatus` thunk (the SAME one the degrade gate consults,
   * which is the point — the preflight must not be able to form a second opinion
   * about a project's runbook), and the run→worktree ladder. The decision itself
   * is a separate, dependency-free module so it can be tested without any of
   * this; this method is only the wiring.
   *
   * NEVER THROWS, and the caller treats any failure as "do not bootstrap".
   */
  async evaluateRunbookBootstrap(args: {
    projectId: number;
    runId: string;
    laneTaskRef: string;
    modality: VerificationModality;
    task: VerificationTaskV1;
    /** The caller's own worktree, when it has one (skips the run-row lookup). */
    probePath?: string;
  }): Promise<BootstrapDecision> {
    const probePath =
      args.probePath ?? this.worktreePathForRun(args.runId) ?? undefined;
    return runbookBootstrapPreflight(
      {
        projectId: args.projectId,
        runId: args.runId,
        laneTaskRef: args.laneTaskRef,
        modality: args.modality,
        task: args.task,
        ...(probePath !== undefined ? { probePath } : {}),
      },
      {
        // The project toggle AND the host kill switch, combined here so the
        // decision module never reads the environment. Both are read at CALL
        // time — the toggle through `liveConfig`, because the boot-time snapshot
        // made a Settings checkbox require a restart to mean anything, in both
        // directions and with nothing in the UI saying so.
        enabled:
          (this.liveConfig?.() ?? this.config).autoBootstrapRunbook === true &&
          !runbookBootstrapKillSwitchEngaged(),
        status: (projectId, modality, path) => this.runbookStatus(projectId, modality, path),
        ...(this.logger ? { logger: this.logger } : {}),
      },
    );
  }

  /**
   * §12 steps 2–8 — DECIDE and, when the decision is yes, ACT.
   *
   * The one entry point `enqueueTaskVerification` calls. It is deliberately the
   * whole thing rather than a decision the caller then acts on, because the two
   * halves must not be able to drift: a caller that consulted the preflight and
   * then applied its own idea of what "proceed" means is how a feature ends up
   * bootstrapping the case §4 says never to bootstrap.
   *
   * WHAT THE CALLER DOES WITH THE RESULT IS THE SAME IN EVERY CASE: carry on to
   * the ordinary enqueue. On `'proven'` that enqueue now resolves the freshly
   * proven runbook, merges it, pins it, and passes the §3.2 gate — the lane
   * verifies exactly as it would on a project a human had configured. On every
   * other outcome the gate skips it with a reason that names the situation. The
   * bootstrap has no channel to fail a lane and must not grow one.
   *
   * TWO THINGS IT MAY DECIDE TO DO (F4 / Codex #2). `decision.mode` carries
   * through verbatim: `'derive'` authors (or adopts) a runbook and commits it,
   * `'reprove'` re-runs the proof over a record that DRIFTED and writes nothing
   * at all. The mode is not re-derived here from anything — computing it twice is
   * how a drifted project ends up with a machine-authored rival over a human's
   * runbook, which is precisely the case this seam is not allowed to get wrong.
   *
   * NEVER THROWS. `runRunbookBootstrap` has its own catch-all, and this method
   * wraps the whole thing again because it is reached from the enqueue seam,
   * whose contract is that it cannot crash a lane.
   */
  async maybeBootstrapRunbook(args: {
    projectId: number;
    runId: string;
    laneTaskRef: string;
    modality: VerificationModality;
    task: VerificationTaskV1;
    probePath?: string;
  }): Promise<BootstrapRunOutcome | { kind: 'not-attempted'; reason: BootstrapDeclineReason }> {
    const decision = await this.evaluateRunbookBootstrap(args);
    if (!decision.proceed) return { kind: 'not-attempted', reason: decision.reason };
    if (this.runbookBootstrap === undefined) {
      // The phase-2 posture, preserved on purpose: the decision is computed and
      // logged, and nothing acts on it.
      this.logger?.debug('[VerificationScheduler] runbook bootstrap would fire but no runner is wired', {
        runId: args.runId,
        projectId: args.projectId,
        laneTaskRef: args.laneTaskRef,
        modality: args.modality,
      });
      return { kind: 'not-attempted', reason: 'disabled' };
    }

    const probePath = args.probePath ?? this.worktreePathForRun(args.runId) ?? undefined;
    if (probePath === undefined) {
      // Nothing to survey and nothing to commit into. This is the same tree the
      // decision was made against, so a run with no worktree could not have been
      // bootstrapped whatever the decision said.
      this.logger?.debug('[VerificationScheduler] runbook bootstrap skipped: the run has no worktree', {
        runId: args.runId,
        laneTaskRef: args.laneTaskRef,
      });
      return { kind: 'not-attempted', reason: 'unobservable' };
    }

    try {
      const common = {
        projectId: args.projectId,
        runId: args.runId,
        laneTaskRef: args.laneTaskRef,
        modality: args.modality,
        worktreePath: probePath,
      };
      // `adopt` travels only on the arm that has one: a reprove is not authoring
      // anything, so there is no adopt-vs-author decision to pass it (F4 /
      // Codex #2 — see RunbookBootstrapArgs).
      return await this.runbookBootstrap(
        decision.mode === 'derive'
          ? { ...common, mode: 'derive', adopt: decision.adopt, proveRegistered: decision.proveRegistered }
          : { ...common, mode: 'reprove' },
      );
    } catch (err) {
      this.logger?.warn('[VerificationScheduler] runbook bootstrap threw (degrading to today\'s skip)', {
        runId: args.runId,
        projectId: args.projectId,
        laneTaskRef: args.laneTaskRef,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'not-attempted', reason: 'unobservable' };
    }
  }

  /**
   * R2 — the pure, ordered backend-selection guard. Given the request's stamped
   * chain + its HYDRATED input, return the candidate backends (cheapest rung first)
   * the scheduler may lease, applying three gates IN ORDER:
   *
   *  (1) REGISTRY — only backends present in the injected registry survive (a
   *      host-dep-unavailable backend is simply absent). Cheapest rung first.
   *  (2) HEALTH (R2 #2) — only backends whose memoized `healthCheck()` currently
   *      reports healthy survive. This is the documented SECOND gate: an unhealthy
   *      backend (declined peekaboo TCC / uninstalled chromium) is treated EXACTLY
   *      like an unregistered one, so its capture is never attempted (a blocking
   *      FAIL for an environment problem is turned into a clean SKIP instead).
   *  (3) DEV-SERVER (R2 #1) — when the hydrated input declares a dev server
   *      (non-empty `start`), the request CANNOT be satisfied by a backend that
   *      cannot host one: restrict to backends whose `requiredLease(input)` is a
   *      port lease (the Rung-1 Playwright path that pairs with the scheduler-owned
   *      dev server). Otherwise capturePage (rung 0, null lease — first in the
   *      static/responsive chains) would capture the deliverable's `url` against a
   *      port NOTHING listens on → ERR_CONNECTION_REFUSED → a false FAIL. For a
   *      STATIC input (no `start`) the chain is left untouched, so capturePage stays
   *      first and the fast path is byte-identical.
   *
   * When a gate empties the chain, `candidates` is `[]` and `skipReason` explains
   * which precondition is missing — the caller resolves the request 'skipped'
   * (never 'failed'), matching the existing empty-chain SKIP semantics.
   */
  private async selectCandidates(
    chain: VisualBackendId[],
    input: VerificationRequestInput,
  ): Promise<{ candidates: VisualBackend[]; skipReason: string | null }> {
    if (chain.length === 0) {
      return { candidates: [], skipReason: 'empty chain' };
    }
    // (1) REGISTRY — present backends, cheapest rung first.
    const registered = chain
      .map((id) => this.backends[id])
      .filter((b): b is VisualBackend => b !== undefined)
      .sort((a, b) => a.rung - b.rung);
    if (registered.length === 0) {
      return { candidates: [], skipReason: 'no listed backend available' };
    }
    // (2) HEALTH — drop any backend whose memoized probe is unhealthy.
    const healthy: VisualBackend[] = [];
    for (const backend of registered) {
      if (await this.isBackendHealthy(backend)) {
        healthy.push(backend);
      }
    }
    if (healthy.length === 0) {
      return { candidates: [], skipReason: 'no healthy backend available' };
    }
    // (3) DEV-SERVER — a startable deliverable needs a port-capable backend.
    if (this.inputDeclaresDevServer(input)) {
      const portCapable = healthy.filter((b) => this.leaseIsPort(b.requiredLease(input)));
      if (portCapable.length === 0) {
        return {
          candidates: [],
          skipReason: 'dev server required but no port-capable backend available',
        };
      }
      return { candidates: portCapable, skipReason: null };
    }
    return { candidates: healthy, skipReason: null };
  }

  /**
   * R2 #2 — memoized health probe. Returns the backend's cached healthCheck result
   * when it is within HEALTH_CHECK_MEMO_TTL_MS of the last probe, else re-probes and
   * caches. Fail-soft: a `healthCheck()` that THROWS/rejects counts as UNHEALTHY (the
   * backend is dropped from selection, exactly like an unregistered one) and is logged
   * at debug — a transient probe failure must never surface as a request FAIL.
   */
  private async isBackendHealthy(backend: VisualBackend): Promise<boolean> {
    const nowMs = this.now();
    const cached = this.healthMemo.get(backend.id);
    if (cached && nowMs - cached.at < HEALTH_CHECK_MEMO_TTL_MS) {
      return cached.ok;
    }
    let ok: boolean;
    try {
      ok = await backend.healthCheck();
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] backend healthCheck threw; treating as unhealthy', {
        backend: backend.id,
        error: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }
    this.healthMemo.set(backend.id, { ok, at: nowMs });
    return ok;
  }

  /**
   * True when the request's hydrated input declares a scheduler-owned dev server —
   * i.e. carries a non-empty `start` command. This is the SAME signal the Rung-1
   * Playwright backend's requiredLease reads; the scheduler mirrors it (it cannot
   * import the service-side helper — standalone-typecheck invariant) so backend
   * selection and lease acquisition agree.
   */
  private inputDeclaresDevServer(input: VerificationRequestInput): boolean {
    return typeof input.start === 'string' && input.start.trim().length > 0;
  }

  /**
   * True when a backend's requiredLease name is a dev-server PORT lease — either the
   * VERIFY_PORT_ANY sentinel ("any free pooled port") or a concrete 'verify:port:<p>'.
   * A port lease is the only kind that can host the scheduler-owned dev server, so it
   * is the discriminator the dev-server selection gate keys off. A null lease (rung 0)
   * or the 'verify:screen'/'verify:sim:' leases are NOT port leases.
   */
  private leaseIsPort(lease: string | null): boolean {
    return lease === VERIFY_PORT_ANY || (lease !== null && lease.startsWith('verify:port:'));
  }

  /**
   * S8 — resolve the run's verify.json dev-server context ONCE per request (the
   * project worktree cwd + the matching deliverable recipe), via the injected
   * devServerContextResolver. The resolution is reused both for input hydration
   * (BEFORE lease selection) and for maybeSpawnDevServer (AFTER the port lease), so
   * verify.json is loaded a SINGLE time per request — no double fs read.
   *
   * Returns null when there is nothing to resolve (no resolver injected / no
   * matching deliverable / no worktree) OR when the resolver throws — every null
   * case fail-softs to the unhydrated, static-capture path. NEVER throws.
   */
  private async resolveDeliverableContext(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
  ): Promise<{ cwd: string; deliverable: DeliverableVerifyConfig } | null> {
    if (!this.devServerContextResolver) return null;
    try {
      return await this.devServerContextResolver({
        runId: row.run_id,
        projectId: row.project_id,
        input,
      });
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] deliverable context resolve failed; leaving input unhydrated', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * S8 — merge a matched verify.json deliverable's recipe into the request input,
   * producing the HYDRATED input fed to lease selection + capture. AGENT-PROVIDED
   * VALUES WIN: a field already present (non-empty) on the request input is left
   * untouched; only an absent/empty field is filled from the deliverable. No
   * deliverable (resolver absent / no match) ⇒ input returned unchanged
   * (referentially identical), so a non-dev-server request is byte-identical to
   * before this layer.
   *
   * Every deliverable field with a VerificationRequestInput counterpart is hydrated
   * (each only when the agent left it absent/empty):
   *   - `start` — the SOLE signal the Rung-1 Playwright backend's requiredLease(input)
   *     reads to ask for a `verify:port` lease (and the dev-server selection gate). The
   *     deliverable's build/readyWhen stay on the `deliverable` (the provider reads
   *     them off its `config` arg in maybeSpawnDevServer) — they are NOT input fields.
   *   - `assertions` — explicit deterministic checks (decision #3).
   *   - `interactions` — the ordered DOM steps for interactive-web-behavior. WITHOUT
   *     this the Playwright backend screenshots the PRE-interaction page while the VLM
   *     judges against the post-interaction intent → false FAILs + loopbacks.
   *   - `viewports` — the responsive widths for responsive-multi-viewport.
   *   - `baselineKey` — the golden-baseline selector for the SSIM pre-diff, falling
   *     back to the deliverable `id` (the STABLE cross-run key that makes
   *     accept-as-baseline round-trippable). Without hydration a verify.json baseline
   *     never engages the SSIM pre-diff.
   *   - `htmlPath` (S9) — a STATIC deliverable (built html, no running url, no dev
   *     server) becomes first-class. Filled ONLY when the request declares neither a
   *     `url` (a running server the agent pointed at) NOR an `htmlPath` (an explicit
   *     target), so an agent-passed target is never shadowed. This gives the S9 static
   *     server an entry path to stand up; `staticRoot` does NOT ride the input (it is a
   *     serve-time concern flowing via resolvedContext at spawn) — only the entry path
   *     belongs on the input the backend captures.
   */
  private hydrateInput(
    input: VerificationRequestInput,
    deliverable: DeliverableVerifyConfig | undefined,
  ): VerificationRequestInput {
    if (!deliverable) return input;
    const hydrated: VerificationRequestInput = { ...input };
    let changed = false;
    // `start` — the signal the Rung-1 Playwright backend's requiredLease reads.
    if ((hydrated.start === undefined || hydrated.start.trim().length === 0) && deliverable.start) {
      hydrated.start = deliverable.start;
      changed = true;
    }
    // `htmlPath` (S9) — a static deliverable's built html entry. Fill ONLY when the
    // request declares neither a running `url` nor an explicit `htmlPath`, so an
    // agent-passed target is never clobbered. staticRoot deliberately does NOT ride the
    // input (serve-time concern, threaded via resolvedContext at S9 spawn time).
    const urlAbsent = hydrated.url === undefined || hydrated.url.trim().length === 0;
    const htmlPathAbsent = hydrated.htmlPath === undefined || hydrated.htmlPath.trim().length === 0;
    if (urlAbsent && htmlPathAbsent && deliverable.htmlPath && deliverable.htmlPath.trim().length > 0) {
      hydrated.htmlPath = deliverable.htmlPath;
      changed = true;
    }
    // `assertions` — explicit deterministic checks (decision #3). Only fill when the
    // agent passed none, so an inline assertion list is never clobbered.
    if (
      (hydrated.assertions === undefined || hydrated.assertions.length === 0) &&
      deliverable.assertions &&
      deliverable.assertions.length > 0
    ) {
      hydrated.assertions = deliverable.assertions;
      changed = true;
    }
    // `interactions` — ordered DOM steps for interactive-web-behavior. Only fill when
    // the agent passed none, so an inline interaction list is never clobbered.
    if (
      (hydrated.interactions === undefined || hydrated.interactions.length === 0) &&
      deliverable.interactions &&
      deliverable.interactions.length > 0
    ) {
      hydrated.interactions = deliverable.interactions;
      changed = true;
    }
    // `viewports` — responsive widths. Only fill when the agent passed none.
    if (
      (hydrated.viewports === undefined || hydrated.viewports.length === 0) &&
      deliverable.viewports &&
      deliverable.viewports.length > 0
    ) {
      hydrated.viewports = deliverable.viewports;
      changed = true;
    }
    // `baselineKey` — golden-baseline selector for the SSIM pre-diff. Fill only when
    // the agent left it absent; fall back to the deliverable id (the STABLE cross-run
    // key that makes accept-as-baseline round-trippable — R7 builds on this).
    if (hydrated.baselineKey === undefined || hydrated.baselineKey.trim().length === 0) {
      const key = deliverable.baselineKey ?? deliverable.id;
      if (typeof key === 'string' && key.trim().length > 0) {
        hydrated.baselineKey = key;
        changed = true;
      }
    }
    return changed ? hydrated : input;
  }

  /**
   * Acquire the lease a backend needs for this request, or null when it is held.
   * A null requiredLease (rung 0 / rung 1 sans dev server / judge) returns the
   * always-available no-lease handle. The single-display lease is a count-1
   * acquire; a 'verify:port:'/'verify:sim:' name is probed against the configured
   * pool so a busy pool returns null (leave queued) rather than spinning.
   */
  private async acquireLeaseFor(
    backend: VisualBackend,
    input: VerificationRequestInput,
  ): Promise<LeaseHandle | null> {
    const required = backend.requiredLease(input);
    if (required === null) {
      return this.leasePool.noLease();
    }
    // A pooled lease (port/sim): probe every member of the configured pool and
    // take the first free slot, regardless of which exact name the backend named.
    const poolCandidates = this.poolCandidatesFor(required);
    if (poolCandidates) {
      return this.leasePool.tryAcquireOneOf(poolCandidates);
    }
    // A singleton lease (e.g. 'verify:screen'): exact-name count-1 probe.
    return this.leasePool.tryAcquire(required);
  }

  /**
   * Map a backend's requiredLease name to the configured pool of candidate slots,
   * or null when it is a singleton (non-pooled) lease. A 'verify:port:*' required
   * name expands to every configured dev port; 'verify:sim:*' to every configured
   * simulator.
   *
   * The VERIFY_PORT_ANY sentinel ("any free pooled port") expands PURELY from the
   * configured pool — it is NEVER appended as an extra candidate. Appending it (or
   * any synthetic ':0' name) would mint a phantom always-free count-1 slot that
   * survives pool exhaustion, defeating the dev-server concurrency cap and yielding
   * port 0 (portFromLease(sentinel) → null) under contention. A backend that names a
   * CONCRETE 'verify:port:<p>' is included so it still contends within the pool, but
   * we guard against the sentinel/':0' phantom names explicitly.
   */
  private poolCandidatesFor(required: string): readonly string[] | null {
    if (required === VERIFY_PORT_ANY || required.startsWith('verify:port:')) {
      const fromPool = this.config.devServerPorts.map(verifyPortLease);
      // Any-port sentinel + any non-real ':0' phantom: expand from the pool ONLY.
      if (required === VERIFY_PORT_ANY || this.portFromLease(required) === null) {
        return fromPool;
      }
      return fromPool.includes(required) ? fromPool : [...fromPool, required];
    }
    if (required.startsWith('verify:sim:')) {
      const fromPool = this.config.simulatorDevices.map(verifySimLease);
      return fromPool.includes(required) ? fromPool : [...fromPool, required];
    }
    return null;
  }

  /**
   * Read the run's `workflow_runs.batch_id` via the injected DatabaseLike. Returns
   * the trimmed non-empty batch id, or null for a non-batch run / when the column
   * or table is unavailable (e.g. a minimal test DB with only
   * verification_requests). The scheduler never imports better-sqlite3/electron —
   * this is a plain SELECT on the same injected db. Fail-soft: a thrown query
   * (missing table) degrades to "no batch", so a non-batch capture path is
   * byte-identical to before this layer.
   */
  private batchIdForRun(runId: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT batch_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { batch_id: string | null } | undefined;
      const batchId = row?.batch_id;
      if (typeof batchId !== 'string') return null;
      const trimmed = batchId.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] batch_id lookup failed; treating as non-batch run', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Acquire the batch worktree-sync mutex (`sprint-verify-<batchId>`) for a batched
   * run, or null for a non-batch run (no batch_id). BLOCKING count-1 over the SAME
   * shared mutex the port/screen leases use (leasePool.sharedMutex) so it composes
   * app-wide and serializes concurrent captures on the same batchId. Called in
   * runChosen AFTER the dev-server/port lease and BEFORE backend.capture; released
   * in the SAME finally as the other leases. The returned handle is idempotent on
   * release (NO_LEASE-style), and null for a non-batch run so the finally guard has
   * nothing to release.
   */
  private async acquireBatchMutex(runId: string): Promise<LeaseHandle | null> {
    const batchId = this.batchIdForRun(runId);
    if (!batchId) return null;
    const name = sprintVerifyBatchLease(batchId);
    // Count-1 BLOCKING acquire (NOT the non-blocking pool probe): the second
    // concurrent capture on this batchId waits here until the first releases.
    //
    // Timeout MUST exceed how long a holder can legitimately hold this mutex. A
    // holder keeps it for its WHOLE capture+judge lifetime, bounded by
    // requestTimeoutMs (default 5 min) — far longer than the Mutex 30s default,
    // which would THROW 'Mutex timeout' on any capture exceeding 30s and land in
    // runChosen's catch as a spurious 'failed', defeating the very serialization
    // this slice provides. A waiter can also stack behind several concurrent
    // batched holders (rung-0 captures run in parallel), so size the bound as
    // requestTimeoutMs * BATCH_MUTEX_MAX_QUEUED_HOLDERS — generous enough that a
    // genuinely serialized waiter WAITS rather than fails.
    const acquireTimeoutMs = this.requestTimeoutMs * BATCH_MUTEX_MAX_QUEUED_HOLDERS;
    const release = await this.leasePool.sharedMutex.acquire(name, acquireTimeoutMs);
    let released = false;
    this.logger?.debug('[VerificationScheduler] acquired batch worktree-sync mutex', {
      runId,
      lease: name,
    });
    return {
      name,
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  }

  /**
   * S5 — has this project reached its per-project verification budget cap? Reads
   * projects.visual_verify_budget_calls (NULL = unlimited) + the cumulative
   * SUM(verification_requests.judge_calls_used) for the project via the injected
   * DatabaseLike. Returns true only when a budget is set AND the cumulative used
   * count is at/above it. Fail-soft: a thrown query (missing column / minimal test
   * DB) degrades to "not exhausted" so a budget-less deployment is byte-identical to
   * before this layer (the per-run cap still applies upstream at the capped judge).
   *
   * ONE counter, TWO engines (redesign §5.8): `maxPerRunJudgeCalls` /
   * `visual_verify_budget_calls` generalized from a VLM-judge-call cap into a
   * per-run VERIFICATION budget — this same check gates a verification-AGENT
   * deployment on the default v1 engine (called from runAgentChosen) exactly as
   * it gates a VlmJudge call on the legacy engine (called below, from
   * runChosen). The column/field names predate the redesign and are unchanged.
   */
  private isProjectBudgetExhausted(projectId: number): boolean {
    try {
      const proj = this.db
        .prepare('SELECT visual_verify_budget_calls AS budget FROM projects WHERE id = ?')
        .get(projectId) as { budget: number | null } | undefined;
      const budget = proj?.budget;
      if (typeof budget !== 'number' || budget < 0) return false; // NULL / unset = unlimited
      const usedRow = this.db
        .prepare(
          'SELECT COALESCE(SUM(judge_calls_used), 0) AS used FROM verification_requests WHERE project_id = ?',
        )
        .get(projectId) as { used: number } | undefined;
      const used = usedRow?.used ?? 0;
      return used >= budget;
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] budget lookup failed; treating as unlimited', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * S5 — increment THIS request's judge_calls_used counter (budget aggregation +
   * cost telemetry). A counter UPDATE on the request's OWN row, consistent with
   * markTerminal — not a router-owned table, so it stays within the no-direct-write
   * rules. Fail-soft (a minimal test DB without the column degrades silently).
   *
   * Despite the name, this counts a verification-AGENT deployment (the default
   * v1 engine) exactly as it counts a legacy VlmJudge call — one shared budget
   * counter across both engines (redesign §5.8); the column name predates the
   * redesign and is unchanged.
   */
  private incrementJudgeCallsUsed(id: string): void {
    try {
      this.db
        .prepare('UPDATE verification_requests SET judge_calls_used = judge_calls_used + 1 WHERE id = ?')
        .run(id);
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] judge_calls_used increment failed', {
        requestId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Parse the integer port out of a 'verify:port:<p>' lease name; null otherwise. */
  private portFromLease(name: string | null): number | null {
    if (!name || !name.startsWith('verify:port:')) return null;
    const port = Number.parseInt(name.slice('verify:port:'.length), 10);
    return Number.isInteger(port) ? port : null;
  }

  // --------------------------------------------------------------------------
  // cancelForRun — terminate a run's outstanding requests
  // --------------------------------------------------------------------------

  /**
   * Mark every non-terminal (queued/leased/running) request for a run as
   * 'timeout' (canceled) AND abort any of its in-flight captures/judges. Called on
   * run cancel / teardown (cancelRunHandler) so a paused or aborted run leaves no
   * orphaned requests for the drain to pick up AND no detached capture/judge promise
   * still burning a lease / a vision call.
   *
   * Order matters: ABORT the live controllers FIRST, then UPDATE. The abort makes
   * each in-flight runChosen see `signal.aborted` and unwind to its own 'timeout'
   * write (or, for an abort-unaware backend, finish and release its lease); this
   * UPDATE is the authoritative sweep that also catches QUEUED rows (never started,
   * so not in inFlight) and any row whose detached promise has not yet reached its
   * terminal write. Already-terminal rows are untouched. Returns rows swept here.
   */
  cancelForRun(runId: string): number {
    // (1) Abort the live in-flight work for this run. Find which tracked controllers
    // belong to runId via the non-terminal rows, then abort each present handle.
    const liveRows = this.db
      .prepare(
        `SELECT id FROM verification_requests
          WHERE run_id = ? AND status IN ('leased', 'running')`,
      )
      .all(runId) as Array<{ id: string }>;
    let aborted = 0;
    for (const { id } of liveRows) {
      const controller = this.inFlight.get(id);
      if (controller && !controller.signal.aborted) {
        controller.abort();
        aborted += 1;
      }
    }

    // (2) Authoritative sweep: mark every non-terminal request 'timeout'. This is
    // ALSO what handles queued rows (never in inFlight) and any leased/running row
    // whose detached unwind has not yet written its own terminal status. A row whose
    // runChosen wins the race and writes 'timeout' first is simply re-stamped here
    // with the same status (the WHERE drops it once terminal on the next observation).
    const res = this.db
      .prepare(
        `UPDATE verification_requests
            SET status = 'timeout', ended_at = ?, error_message = 'canceled'
          WHERE run_id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .run(new Date().toISOString(), runId);
    if (res.changes > 0 || aborted > 0) {
      this.logger?.info('[VerificationScheduler] canceled requests for run', {
        runId,
        canceled: res.changes,
        aborted,
      });
    }
    return res.changes;
  }

  // --------------------------------------------------------------------------
  // DB write helpers (status-guarded; never a direct router-table write)
  // --------------------------------------------------------------------------

  /**
   * queued → leased (records the chosen backend + leased_at). Returns the UPDATE's
   * .changes: 0 means the row was no longer 'queued' (cancelForRun swept it to
   * 'timeout' during processRow's await windows), so the caller must release the
   * just-acquired lease and NOT run capture/judge (R1 #3a).
   */
  private markLeased(id: string, backend: VisualBackendId): number {
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = 'leased', current_backend = ?, leased_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .run(backend, new Date().toISOString(), id).changes;
  }

  /** leased → running. Returns the UPDATE's .changes. */
  private markRunning(id: string, backend: VisualBackendId): number {
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = 'running', current_backend = ?
          WHERE id = ? AND status = 'leased'`,
      )
      .run(backend, id).changes;
  }

  // --------------------------------------------------------------------------
  // Parsing helpers
  // --------------------------------------------------------------------------

  /** Parse chain_json into a VisualBackendId[]; empty array on null / malformed. */
  private parseChain(json: string | null): VisualBackendId[] {
    if (!json) return [];
    try {
      const parsed: unknown = JSON.parse(json);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }
}

