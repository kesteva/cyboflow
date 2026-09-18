/**
 * AgentEngine — the verification-AGENT engine (redesign §5.4/§5.7), split out
 * of verificationScheduler.ts (issue #19 step 8). See the class doc below; the
 * §-references are to docs/proposals/verification-setup-flow.md and
 * docs/proposals/visual-verification-design.md.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron', 'fs',
 * 'better-sqlite3', or concrete main/src/services import — the runner, stores,
 * probes, and DB are the same injected seams the scheduler already took.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import {
  parseVerificationTaskV1,
  resolveTaskModality,
} from '../../../../shared/types/visualVerification';
import type {
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerificationFailureClass,
  VerificationModality,
  VerificationRequestInput,
  VerificationTaskV1,
  VerificationType,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationAgentRequest,
  VerificationAgentRunResult,
  VerificationAgentRunnerLike,
} from './verificationAgentRunner';
import { classifyVerificationFailure } from './failureClassifier';
import type { VerifyCapabilityStore } from './capabilityStore';
import type { VerifyRunbookStatusDetail, VerifyRunbookStore } from './runbookStore';
import { declineForRunbookStatus, taskDerivesEnvironment } from './bootstrapEligibility';
import type { CapabilityBreakerFindingFn } from './verificationSchedulerContracts';
import {
  VERIFY_SCREEN_LEASE,
  raceWithAbort,
  verifyAgentSlot,
  verifyPortLease,
} from './verificationLeases';
import type { LeaseHandle, ResourceLeasePool } from './verificationLeases';
import {
  NATIVE_CAPTURE_UNAVAILABLE_DETAIL,
  UNSUPPORTED_MODALITY_REASONS,
  VERIFY_UNPROVEN_SKIP_BLOCKED,
  skipReasonForRunbookDecline,
} from './verificationSkipReasons';
import type { VerificationRequestRow } from './verificationRequestRows';
import type { TerminalDelivery } from './terminalDelivery';

/** The §3.2 runbook-status resolver the scheduler is composed with (VerificationSchedulerDeps.runbookStatus). */
export type RunbookStatusResolver = (
  projectId: number,
  modality: VerificationModality,
  probePath?: string,
) => Promise<VerifyRunbookStatusDetail>;

/** What {@link AgentEngine} is composed over — the scheduler passes its own deps + helpers through. */
export interface AgentEngineDeps {
  db: DatabaseLike;
  logger?: LoggerLike;
  /** The scheduler's resolved config (agentSlots, simulatorDevices). */
  config: ResolvedVisualVerifyConfig;
  /** The SHARED lease pool — agent slots, ports, and the screen lease are the same names the drain leases. */
  leasePool: ResourceLeasePool;
  artifactsDirResolver: (runId: string) => string;
  agentRunner?: VerificationAgentRunnerLike;
  /** Default + ceiling for an agent row's deadline — see DEFAULT_AGENT_REQUEST_TIMEOUT_MS / AGENT_REQUEST_TIMEOUT_CEILING_MS. */
  agentRequestTimeoutMs: number;
  agentRequestCeilingMs: number;
  /** Real port-free probe for the post-deploy port release/quarantine. */
  portFreeProbe: (port: number) => Promise<boolean>;
  capabilityStore?: VerifyCapabilityStore;
  capabilityFinding?: CapabilityBreakerFindingFn;
  /** §4 native-screen capability probe; absent means "no probe ran" (read as unsupported). */
  nativeCaptureProbe?: () => Promise<boolean>;
  runbookStatus: RunbookStatusResolver;
  runbookStore?: VerifyRunbookStore;
  /** The terminal-write + delivery chokepoint every exit of the engine goes through. */
  delivery: TerminalDelivery;
  /** The scheduler's in-flight AbortController registry, SHARED BY REFERENCE (cancelForRun reaches in). */
  inFlight: Map<string, AbortController>;
  // Scheduler-owned row/path readers + helpers the engine shares with the drain and the runbook bootstrap.
  agentGateColumnsForRow: (id: string) => {
    modality: VerificationModality | null;
    setupProof: boolean;
    bootstrapProof: boolean;
  };
  worktreePathForRun: (runId: string) => string | null;
  projectPathFor: (projectId: number) => string | null;
  acquireBatchMutex: (runId: string) => Promise<LeaseHandle | null>;
  isProjectBudgetExhausted: (projectId: number) => boolean;
  incrementJudgeCallsUsed: (id: string) => void;
  portFromLease: (name: string | null) => number | null;
}

/**
 * The verification-AGENT engine (redesign §5.4/§5.7): for a row the drain has
 * classified as agent-stamped, evaluate the phase-0 gates (modality support,
 * capability breaker, runbook status), lease a bounded agent slot (+ the screen
 * lease for native-screen), deploy the verification agent through the injected
 * runner under the per-row deadline, settle the terminal outcome through the
 * delivery chokepoint, and write back the runbook proof + capability ledger.
 * Extracted from VerificationScheduler (issue #19 step 8); the method bodies are
 * the scheduler's, unchanged — the scheduler now holds one `agent` collaborator
 * and dispatches to it from processRow.
 */
export class AgentEngine {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly config: ResolvedVisualVerifyConfig;
  private readonly leasePool: ResourceLeasePool;
  private readonly artifactsDirResolver: (runId: string) => string;
  private readonly agentRunner?: VerificationAgentRunnerLike;
  private readonly agentRequestTimeoutMs: number;
  private readonly agentRequestCeilingMs: number;
  private readonly portFreeProbe: (port: number) => Promise<boolean>;
  private readonly capabilityStore?: VerifyCapabilityStore;
  private readonly capabilityFinding?: CapabilityBreakerFindingFn;
  private readonly nativeCaptureProbe?: () => Promise<boolean>;
  private readonly runbookStatus: RunbookStatusResolver;
  private readonly runbookStore?: VerifyRunbookStore;
  private readonly delivery: TerminalDelivery;
  private readonly inFlight: Map<string, AbortController>;
  private readonly agentGateColumnsForRow: AgentEngineDeps['agentGateColumnsForRow'];
  private readonly worktreePathForRun: (runId: string) => string | null;
  private readonly projectPathFor: (projectId: number) => string | null;
  private readonly acquireBatchMutex: (runId: string) => Promise<LeaseHandle | null>;
  private readonly isProjectBudgetExhausted: (projectId: number) => boolean;
  private readonly incrementJudgeCallsUsed: (id: string) => void;
  private readonly portFromLease: (name: string | null) => number | null;

  constructor(deps: AgentEngineDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.config = deps.config;
    this.leasePool = deps.leasePool;
    this.artifactsDirResolver = deps.artifactsDirResolver;
    this.agentRunner = deps.agentRunner;
    this.agentRequestTimeoutMs = deps.agentRequestTimeoutMs;
    this.agentRequestCeilingMs = deps.agentRequestCeilingMs;
    this.portFreeProbe = deps.portFreeProbe;
    this.capabilityStore = deps.capabilityStore;
    this.capabilityFinding = deps.capabilityFinding;
    this.nativeCaptureProbe = deps.nativeCaptureProbe;
    this.runbookStatus = deps.runbookStatus;
    this.runbookStore = deps.runbookStore;
    this.delivery = deps.delivery;
    this.inFlight = deps.inFlight;
    this.agentGateColumnsForRow = deps.agentGateColumnsForRow;
    this.worktreePathForRun = deps.worktreePathForRun;
    this.projectPathFor = deps.projectPathFor;
    this.acquireBatchMutex = deps.acquireBatchMutex;
    this.isProjectBudgetExhausted = deps.isProjectBudgetExhausted;
    this.incrementJudgeCallsUsed = deps.incrementJudgeCallsUsed;
    this.portFromLease = deps.portFromLease;
  }

  /** Read the request's `task_json` / `snapshot_sha` (migration 078); fail-soft to nulls. */
  private agentColumnsForRow(id: string): { taskJson: string | null; snapshotSha: string | null } {
    try {
      const row = this.db
        .prepare('SELECT task_json, snapshot_sha FROM verification_requests WHERE id = ?')
        .get(id) as { task_json: string | null; snapshot_sha: string | null } | undefined;
      return { taskJson: row?.task_json ?? null, snapshotSha: row?.snapshot_sha ?? null };
    } catch {
      return { taskJson: null, snapshotSha: null };
    }
  }

  /**
   * The migration-096 PIN columns for one row, in their OWN defensive query for
   * the same reason {@link agentGateColumnsForRow} is separate: a pre-096 DB
   * makes the widened SELECT throw, and folding these into an existing query
   * would take `task_json` or the gate flags down with them. Fail-soft answer is
   * "no pin", which is what every legacy row genuinely is.
   */
  private runbookPinForRow(id: string): { hash: string | null; version: number | null } {
    try {
      const row = this.db
        .prepare('SELECT runbook_hash, runbook_local_version FROM verification_requests WHERE id = ?')
        .get(id) as { runbook_hash: unknown; runbook_local_version: unknown } | undefined;
      const hash = typeof row?.runbook_hash === 'string' && row.runbook_hash.length > 0 ? row.runbook_hash : null;
      const version = typeof row?.runbook_local_version === 'number' ? row.runbook_local_version : null;
      return { hash, version };
    } catch {
      return { hash: null, version: null };
    }
  }

  /**
   * The capability ledger's THIRD key component for one request:
   * `verify_capability_state` is keyed `(project_id, modality, runbook_hash)`
   * (migration 095), and this resolves the `runbook_hash` half from the row's
   * own §5.2 pin.
   *
   * WHY THE HASH IS PART OF THE KEY AT ALL, stated once here for every ledger
   * call site (the gates' `getActiveSuppression`/`markUnsupported`, and
   * `recordCapabilityOutcome`'s `recordEnvFailure`/`recordHealthyOutcome`). The
   * ledger's claims are all of the form "standing this project's `web`
   * deliverable up FAILS ON THIS HOST" — and what "standing it up" MEANS is the
   * runbook's build/serve commands. A revision whose dev script was broken
   * earns three env failures and a 24h suppression; the fix is a new revision
   * with different commands, re-derived and re-proven. Keying the counter on
   * (project, modality) ALONE would let the dead revision's failures suppress
   * the fixed one for the rest of the TTL — the ledger would be punishing a
   * project for commands nothing runs any more, and phase 2's whole
   * derive→prove→persist loop would be unable to clear it.
   *
   * `''` — migration 095's column default — is the genuinely-UNPINNED bucket:
   * degenerate pre-live requests that derive no environment, and every legacy
   * row from before 096. It is a real key, not a fallback for "we could not be
   * bothered to look": those requests share a capability story precisely
   * because none of them runs project-authored commands.
   */
  private capabilityRunbookKey(requestId: string): string {
    return this.runbookPinForRow(requestId).hash ?? '';
  }

  /**
   * The composed task the agent runs: the persisted `task_json` when present + valid
   * (dual-format contract §5.2), else a DEGENERATE task synthesized from the legacy
   * input (a bare-intent request) — `summary = intent`, no build/behaviors, `target`
   * carried from any url/htmlPath. This is why an 'agent'-stamped run enqueued the
   * old way (intent only) still deploys the agent rather than erroring.
   */
  private taskForAgentRow(id: string, input: VerificationRequestInput): VerificationTaskV1 {
    const { taskJson } = this.agentColumnsForRow(id);
    if (taskJson) {
      try {
        const parsed = parseVerificationTaskV1(JSON.parse(taskJson));
        if (parsed.ok) return parsed.task;
        this.logger?.debug('[VerificationScheduler] task_json failed validation; using degenerate task', {
          requestId: id,
          error: parsed.error,
        });
      } catch (err) {
        this.logger?.debug('[VerificationScheduler] task_json parse threw; using degenerate task', {
          requestId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const target: { url?: string; htmlPath?: string } = {};
    if (typeof input.url === 'string' && input.url.trim().length > 0) target.url = input.url;
    if (typeof input.htmlPath === 'string' && input.htmlPath.trim().length > 0) target.htmlPath = input.htmlPath;
    return {
      version: 1,
      summary: input.intent,
      behaviors: [],
      ...(input.taskRef ? { taskRef: input.taskRef } : {}),
      ...(Object.keys(target).length > 0 ? { target } : {}),
      ...(input.viewports ? { viewports: input.viewports } : {}),
    };
  }

  /**
   * True when the task implies the agent must BIND a dev/preview server on the leased
   * port (VERIFY_PORT rides only then). A `serve.cmd` means the agent stands one up;
   * a localhost `target.url` names an already-running server it points at (no bind).
   */
  private taskImpliesServer(task: VerificationTaskV1): boolean {
    if (task.serve && typeof task.serve.cmd === 'string' && task.serve.cmd.trim().length > 0) {
      return true;
    }
    const url = task.target?.url;
    return typeof url === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/i.test(url.trim());
  }

  /**
   * The unsupported-modality DETAIL for `modality`, or `null` when the agent
   * engine can run it on this host. Split out of {@link evaluateAgentGates}
   * because `native-screen` alone is answered by a host PROBE rather than by a
   * static table (§4), and folding an await into the gate's precedence chain
   * would obscure that only ONE of the three gates does I/O.
   *
   * `mobile` and any future table entry are unconditional. `native-screen`:
   * no probe wired ⇒ the table's phase-0 detail (unprobed is not capable);
   * probe true ⇒ null (proceed, observe-only); probe false or throwing ⇒
   * {@link NATIVE_CAPTURE_UNAVAILABLE_DETAIL}.
   */
  private async unsupportedModalityDetail(modality: VerificationModality): Promise<string | null> {
    const tableDetail = UNSUPPORTED_MODALITY_REASONS[modality];
    if (tableDetail === undefined) return null;
    if (modality !== 'native-screen' || !this.nativeCaptureProbe) return tableDetail;
    try {
      const capable = await this.nativeCaptureProbe();
      return capable ? null : NATIVE_CAPTURE_UNAVAILABLE_DETAIL;
    } catch (err) {
      // The injected probe's contract is never-throws; a throw is a broken probe,
      // and a broken probe must FAIL CLOSED — native-screen is the one modality
      // whose deployment moves the user's real screen.
      this.logger?.warn('[VerificationScheduler] native capture probe threw; treating host as incapable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return NATIVE_CAPTURE_UNAVAILABLE_DETAIL;
    }
  }

  /**
   * The three PRE-LEASE gates of phase 0
   * (docs/proposals/verification-setup-flow.md §3.2/§3.3/§3.4), evaluated in
   * precedence order. Returns the skip REASON when the request must not run, or
   * `null` to let it proceed. It never MUTATES the request row (it reads the
   * capability ledger, the injected runbook-status thunk, and — for
   * `native-screen` only — the injected host-capability probe; the sole write is
   * the ledger's `markUnsupported`).
   *
   *  1. UNSUPPORTED MODALITY (§3.3/§4). `mobile` has no executable path on the
   *     agent engine — the agent path never consults `verify_type` at all
   *     (dispatch keys solely on the run's chain stamp), so a `mobile-flow`
   *     request would otherwise be deployed and left to fail organically ten
   *     minutes later with an unhelpful message. This states the fact up front
   *     AND records it in the ledger, so the next request for the same
   *     (project, modality) short-circuits at gate 2 without even re-deriving it.
   *
   *     `native-screen` is no longer a HARD skip: phase 1 gave it an executable
   *     observe-only path (driver `native-screenshot`/`attest window`, the
   *     runner's drive-unsupported coercion), so the question became a HOST
   *     question — can this machine capture the screen at all — and it is
   *     answered by the injected {@link VerificationSchedulerDeps.nativeCaptureProbe}
   *     (§4: the retired `peekabooBackend.healthCheck()` both-grants probe).
   *     True ⇒ proceed; false ⇒ the same unsupported skip carrying the
   *     actionable grant-pair detail; ABSENT ⇒ the phase-0 answer unchanged
   *     (unprobed is not capable). A probe that throws is treated as false —
   *     the contract says never-throws, and a broken probe must not fail OPEN
   *     onto the user's live screen.
   *
   *     This gate is why the method is async: the probe is I/O (it shells the
   *     peekaboo binary), and it must run BEFORE any lease is taken so a
   *     capability-less host never holds the screen lease even momentarily.
   *
   *  2. ACTIVE SUPPRESSION (§3.3/§3.4). The ledger says this (project, modality)
   *     is `'unsupported'` or breaker-`'suppressed'` AND the mark has not
   *     self-refreshed (TTL / host-generation — see VerifyCapabilityStore).
   *
   *  3. DEGRADE PATH (§3.2). The request needs an ENVIRONMENT derived for it —
   *     it has a build step or a serve step — and there is no PROVEN runbook for
   *     the modality IN THE TREE THIS REQUEST WOULD EXECUTE IN (the run's
   *     worktree; see the probe-path note on
   *     {@link VerificationSchedulerDeps.runbookStatus}). This deliberately
   *     RETIRES per-run guessing for
   *     build/serve tasks: §1's whole diagnosis is that the agent engine "guesses
   *     per-run with no memory and guesses wrong every time" (0-for-5 in
   *     production; wrong serve form, colliding singletons, wrong ABI, blown
   *     deadline), so continuing to guess buys nothing but a burned deadline and
   *     a lane charged for someone else's port. A DEGENERATE task — a bare
   *     pre-live `target` with no build and no serve — is exempt: pointing a
   *     driver at an already-live URL derives no environment at all, and it is
   *     the ONLY shape that has ever actually passed in production. A
   *     `setup_proof` row is exempt too (§3.6): proving the runbook is how a
   *     project stops being unproven, so gating it would deadlock the bootstrap.
   */
  private async evaluateAgentGates(
    row: VerificationRequestRow,
    task: VerificationTaskV1,
    modality: VerificationModality,
    setupProof: boolean,
    /** This row's ledger key — see {@link capabilityRunbookKey}. */
    runbookHash: string,
    /**
     * Migration 107 — a LANE-DRIVEN bootstrap proof. Exempt from gate (3) on the
     * identical §3.6 reasoning that exempts `setupProof`: this request exists to
     * PROVE the runbook whose absence gate (3) is complaining about, so gating it
     * is a bootstrap deadlock. It is exempt from NOTHING ELSE — gates (1) and (2)
     * still bind (an unsupported modality and an active suppression are facts
     * about the host and the ledger, not about whether a runbook exists), and the
     * budget still charges it.
     */
    bootstrapProof: boolean,
  ): Promise<string | null> {
    // (1) Modalities with no executable path on the agent engine (§3.3), plus the
    // probe-conditional native-screen lane (§4).
    const unsupportedDetail = await this.unsupportedModalityDetail(modality);
    if (unsupportedDetail !== null) {
      const reason = `unsupported modality '${modality}': ${unsupportedDetail}`;
      this.capabilityStore?.markUnsupported(row.project_id, modality, reason, runbookHash);
      return reason;
    }

    // (2) An ACTIVE ledger suppression (§3.3 self-refreshing mark / §3.4 breaker).
    const suppression =
      this.capabilityStore?.getActiveSuppression(row.project_id, modality, runbookHash) ?? null;
    if (suppression !== null) {
      return `verification suppressed for ${modality}: ${suppression.reason}`;
    }

    // (3) The §3.2 degrade path.
    if (setupProof || bootstrapProof) return null;
    // ONE definition of "derives an environment", shared with the bootstrap
    // preflight — see bootstrapEligibility.ts for why they must not be two.
    if (!taskDerivesEnvironment(task)) return null;
    // Probe the tree this request would actually execute in — the run's
    // worktree, the SAME ladder resolveProvenRunbook uses, so the gate and the
    // enqueue-time injection can no longer disagree about which tree they are
    // describing. `undefined` (a run with no worktree row, or an unreadable one)
    // lets the thunk fall back to the project root, which is the old behavior.
    const probePath = this.worktreePathForRun(row.run_id) ?? undefined;
    const runbook = await this.runbookStatus(row.project_id, modality, probePath);
    if (runbook.status === 'proven') return null;
    // NOT all "no proven runbook" are the same situation, and the remedies are
    // mutually exclusive (§4): telling a human to run setup on a branch that is
    // merely missing the file would overwrite the proven record every other
    // branch shares. Classify with the SAME function the preflight declines by.
    return skipReasonForRunbookDecline(declineForRunbookStatus(runbook));
  }

  /**
   * Agent-engine sibling of processRow (§5.4/§4). Acquires, in order: ONE
   * {@link verifyAgentSlot} from the bounded pool, the count-1
   * {@link VERIFY_SCREEN_LEASE} when (and only when) the row's modality is
   * `native-screen`, and one pooled port (always — the bundled driver needs a
   * CDP port even for a non-serving task; VERIFY_PORT is exported only when the
   * task implies a server). Then transitions the row leased→running and detaches
   * the deployment work. Leaves the row 'queued' (LANE never blocks) when ANY of
   * those is held, and resolves 'skipped' (fail-open) when the runner is not
   * configured.
   *
   * LEASE ORDER IS DELIBERATE: slot → screen → port, cheapest-to-reacquire last,
   * with every earlier lease released on a later miss. The screen lease sits
   * INSIDE the slot so a native-screen request can never hold the one screen
   * while waiting for a deployment slot; and because the pool probes are
   * non-blocking, an unlucky interleaving costs a requeue, never a deadlock.
   *
   * SIMPLIFICATION worth naming: the PORT lease is taken for EVERY modality,
   * `native-screen` included, even though a native app is not served over a
   * leased port. `VERIFY_DRIVER_PORT` is part of the runner's env contract
   * unconditionally (verificationAgentRunner exports it on every deploy), so
   * making the port lease modality-conditional would mean either handing the
   * driver an unleased port or forking that contract — both worse than one
   * extra pooled port held by a native run. The cost is bounded: the port pool
   * (5 by default) is larger than the agent pool (2 by default), so a
   * native-screen run can never starve a web run of ports.
   */
  async processAgentRow(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
  ): Promise<{ work: Promise<void> | null }> {
    if (!this.agentRunner) {
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        { error: 'verification agent engine not configured', captureOrigin: 'agent' },
        undefined,
        [],
        input,
      );
      return { work: null };
    }

    const task = this.taskForAgentRow(row.id, input);

    // (0) The phase-0 PRE-LEASE gates (docs/proposals/verification-setup-flow.md
    // §3.2/§3.3/§3.4). Each resolves the row terminal 'skipped' with a concrete
    // reason + `failure_class='env'`, BEFORE any lease, budget, snapshot, or SDK
    // deploy is touched — an honest "this could not run, here is exactly why"
    // instead of the deploy-and-fail-organically the agent path does today.
    const gate = this.agentGateColumnsForRow(row.id);
    const modality =
      gate.modality ?? resolveTaskModality(row.verify_type as VerificationType, task);
    const gateSkip = await this.evaluateAgentGates(
      row,
      task,
      modality,
      gate.setupProof,
      this.capabilityRunbookKey(row.id),
      gate.bootstrapProof,
    );
    if (gateSkip !== null) {
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        {
          error: gateSkip,
          captureOrigin: 'agent',
          failureClass: 'env',
          failureEvidence: [{ source: 'runner', check: 'pre-lease-gate', detail: gateSkip }],
        },
        undefined,
        [],
        input,
      );
      return { work: null };
    }

    const servesPort = this.taskImpliesServer(task);

    // (1) ONE agent-deployment slot from the bounded pool (§4 fn.¹). Every slot
    // held ⇒ leave 'queued' (retry next drain) — the lane is never held.
    const agentLease = await this.leasePool.tryAcquireOneOf(this.agentSlotNames());
    if (!agentLease) {
      this.logger?.debug('[VerificationScheduler] no free agent slot; leaving queued', {
        requestId: row.id,
        slots: this.agentSlotCount(),
      });
      return { work: null };
    }
    // (2) SCREEN EXCLUSIVITY (§4). A native-screen deployment observes the one
    // real display, so it additionally takes the count-1 screen lease — the SAME
    // named lease the legacy Peekaboo backend uses, over the SAME shared mutex,
    // so a native agent run and a legacy native capture can never overlap either.
    // Non-native modalities take nothing here and stay fully parallel.
    let screenLease: LeaseHandle | null = null;
    if (modality === 'native-screen') {
      screenLease = await this.leasePool.tryAcquire(VERIFY_SCREEN_LEASE);
      if (!screenLease) {
        agentLease.release();
        this.logger?.debug('[VerificationScheduler] screen lease held; leaving native-screen row queued', {
          requestId: row.id,
        });
        return { work: null };
      }
    }
    // (3) One pooled port (VERIFY_PORT for a serve, and its +1 for the driver CDP).
    const portLease = await this.leasePool.tryAcquireOneOf(
      this.config.devServerPorts.map(verifyPortLease),
    );
    if (!portLease) {
      screenLease?.release();
      agentLease.release();
      this.logger?.debug('[VerificationScheduler] no free verify port; leaving queued', { requestId: row.id });
      return { work: null };
    }
    const leasedPort = this.portFromLease(portLease.name);
    if (leasedPort === null) {
      portLease.release();
      screenLease?.release();
      agentLease.release();
      await this.delivery.markTerminalAndDeliver(
        row,
        'skipped',
        { error: 'could not resolve leased verify port', captureOrigin: 'agent' },
        undefined,
        [],
        input,
      );
      return { work: null };
    }

    // Cancel-safe transition (mirrors processRow's markLeased guard): a cancel sweep
    // during the lease awaits above makes this a 0-change no-op → release + skip.
    const leasedChanges = this.markAgentLeased(row.id);
    if (leasedChanges === 0) {
      portLease.release();
      screenLease?.release();
      agentLease.release();
      this.logger?.debug('[VerificationScheduler] agent row no longer queued at lease time; releasing', {
        requestId: row.id,
      });
      return { work: null };
    }
    this.markAgentRunning(row.id);

    const { snapshotSha } = this.agentColumnsForRow(row.id);
    return {
      work: this.runAgentChosen(
        row,
        input,
        task,
        agentLease,
        screenLease,
        portLease,
        leasedPort,
        servesPort,
        snapshotSha,
        modality,
        gate.setupProof,
        gate.bootstrapProof,
      ),
    };
  }

  /**
   * The configured agent-slot count, floored at 1. A persisted `agentSlots` of 0
   * (or a negative) would otherwise make {@link agentSlotNames} empty, and an
   * empty candidate list makes `tryAcquireOneOf` return null FOREVER: every agent
   * request would sit 'queued' until the §5.6 age ceiling swept it — a silent,
   * whole-feature outage from one bad config value. ConfigManager does not clamp
   * this, so the clamp lives here, at the single point of use.
   */
  private agentSlotCount(): number {
    return Math.max(1, Math.floor(this.config.agentSlots));
  }

  /** The bounded agent-slot pool's candidate lease names, probed in index order. */
  private agentSlotNames(): string[] {
    return Array.from({ length: this.agentSlotCount() }, (_, i) => verifyAgentSlot(i));
  }

  /** queued → leased for an agent row (no VisualBackendId; current_backend left untouched). */
  private markAgentLeased(id: string): number {
    return this.db
      .prepare(
        `UPDATE verification_requests SET status = 'leased', leased_at = ? WHERE id = ? AND status = 'queued'`,
      )
      .run(new Date().toISOString(), id).changes;
  }

  /** leased → running for an agent row. */
  private markAgentRunning(id: string): number {
    return this.db
      .prepare(`UPDATE verification_requests SET status = 'running' WHERE id = ? AND status = 'leased'`)
      .run(id).changes;
  }

  /**
   * The agent row's effective deadline: the composed `task.timeoutMs` (when
   * positive) FLOORED at the configured default and capped by the ceiling.
   *
   * F2 (RC5, docs/proposals/visual-verification-brittleness-fixes.md) added the
   * floor. The outer `timeoutMs` used to be able to LOWER the deadline without
   * limit, while being documented on no composer-facing surface (only the
   * nested `serve.readyWhen.timeoutMs` is) — so a task-verify composer that
   * guessed `180000` had vr_addb4401 killed at 180s mid-attestation with the
   * build passed and the app already booted; the identical task at `1200000`
   * passed in 7m18s. 2 of the 7 all-time timeouts are that. A composer may now
   * only ever RAISE the deadline toward the ceiling; it can never take it below
   * the default the harness knows a real build → serve → drive → attest cycle
   * needs. Tests inject a small `agentRequestTimeoutMs`, so the floor is that
   * INJECTED default, not the 10-minute production constant.
   */
  private agentDeadlineMs(task: VerificationTaskV1): number {
    const requested =
      typeof task.timeoutMs === 'number' && task.timeoutMs > 0 ? task.timeoutMs : this.agentRequestTimeoutMs;
    return Math.min(this.agentRequestCeilingMs, Math.max(this.agentRequestTimeoutMs, requested));
  }

  /**
   * The DETACHED agent-deployment work for a row already leased + 'running'. Acquires
   * the same batch worktree-sync mutex the legacy path uses, enforces the per-run
   * agent-deployment budget (reusing the judge-call counter), deploys the runner
   * under the per-request deadline via the EXISTING raceWithAbort machinery, and
   * persists the mapped verdict + `report_json` in one terminal write. Releases the
   * agent + batch leases in finally, and RELEASES-OR-QUARANTINES the port lease based
   * on a teardown port probe (§5.4 step 6). Outcome→status is the runner's (§5.7);
   * an abort/deadline is a 'timeout', an unexpected throw a fail-open 'skipped'.
   *
   * PHASE 0 (docs/proposals/verification-setup-flow.md) adds three things here,
   * all AROUND the unchanged deploy: the budget is bypassed + never charged for a
   * `setup_proof` row and is charged only for a runner result that actually
   * DEPLOYED (§3.6); the terminal is run through the conservative §3.1 classifier
   * and persisted with its evidence; and the (project, modality) capability
   * ledger is fed the classified outcome (§3.4 breaker).
   */
  private async runAgentChosen(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    task: VerificationTaskV1,
    agentLease: LeaseHandle,
    /** The count-1 screen lease for a `native-screen` row; null for every other modality (§4). */
    screenLease: LeaseHandle | null,
    portLease: LeaseHandle,
    leasedPort: number,
    servesPort: boolean,
    snapshotSha: string | null,
    modality: VerificationModality,
    setupProof: boolean,
    /**
     * Migration 107 — a lane-driven bootstrap proof. Kept SEPARATE from
     * `setupProof` rather than folded into one "isProof" boolean, because the two
     * differ on exactly the axes this method spends: `setupProof` bypasses the
     * project budget and the judge-call charge, and `bootstrapProof` does NOT.
     * They agree only on the runner's pin expectations (both legitimately execute
     * an unproven draft) and on proof eligibility at settle time.
     */
    bootstrapProof: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(row.id, controller);

    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.logger?.warn('[VerificationScheduler] agent request timed out — aborting', {
        requestId: row.id,
        timeoutMs: this.agentDeadlineMs(task),
      });
      controller.abort();
    }, this.agentDeadlineMs(task));
    if (typeof deadline === 'object' && deadline !== null && 'unref' in deadline) {
      (deadline as { unref: () => void }).unref();
    }

    let batchLease: LeaseHandle | null = null;
    try {
      // Per-run agent-deployment budget (reuses the judge-call counter, §5.8). An
      // exhausted budget is a fail-open 'skipped' with NO deployment (never a FAIL).
      // §3.6: a SETUP/PROOF run BYPASSES the gate entirely — the budget counts
      // ordinary lane traffic, and a proof run silently fail-opening to 'skipped'
      // because lane traffic spent the budget first would make the phase-2 setup
      // flow unable to prove anything on exactly the projects that need it most.
      if (!setupProof && this.isProjectBudgetExhausted(row.project_id)) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'skipped',
          { error: 'per-project visual-verify budget exhausted', captureOrigin: 'agent' },
          undefined,
          [],
          input,
        );
        return;
      }

      // The batch worktree-sync mutex (blocking) — serialize per batch exactly as the
      // legacy path. Released in the SAME finally as the other leases.
      batchLease = await this.acquireBatchMutex(row.run_id);
      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          { error: timedOut ? 'request timed out' : 'aborted', captureOrigin: 'agent' },
          undefined,
          [],
          input,
        );
        return;
      }

      const worktreePath = this.worktreePathForRun(row.run_id);
      if (!worktreePath) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'skipped',
          { error: 'run worktree path unavailable', captureOrigin: 'agent' },
          undefined,
          [],
          input,
        );
        return;
      }

      // §5.2 seam 3 — the pin stamped at enqueue, handed to the runner so it can
      // resolve THAT revision by hash and reject any mismatch before it
      // provisions anything. Read here rather than in processAgentRow so a
      // recovery/replay path that re-enters this method always re-reads the
      // authoritative row value.
      const pin = this.runbookPinForRow(row.id);

      const req: VerificationAgentRequest = {
        runId: row.run_id,
        requestId: row.id,
        projectId: row.project_id,
        task,
        runWorktreePath: worktreePath,
        snapshotSha,
        ...(pin.hash !== null ? { runbookHash: pin.hash } : {}),
        ...(pin.version !== null ? { runbookLocalVersion: pin.version } : {}),
        // §5.3 — which half of the runner's pin check applies. A proof run may
        // legitimately execute an 'unproven-draft' record (proving it is the
        // point) but must pin to the EXACT version it was enqueued against;
        // ordinary traffic is the mirror image. Only the scheduler holds this
        // bit (the `setup_proof` / `bootstrap_proof` columns), so it must be
        // handed over rather than guessed from the task.
        //
        // A BOOTSTRAP proof takes the same half: it was composed from a draft the
        // controller registered moments earlier, so demanding a 'proven' record
        // would reject the very thing it exists to prove. The runner's flag is
        // therefore "is this a proof run", not "is this the setup flow".
        ...(setupProof || bootstrapProof ? { setupProof: true } : {}),
        artifactsDir: this.artifactsDirResolver(row.run_id),
        verifyPort: servesPort ? leasedPort : null,
        verifyDriverPort: leasedPort + 1,
        // Thread the effective deadline into the query boundary so its internal
        // deadline matches this method's abort timer — a task-supplied timeoutMs
        // above the query default is honored instead of silently cut to 10 min.
        timeoutMs: this.agentDeadlineMs(task),
        // §4 — the SAME modality the pre-lease gates and the screen-lease decision
        // used, handed to the runner rather than re-derived there. Only the
        // scheduler can know it (it owns `verify_type` and the stamped column,
        // neither of which the runner sees), and a second derivation from the task
        // shape alone could disagree with the one that just decided whether this
        // request may touch the screen at all.
        modality,
        signal: controller.signal,
      };

      // ABORT-BOUNDED (R1 #1a): a runner that never settles can no more hang the
      // drain than a hung capture — race it against the deadline/cancel signal.
      const result = await raceWithAbort(
        this.agentRunner!.run(req),
        controller.signal,
        'agent',
        this.logger,
      );

      // §3.6 BUDGET ORDERING CHANGE (was: a pre-deploy increment mirroring the
      // VLM path). The counter is now bumped AFTER the runner returns and ONLY
      // when a session was actually deployed, because the §3.5 preflight
      // deliberately returns without deploying — charging it would spend a
      // project's lifetime budget on requests that never cost a token, and on a
      // misconfigured host that is EVERY request until the budget silently
      // fail-opens the whole project to 'skipped'. A `setup_proof` row is never
      // counted at all (it bypassed the gate above; counting it would let proof
      // runs exhaust the lane budget). The accepted cost of the reorder: a crash
      // in the window between the deploy and this line undercounts by one —
      // strictly better than charging for undeployed work.
      if (result.deployed && !setupProof) {
        this.incrementJudgeCallsUsed(row.id);
      }

      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          {
            error: timedOut ? 'request timed out' : 'aborted',
            captureOrigin: 'agent',
            ...(result.preflight ? { preflight: result.preflight } : {}),
          },
          undefined,
          result.fileNames,
          input,
        );
        return;
      }

      await this.settleAgentTerminal(
        row,
        input,
        result,
        modality,
        setupProof,
        snapshotSha,
        bootstrapProof,
      );
    } catch (err) {
      const aborted = controller.signal.aborted;
      controller.abort();
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error('[VerificationScheduler] agent deployment error', {
        requestId: row.id,
        aborted,
        error: message,
      });
      // §3.6 companion to the deployed-conditional increment above, for the one
      // path that never yields a `result`: a DEADLINE expiry (raceWithAbort
      // rejects, so the runner's own `deployed` flag is unobservable). The
      // deadline is minutes long while the §3.5 preflight settles in well under a
      // second, so by the time `timedOut` fires the runner was past its pre-deploy
      // gate and an SDK session was (almost certainly) spent — charge it, exactly
      // as the old pre-deploy increment did. A NON-deadline abort (a cancelForRun
      // sweep) stays uncharged: it can fire at any point, including before the
      // deploy, and an unknowable charge should favor the project's budget.
      if (timedOut && !setupProof) {
        this.incrementJudgeCallsUsed(row.id);
      }
      await this.delivery.markTerminalAndDeliver(
        row,
        aborted ? 'timeout' : 'skipped',
        { error: aborted ? (timedOut ? 'request timed out' : 'aborted') : message, captureOrigin: 'agent' },
        undefined,
        [],
        input,
      );
    } finally {
      clearTimeout(deadline);
      this.inFlight.delete(row.id);
      if (batchLease) {
        batchLease.release();
      }
      await this.releaseOrQuarantinePort(portLease, leasedPort);
      // The screen lease releases UNCONDITIONALLY and never quarantines: unlike a
      // port (which a leaked dev server can keep genuinely occupied past
      // teardown), the display is not a resource this deployment can leave dirty
      // — the observe-only native path spawns no long-lived screen owner. Held
      // for the whole deployment, released here in the same chain as the rest.
      screenLease?.release();
      agentLease.release();
    }
  }

  /**
   * Settle ONE agent runner result: classify it (§3.1), write the terminal with
   * its classification + evidence + preflight, then feed the (project, modality)
   * capability ledger (§3.4).
   *
   * THE CONVERSION AND ITS ONE GUARD RAIL. A `'failed'` whose classification is
   * `'env'` is CONVERTED to `'skipped'`, because a merge-gate FAIL charges the
   * lane's implement-retry budget and sends an agent to "fix" working code
   * because a port was taken. The conversion is safe ONLY because
   * `classifyVerificationFailure` reaches `'env'` exclusively on HARNESS-derived
   * evidence — a failed preflight check, a squatter port probe, instance-lock
   * contention. It never converts on model prose: a `build_failed` the agent
   * wrote with no harness corroboration stays `'ambiguous'` and stays BLOCKING.
   * That asymmetry is the whole §3.1 argument — `skipped` ADVANCES the lane
   * (mergeGateLaneAdvance), so a deliverable defect misclassified as env ships
   * broken code silently, while a false `'ambiguous'` is merely annoying.
   *
   * THE MIRROR CONVERSION, AND WHY IT IS HERE AND NOWHERE ELSE. The rule above
   * has a dual that used to go unenforced: a `'skipped'` that came back from a
   * session which ACTUALLY DEPLOYED and whose failure nothing could attribute
   * (`'ambiguous'`) is a lane ADVANCING on a verification that produced no
   * verdict — the same silent-ship hazard as a misclassified `'env'`, arriving
   * from the other direction. Such a result is converted to `'failed'` (see
   * {@link isUnprovenAdvancingSkip} for the two carve-outs). This is the ONE
   * chokepoint for that invariant: every agent terminal in the engine funnels
   * through this method, so a future runner path that forgets the rule is caught
   * without scattering the same check across every return site. The runner still
   * maps its own statuses honestly at source — this is a backstop, and a warn
   * log fires whenever it has anything to do.
   *
   * LEDGER FEEDBACK runs AFTER the terminal write (never before — the write is
   * cancel-guarded and is the load-bearing act): an env-class terminal counts
   * toward the §3.4 breaker; a pass or a DELIVERABLE-attributed failure is a
   * healthy outcome that resets it (the environment demonstrably worked — it
   * built, served, drove, and judged); `'ambiguous'` and every timeout touch
   * NEITHER, because a signal we could not attribute must not silently suppress a
   * modality (nor silently clear a real suppression).
   *
   * PHASE 2 adds the ENGINE-ENFORCED PROOF (§5.3) at the end: a `setup_proof`
   * request that reached `'passed'` while carrying a pin is the ONLY transition
   * into a `'proven'` runbook. See {@link recordRunbookProof}.
   */
  private async settleAgentTerminal(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    result: VerificationAgentRunResult,
    modality: VerificationModality,
    setupProof: boolean,
    snapshotSha: string | null,
    /** Migration 107 — see {@link VerificationScheduler.processAgentRow}. */
    bootstrapProof: boolean = false,
  ): Promise<void> {
    const isTerminalFailure =
      result.status === 'failed' || result.status === 'timeout' || result.status === 'skipped';
    const classified = isTerminalFailure
      ? classifyVerificationFailure({
          preflight: result.preflight ?? null,
          runnerStatus: result.status,
          reportOutcome: result.report?.outcome ?? null,
          provisionMode: result.provisionMode ?? null,
          // A future harness seam (§3.1): no instance-lock detector exists yet.
          instanceLockContention: false,
          // §5.2 seam 3, now LIVE: the runner rejected execution because the
          // pinned runbook revision could not be resolved, or resolved to
          // content the composed task no longer matches. Harness-derived by
          // construction (a hash lookup + a structural compare, never model
          // prose), which is what makes it eligible for the `'env'` class — and
          // env-class is what keeps it off the lane's retry budget.
          runbookMismatch: result.runbookMismatch === true,
        })
      : null;

    const converted = result.status === 'failed' && classified?.failureClass === 'env';
    // The MIRROR conversion (§3.1 gate integrity), evaluated only when the
    // env conversion did not fire — the two are mutually exclusive by
    // construction (one keys on 'failed'+env, the other on 'skipped'+ambiguous)
    // and stating it here keeps that a fact rather than an accident.
    const blocked = !converted && this.isUnprovenAdvancingSkip(result, classified?.failureClass ?? null);
    const status: RequestStatus = converted ? 'skipped' : blocked ? 'failed' : result.status;
    const evidenceDetail = classified?.evidence.map((e) => e.detail).join('; ') ?? '';
    const errorMessage = converted
      ? `environment failure (harness-verified), not the deliverable: ${evidenceDetail}`
      : blocked
        ? `${VERIFY_UNPROVEN_SKIP_BLOCKED}: ${result.errorMessage ?? 'the deployed session produced no corroborated verdict'}`
        : result.errorMessage;
    if (converted) {
      this.logger?.warn('[VerificationScheduler] env-class failure converted to skip (§3.1)', {
        requestId: row.id,
        modality,
        evidence: evidenceDetail,
      });
    }
    if (blocked) {
      // Expected to be RARE — the runner maps its own statuses accurately at
      // source, so reaching here means either a runner path that regressed or a
      // new one that never considered the merge gate. Logged at warn with the
      // whole shape of the result so the answer to "which path did this" is in
      // the log rather than in a bisect.
      this.logger?.warn(
        '[VerificationScheduler] deployed-but-unverified skip blocked from advancing the lane (§3.1)',
        {
          requestId: row.id,
          modality,
          provisionMode: result.provisionMode ?? null,
          reportOutcome: result.report?.outcome ?? null,
          runnerError: result.errorMessage ?? null,
        },
      );
    }

    // §5.3 — the proof flip runs BEFORE the terminal write, and the ordering is
    // load-bearing rather than incidental.
    //
    // IT USED TO RUN AFTER, on the reasoning that a proof-recording failure must
    // never change a verdict already committed. That reasoning still holds and is
    // preserved by the try/catch below — but the ordering it produced was a race.
    // `awaitTerminal` polls the request ROW, and the row went terminal here,
    // before `deliver()` — a whole pipeline of real IO — and only then did the
    // record flip. A bootstrap waiting on its own proof could therefore observe
    // `passed`, return "proven", and have the lane's very next enqueue read the
    // record as still an unproven draft and skip the verification anyway: the
    // exact outcome the bootstrap spent an agent, a budget charge, two commits
    // and up to fifteen minutes to avoid.
    //
    // Flipping first makes "the row is terminal" mean "the record has already
    // been decided", which is what every reader assumed it meant.
    if ((setupProof || bootstrapProof) && status === 'passed') {
      try {
        await this.recordRunbookProof(row, modality, result, snapshotSha);
      } catch (err) {
        // Swallowed deliberately: the verdict below is the load-bearing act, and
        // a proof-recording failure may not prevent it from being written.
        this.logger?.warn('[VerificationScheduler] recording the runbook proof threw; the verdict still stands', {
          requestId: row.id,
          modality,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.delivery.markTerminalAndDeliver(
      row,
      status,
      {
        captureOrigin: 'agent',
        ...(result.verdict ? { verdict: result.verdict } : {}),
        ...(result.report ? { report: result.report } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(classified
          ? { failureClass: classified.failureClass, failureEvidence: classified.evidence }
          : {}),
        ...(result.preflight ? { preflight: result.preflight } : {}),
      },
      result.verdict,
      result.fileNames,
      input,
    );

    await this.recordCapabilityOutcome(
      row,
      modality,
      result,
      classified?.failureClass ?? null,
      evidenceDetail,
      this.capabilityRunbookKey(row.id),
    );
  }

  /**
   * §3.1 GATE INTEGRITY — is this an advancing skip that NOTHING corroborated?
   * True for a result that (a) actually DEPLOYED an SDK session, (b) came back
   * `'skipped'`, and (c) classified `'ambiguous'`; the caller converts those to
   * a blocking `'failed'`.
   *
   * The three conditions together describe the one dangerous shape: a session
   * ran, produced no attributable failure, and would nonetheless ADVANCE the
   * lane at the merge gate (mergeGateLaneAdvance). Every SAFE skip is excluded
   * by construction rather than by exception — a pre-deploy skip is
   * `deployed:false` (preflight, pin rejection, unresolvable agent, failed
   * provisioning), and a harness-corroborated one classifies `'env'`, which the
   * classifier only ever reaches on harness-derived evidence.
   *
   * TWO CARVE-OUTS, both documented rather than inferred:
   *
   *  1. A CONNECT-LEVEL TRANSPORT failure
   *     ({@link VerificationAgentRunResult.transportFailure}) — the SDK layer
   *     threw and the session had accumulated NO transcript, so the agent never
   *     got a turn. Blocking would turn every API outage into a lane-blocking
   *     FAIL that loops implement agents against code the harness never
   *     examined. The runner narrows the flag to that empty-session shape on
   *     purpose (round-3 finding 4): "our code raised it" was not enough, since
   *     an agent holding `Bash` can kill its own SDK process, and every
   *     MID-SESSION transport failure is now mapped to a blocking `'failed'` at
   *     source rather than arriving here wearing this flag.
   *  2. The §5.7 UNATTRIBUTABLE FALLBACK — a `build_failed`/`launch_failed`
   *     reported while provisioning ran in the DIRTY live worktree. That skip is
   *     the proposal's explicit carve-out: in a worktree carrying every sibling
   *     lane's half-finished edits, a build failure genuinely cannot be charged
   *     to this lane's deliverable, so it fails open on purpose. The pairing is
   *     load-bearing — the same outcomes in SNAPSHOT mode are a blocking
   *     `'failed'` (mapReportToResult) and must stay one.
   */
  private isUnprovenAdvancingSkip(
    result: VerificationAgentRunResult,
    failureClass: VerificationFailureClass | null,
  ): boolean {
    if (!result.deployed || result.status !== 'skipped' || failureClass !== 'ambiguous') return false;
    if (result.transportFailure === true) return false;
    const outcome = result.report?.outcome;
    if (
      result.provisionMode === 'fallback' &&
      (outcome === 'build_failed' || outcome === 'launch_failed')
    ) {
      return false;
    }
    return true;
  }

  /**
   * The §5.3 ENGINE-ENFORCED PROOF: flip the pinned machine-local runbook record
   * to `'proven'` because a `setup_proof` request just PASSED through the real
   * verification path — detached snapshot, prepared deps, real boot, real
   * screenshot, real attestation floor.
   *
   * THE WHOLE POINT IS THAT THE AGENT CANNOT DO THIS. §1's diagnosis of the
   * `.cyboflow/verify.json` era is that a config which is merely WRITTEN earns
   * nothing; §5's answer is "derive → PROVE by running → persist". If the setup
   * flow could call `markProven` itself, "proven" would decay back into "an
   * agent said so" — the exact failure mode being fixed. So the only caller is
   * here, on the engine's own terminal path, gated on a status the engine
   * computed.
   *
   * The proof provenance recorded is §5.3's list: the sha actually verified, the
   * portable hash and local version that were pinned, a compact preflight
   * summary (what the host looked like when it passed), the timestamp, and the
   * request id that produced it — enough for a human reading a later demotion to
   * see what changed.
   *
   * A PROOF FROM THE DIRTY FALLBACK PROVES NOTHING EITHER (round-3 finding 2).
   * A NULL `snapshot_sha` means the sha capture failed and the runner executed
   * in the live shared worktree — every sibling lane's half-finished edits
   * included. §5.3 is explicit that "proof runs in the verifier's environment
   * class (detached snapshot + prepared deps) ... a proof obtained in
   * environment X asserted about environment Y is not a proof", and the
   * provenance blob has nowhere to record a sha that does not exist. Promotion
   * is refused and the record stays a draft: the setup flow re-proves once a sha
   * can be captured, which is a bad day rather than a runbook wearing a green
   * badge it never earned.
   *
   * A REQUEST WITHOUT A PIN PROVES NOTHING. A setup-proof run that carried no
   * `runbook_hash` verified *something*, but nothing content-addressed, so there
   * is no record it could be attesting to; it is logged and dropped.
   *
   * CAS FAILURE IS A WARN, NEVER A VERDICT CHANGE. `markProven` matches on BOTH
   * the hash and the version, so a `registerDraft` that landed between this
   * run's enqueue and its terminal rejects the flip — correctly: the proof
   * attests to content the record no longer holds. The verification itself still
   * passed and is written as such; only the promotion is declined, and the setup
   * flow re-proves against the newer revision.
   *
   * PROMOTION ALSO RE-STAMPS THE PROVENANCE (F4 —
   * docs/proposals/visual-verification-brittleness-fixes.md). The record's
   * `input_hash` / `host_fingerprint_json` are the baseline the drift check
   * compares every later read against, and until now only `registerDraft` ever
   * wrote them — so a proof taken in one tree, or on a host that has moved since
   * the draft was written, was born already drifted. This path now observes both
   * over the requesting run's worktree (else the project root — the same ladder
   * the enqueue gate probes) and hands them to `markProven`. `portable_hash` is
   * deliberately NOT re-stamped (Codex #1): it is the content address every pin
   * resolves through. See the inline comment at the call for the failure
   * handling — a probe that throws degrades to the old status-only flip.
   */
  private async recordRunbookProof(
    row: VerificationRequestRow,
    modality: VerificationModality,
    result: VerificationAgentRunResult,
    snapshotSha: string | null,
  ): Promise<void> {
    const store = this.runbookStore;
    if (!store) return;
    if (snapshotSha === null) {
      this.logger?.warn(
        '[VerificationScheduler] setup proof refused: it ran in the dirty-worktree fallback (§5.3), so the record stays a draft',
        {
          requestId: row.id,
          projectId: row.project_id,
          modality,
          provisionMode: result.provisionMode ?? null,
        },
      );
      return;
    }
    const pin = this.runbookPinForRow(row.id);
    if (pin.hash === null || pin.version === null) {
      this.logger?.debug('[VerificationScheduler] setup-proof passed without a runbook pin; nothing to prove', {
        requestId: row.id,
        modality,
      });
      return;
    }
    try {
      const proofJson = JSON.stringify({
        sha: snapshotSha,
        portableHash: pin.hash,
        localVersion: pin.version,
        preflight: result.preflight
          ? {
              ok: result.preflight.ok,
              checks: result.preflight.checks.map((check) => ({ id: check.id, ok: check.ok })),
            }
          : null,
        verifiedAt: new Date().toISOString(),
        requestId: row.id,
      });
      // F4 / Codex #1 — RE-STAMP THE PROVENANCE THE DRIFT CHECK COMPARES TO.
      // The record's `input_hash` / `host_fingerprint_json` were written by
      // `registerDraft`, over whatever tree and host were current when the DRAFT
      // was written — for the setup flow, a flow worktree; for a record that has
      // sat a while, a host that has since taken an Electron/playwright bump.
      // The proof was obtained HERE, so the record should describe HERE. The
      // probe path is deliberately the SAME ladder the enqueue gate probes
      // (see resolveProvenRunbook): the requesting run's worktree, else the
      // project root — stamping values from a tree the gate never reads would
      // guarantee a drift on the very next request. NEVER `portable_hash`
      // (Codex #1): it is the content address of `portable_json` and the target
      // of every pin, and the snapshot this proof executed in is already
      // disposed. Both CAS predicates are untouched inside `markProven`, and so
      // is a stored `input_hash` when the probe could not observe this tree at
      // all (F4 fix round): `markProven` re-stamps field by field, so a `null`
      // input hash from a worktree that has already been cleaned up is DROPPED
      // rather than written — writing it would make the promotion read as
      // drifted on its very next check.
      const probePath = this.worktreePathForRun(row.run_id) ?? this.projectPathFor(row.project_id);
      let fresh: { inputHash: string | null; hostFingerprint: string } | undefined;
      if (probePath !== null) {
        try {
          fresh = await store.freshProvenance(probePath);
        } catch (err) {
          // A provenance probe that blew up must never cost a proof its
          // promotion: fall through to the status-only flip, which is exactly
          // the pre-F4 behavior.
          this.logger?.warn(
            '[VerificationScheduler] fresh provenance probe failed; promoting without a re-stamp',
            {
              requestId: row.id,
              projectId: row.project_id,
              modality,
              probePath,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      const outcome = store.markProven(row.project_id, modality, pin.hash, pin.version, proofJson, fresh);
      if (outcome.ok) {
        this.logger?.info('[VerificationScheduler] setup proof recorded — runbook is now proven', {
          requestId: row.id,
          projectId: row.project_id,
          modality,
          runbookHash: pin.hash,
          runbookLocalVersion: pin.version,
          // Which of the flips happened, so a later drift is diagnosable: a
          // probe that threw re-stamps nothing, and one that could not read the
          // tree still re-stamps the host half (`markProven` drops a null input
          // hash rather than writing it over the stored baseline).
          provenanceRestamped: fresh !== undefined,
          inputHashObserved: fresh !== undefined ? fresh.inputHash !== null : null,
          probePath,
        });
        return;
      }
      this.logger?.warn('[VerificationScheduler] setup proof could not be recorded (verdict unaffected)', {
        requestId: row.id,
        projectId: row.project_id,
        modality,
        runbookHash: pin.hash,
        runbookLocalVersion: pin.version,
        error: outcome.error,
      });
    } catch (err) {
      this.logger?.warn('[VerificationScheduler] setup-proof recording threw (fail-soft)', {
        requestId: row.id,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The §3.4 circuit-breaker feed. K consecutive env-class failures for a
   * (project, modality) auto-demote it to skip; the trip files ONE non-blocking
   * finding through the injected seam so a human learns the modality went quiet
   * instead of discovering it months later in the request table. Fail-soft
   * throughout — a ledger or finding hiccup must never change a verdict that is
   * already committed.
   */
  private async recordCapabilityOutcome(
    row: VerificationRequestRow,
    modality: VerificationModality,
    result: VerificationAgentRunResult,
    failureClass: VerificationFailureClass | null,
    evidenceDetail: string,
    /** This row's ledger key — see {@link capabilityRunbookKey}. */
    runbookHash: string,
  ): Promise<void> {
    const store = this.capabilityStore;
    if (!store) return;
    try {
      if (failureClass === 'env') {
        const reason = evidenceDetail.length > 0 ? evidenceDetail : (result.errorMessage ?? 'environment failure');
        const { tripped } = store.recordEnvFailure(row.project_id, modality, reason, runbookHash);
        if (tripped && this.capabilityFinding) {
          await this.capabilityFinding({
            projectId: row.project_id,
            runId: row.run_id,
            modality,
            reason,
          });
        }
        return;
      }
      if (result.status === 'passed' || (result.status === 'failed' && failureClass === 'deliverable')) {
        store.recordHealthyOutcome(row.project_id, modality, runbookHash);
      }
    } catch (err) {
      this.logger?.warn('[VerificationScheduler] capability-ledger feedback failed (fail-soft)', {
        requestId: row.id,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Release the agent's port lease, OR quarantine it when the leased port or its
   * driver CDP sidecar (leasedPort+1) will not free (a leaked dev server / browser,
   * §5.4 step 6). Quarantining HOLDS the lease with a re-probe so a leaked port can
   * never collide with the next deployment. With the default always-free probe (no
   * real net probe injected) this always releases — safe in tests.
   */
  private async releaseOrQuarantinePort(portLease: LeaseHandle, leasedPort: number): Promise<void> {
    const probeBothFree = async (): Promise<boolean> =>
      (await this.portFreeProbe(leasedPort)) && (await this.portFreeProbe(leasedPort + 1));
    let free: boolean;
    try {
      free = await probeBothFree();
    } catch {
      free = true; // a probe failure must never wedge teardown — release rather than leak the slot forever.
    }
    if (free) {
      portLease.release();
      return;
    }
    this.logger?.warn('[VerificationScheduler] verify port did not free after agent teardown; quarantining', {
      leasedPort,
      lease: portLease.name,
    });
    this.leasePool.quarantine(portLease, probeBothFree, `agent left port ${leasedPort} bound`);
  }
}
