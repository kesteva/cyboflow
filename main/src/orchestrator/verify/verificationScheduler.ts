/**
 * VerificationScheduler — the main-process singleton that owns the DB-backed
 * verification_requests queue, the ResourceLeasePool (built over the shared
 * `mutex`), and the waterfall drain loop (see docs/visual-verification-design.md
 * §4 + "The collision story"). It is the producer-side scheduler for the layered
 * visual-verification MVP: lane agents fire a request (INSERT 'queued' + nudge),
 * never block; this scheduler drains them on ITS OWN setImmediate loop, leases the
 * scarce resources a chosen backend needs, captures + judges, then writes a
 * terminal verdict.
 *
 * Singleton lifecycle mirrors SprintLaneStore / TaskChangeRouter (initialize /
 * getInstance / _resetForTesting). Pass `logger` at initialize time from
 * main/src/index.ts — omitting it silently disables diagnostics (CLAUDE.md
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
import { EventEmitter } from 'node:events';
import { mutex as globalMutex, type Mutex } from '../../utils/mutex';
import type { DatabaseLike, LoggerLike } from '../types';
import type {
  CaptureContext,
  DeliverableVerifyConfig,
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerificationBackendRegistry,
  VerificationRequestInput,
  VerificationType,
  VerdictV1,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
} from '../../../../shared/types/visualVerification';
import { VERIFY_PORT_ANY, VISUAL_VERIFY_DEFAULTS } from '../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Verification terminal events
//
// A per-run EventEmitter the scheduler fires ONCE when a request reaches a
// terminal status (passed/failed/low_confidence/skipped/timeout) — AFTER the
// onVerdict delivery has run (so any lane write the merge-gate performed is
// already visible to a subscriber). The PROGRAMMATIC visual merge-gate
// (programmatic/visualVerifyGate.ts) subscribes to this to un-park a lane that is
// awaiting its async verdict; it is the wake signal that covers EVERY terminal
// status uniformly — including skipped/timeout, where the merge-gate performs no
// lane write (so a lane-only subscription would never wake). Mirrors
// sprintLaneEvents (sprintLaneStore.ts): a module-level emitter + a per-run channel.
// ---------------------------------------------------------------------------

/** Module-level emitter for verification terminal events, keyed by run channel. */
export const verificationEvents = new EventEmitter();

/** The per-run channel a VerificationTerminalEvent is emitted on. */
export function verificationChannel(runId: string): string {
  return `verify-run-${runId}`;
}

/** The payload emitted on `verificationChannel(runId)` when a request settles. */
export interface VerificationTerminalEvent {
  runId: string;
  requestId: string;
  projectId: number;
  status: RequestStatus;
  type: VerificationType;
  /** The lane this request was attributed to (deliverable_json.taskRef), if any. */
  taskRef?: string;
}

// ---------------------------------------------------------------------------
// Lease names
//
// The ResourceLeasePool emulates N ports / N simulators by holding N DISTINCT
// named count-1 leases over the shared `mutex` and probing for a free one. A
// single-display capture is one count-1 lease ('verify:screen'). Reusing the SAME
// `mutex` singleton is why 'verify:screen' composes app-wide with the
// PanelManager / WorktreeManager holders that already lock named resources there.
// ---------------------------------------------------------------------------

/** The single-display capture lease (Peekaboo / native-desktop). Count-1. */
export const VERIFY_SCREEN_LEASE = 'verify:screen';

/** Build the per-port lease name for one dev-server port. */
export function verifyPortLease(port: number): string {
  return `verify:port:${port}`;
}

/** Build the per-simulator lease name for one device udid. */
export function verifySimLease(udid: string): string {
  return `verify:sim:${udid}`;
}

/**
 * Build the batch worktree-sync mutex name for one sprint batch (L4 / locked
 * decision #5). Acquired AFTER the dev-server/port lease and BEFORE backend
 * capture for any verification operating on a batched run; a count-1
 * serialization point per batchId over the SAME shared `mutex` as the
 * port/screen leases. It prevents a verification reading a half-committed shared
 * sprint worktree: while this is held, the next capture on the same batchId
 * WAITS (it does not start while another lane's verification is mid-capture).
 * A non-batch run (null/empty batch_id) acquires nothing — single-run captures
 * are byte-identical to before this layer.
 */
export function sprintVerifyBatchLease(batchId: string): string {
  return `sprint-verify-${batchId}`;
}

// ---------------------------------------------------------------------------
// ResourceLeasePool — N-slot leasing over the count-1 `mutex`
// ---------------------------------------------------------------------------

/** A held lease; call release() exactly once (the scheduler does so in finally). */
export interface LeaseHandle {
  /** The concrete lease name acquired (e.g. 'verify:port:5173'), or null for the no-lease slot. */
  readonly name: string | null;
  release(): void;
}

/** A lease that needs NO scarce resource (rung 0 / rung 1 sans dev server / judge). */
const NO_LEASE: LeaseHandle = { name: null, release: () => {} };

/**
 * ResourceLeasePool — built OVER the shared count-1 `mutex` (utils/mutex.ts). It
 * does NOT add a second locking primitive; it composes the existing one. A
 * "logical" pool of N ports / N sims is emulated as N distinct count-1 leases:
 * tryAcquireOneOf() probes the candidate names in order and grabs the first whose
 * mutex slot is free (mutex.isLocked === false), returning a LeaseHandle that
 * releases exactly that name.
 *
 * Crucially this is NON-BLOCKING by design — if every candidate is held it returns
 * null IMMEDIATELY (it does NOT await mutex.acquire's spin-until-timeout). The
 * scheduler then LEAVES the request 'queued' and retries next drain, so a busy
 * pool never stalls the drain loop or the lane.
 *
 * Concurrency note: the scheduler drains serially (one request leased per
 * iteration before the next isLocked probe) so the check-then-acquire window is
 * not a race within the scheduler. The mutex itself is the source of truth across
 * the rest of the app.
 */
export class ResourceLeasePool {
  constructor(private readonly mutex: Mutex = globalMutex) {}

  /**
   * The underlying count-1 mutex this pool composes over. Exposed so the
   * scheduler can take a BLOCKING count-1 lock (the batch worktree-sync mutex,
   * `sprint-verify-<batchId>`) on the SAME mutex instance the port/screen leases
   * use, so all named locks compose app-wide. Distinct from tryAcquire* (which is
   * non-blocking): the batch mutex is a serialization point where the second
   * concurrent capture WAITS for the first to release, not a pool that leaves a
   * request queued.
   */
  get sharedMutex(): Mutex {
    return this.mutex;
  }

  /** A lease that needs no scarce resource. Always "available". */
  noLease(): LeaseHandle {
    return NO_LEASE;
  }

  /**
   * Probe `candidates` in order; acquire the FIRST whose count-1 mutex slot is
   * free and return its handle, else return null immediately (pool exhausted).
   * Acquire is awaited but resolves instantly because we only call it on a slot
   * isLocked() already reported free.
   */
  async tryAcquireOneOf(candidates: readonly string[]): Promise<LeaseHandle | null> {
    for (const name of candidates) {
      if (!this.mutex.isLocked(name)) {
        const release = await this.mutex.acquire(name);
        let released = false;
        return {
          name,
          release: () => {
            if (released) return;
            released = true;
            release();
          },
        };
      }
    }
    return null;
  }

  /** Probe + acquire a SINGLE count-1 lease by exact name; null if held. */
  async tryAcquire(name: string): Promise<LeaseHandle | null> {
    return this.tryAcquireOneOf([name]);
  }
}

// ---------------------------------------------------------------------------
// Dev-server provider seam (S2 — scheduler-owned dev server)
//
// The scheduler OWNS the dev server (locked decision #1): for a deliverable whose
// `.cyboflow/verify.json` recipe has a `start` command it stands the deliverable
// up on the leased `verify:port:<p>`, threads the resulting baseUrl into capture,
// and tears it down after. The concrete spawner (DevServerManager) lives under
// main/src/services/* (it imports node:child_process); the scheduler knows ONLY
// this narrow injected interface — it never imports the service (orchestrator->
// services is forbidden; the service imports + implements these types, a
// services->orchestrator import, which is allowed). Mirrors how CapturePageBackend
// + VlmJudge are injected at index.ts.
// ---------------------------------------------------------------------------

/** The args the scheduler passes the provider to stand a deliverable up. */
export interface DevServerSpawnArgs {
  /** The deliverable's verify.json recipe (build/start/readyWhen/url). */
  config: DeliverableVerifyConfig;
  /** The leased port (parsed from the verify:port:<p> lease name). */
  port: number;
  /** The run's project worktree cwd the build/start commands run in. */
  cwd: string;
  /** Per-request abort — interrupts an in-flight build/start/readiness wait. */
  signal: AbortSignal;
}

/**
 * A live dev server the scheduler must tear down after capture. `baseUrl` is what
 * the scheduler rewrites into ctx.input.url (the backend stays stateless — URL
 * threading is the scheduler's job). `release()` performs the graceful-then-forced
 * teardown of the process tree; the scheduler calls it exactly once, in the SAME
 * finally that releases the port lease.
 */
export interface DevServerHandle {
  baseUrl: string;
  release(): Promise<void>;
}

/**
 * The narrow spawner interface injected into the scheduler. `spawn` stands the
 * deliverable up on the leased port and resolves a DevServerHandle once it is
 * ready; it rejects (after tearing down whatever it spawned) on build/spawn/
 * readiness failure or abort. The scheduler imports this TYPE only — the concrete
 * DevServerManager (a service) implements it and is wired in at index.ts.
 */
export interface DevServerProvider {
  spawn(args: DevServerSpawnArgs): Promise<DevServerHandle>;
}

/**
 * Resolves the dev-server spawn context for a request: the project worktree `cwd`
 * the commands run in + the matching `deliverable` recipe from the run's
 * `.cyboflow/verify.json`. INJECTED as a plain async function (wired at index.ts
 * over loadVerifyConfig + the project path) so the scheduler stays fs/electron/
 * service-free — the closure does all the fs work. Returns null when there is no
 * verify.json, no matching deliverable, or no resolvable worktree (the scheduler
 * then skips the dev-server spawn and captures the static url/htmlPath unchanged —
 * MVP Rung-0 behavior preserved).
 */
export type DevServerContextResolver = (args: {
  runId: string;
  projectId: number;
  input: VerificationRequestInput;
}) => Promise<{ cwd: string; deliverable: DeliverableVerifyConfig } | null>;

// ---------------------------------------------------------------------------
// Golden-baseline pre-diff seam (S5 — SSIM gates the VLM)
//
// The DETERMINISTIC-FIRST order (decision #3) inserts an SSIM pre-diff between the
// backend deterministic verdict and the paid VLM: if a request's baselineKey
// resolves to an accepted baseline PNG, the scheduler compares the freshly-captured
// PNG(s) to it; a near-pixel match (>= threshold) is a CHEAP deterministic PASS
// (verdictSource:'ssim_match') with NO vision call. Below threshold the request
// falls through to the VLM, now passing the resolved baselinePath (previously
// always undefined).
//
// Resolution is INJECTED as a plain async function (wired at index.ts over the
// FsBaselineStore + comparePngFiles + the project path) so the scheduler stays
// fs/electron/service-free — the closure does ALL fs + image-decode work. It is
// invoked ONCE per request from input.baselineKey; absent injection / no
// baselineKey / no accepted baseline ⇒ null (intent-only judging = pre-S5 behavior).
// ---------------------------------------------------------------------------

/** The pre-diff outcome for a request whose baselineKey resolved to a baseline. */
export interface BaselinePreDiffResult {
  /**
   * The resolved baseline PNG path (the first viewport's accepted baseline) the
   * scheduler threads into the VlmJudge's baselinePath arg when the pre-diff did
   * NOT match — so the judge still compares against the golden image. Absent when
   * no baseline file exists for any captured viewport.
   */
  baselinePath?: string;
  /** The MIN similarity score across the compared viewports (0..1; 1 = identical). */
  ssimScore: number;
  /** True when ssimScore >= the baseline-match threshold (a cheap deterministic PASS). */
  match: boolean;
}

/**
 * Resolve + compare a request's captured PNG(s) against its golden baseline. INJECTED
 * (wired at index.ts) so the scheduler does no fs / image decoding. Given the request
 * + the captured fileNames (relative to artifactsDir), it resolves the baseline PNGs
 * for input.baselineKey under the project root and returns the comparison, or null
 * when there is nothing to compare (no injection / no baselineKey / no accepted
 * baseline for any captured viewport) — in which case the scheduler runs the VLM with
 * no baselinePath, exactly as before S5.
 */
export type BaselinePreDiffResolver = (args: {
  projectId: number;
  runId: string;
  input: VerificationRequestInput;
  artifactsDir: string;
  fileNames: string[];
}) => Promise<BaselinePreDiffResult | null>;

// ---------------------------------------------------------------------------
// Injected collaborators + optional verdict side-effect hook
// ---------------------------------------------------------------------------

/**
 * The optional verdict-delivery callback. For THIS slice (P5) the real
 * side-effects (ArtifactRouter enrich + ReviewItemRouter finding +
 * SprintLaneStore advance/loopback) are STUBBED behind this hook — P8 wires the
 * concrete one. The scheduler never imports the routers (standalone-typecheck
 * invariant); it only calls back with the terminal outcome. `verdict` is present
 * only for a judged outcome (passed/failed/low_confidence); skipped/timeout pass
 * undefined.
 */
export type OnVerdict = (args: {
  requestId: string;
  runId: string;
  projectId: number;
  type: VerificationType;
  status: RequestStatus;
  verdict?: VerdictV1;
  fileNames: string[];
  /**
   * The original request input (parsed from deliverable_json) — carries
   * `taskRef` for the merge-gate driver's verdict→lane attribution (P8b). Present
   * for every delivered outcome whose row parsed; an unparseable-deliverable skip
   * passes undefined (there is no lane to attribute and nothing to enrich).
   */
  input?: VerificationRequestInput;
}) => void | Promise<void>;

/**
 * The default per-request deadline (5 minutes). When a capture+judge attempt runs
 * longer than this the scheduler `signal.abort()`s the in-flight work and marks the
 * row 'timeout' (releasing the lease). Tunable via VerificationSchedulerDeps.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The default SSIM baseline-match threshold (S5). A captured PNG scoring at or above
 * this against its accepted baseline is a cheap deterministic PASS that SKIPS the
 * paid VLM (verdictSource:'ssim_match'); below it the request falls through to the
 * vision judge with the resolved baselinePath. Mirrors pixelDiff's default so the
 * gate is consistent whether the resolver or the scheduler applies it.
 */
export const DEFAULT_SSIM_MATCH_THRESHOLD = 0.98;

/**
 * How many concurrent batched holders a waiter on `sprint-verify-<batchId>` may
 * legitimately queue behind. The batch mutex is a count-1 serialization point, so a
 * waiter can stack behind several already-held captures (rung-0 null-lease captures
 * truly run concurrently — see runChosen / drain Promise.allSettled). Each holder may
 * legitimately hold for up to requestTimeoutMs (its own capture+judge deadline), so
 * the waiter's acquire timeout must be sized as requestTimeoutMs * this factor — NOT
 * the Mutex 30s default, which would spuriously throw 'Mutex timeout' and mark the
 * second concurrent batched capture 'failed' instead of serializing it (the EXACT
 * guarantee S5 exists to provide). Chosen larger than any realistic per-batch lane
 * fan-out so a genuinely serialized waiter waits rather than fails.
 */
export const BATCH_MUTEX_MAX_QUEUED_HOLDERS = 16;

/** The dependency bag VerificationScheduler.initialize takes. */
export interface VerificationSchedulerDeps {
  db: DatabaseLike;
  /** Capture backends present on this host (absent = host-dep unavailable). */
  backends: VerificationBackendRegistry;
  /** The orthogonal Rung-4 vision judge. */
  judge: VlmJudge;
  /** Resolves a run's $CYBOFLOW_RUN_ARTIFACTS_DIR (injected from index.ts). */
  artifactsDirResolver: (runId: string) => string;
  logger?: LoggerLike;
  /** Resolved visualVerify config (port/sim pools, threshold). Defaults applied. */
  config?: ResolvedVisualVerifyConfig;
  /** Verdict-delivery side-effect hook (P8 wires the real one; stubbed here). */
  onVerdict?: OnVerdict;
  /** Shared lease pool override (tests). Defaults to a pool over the global mutex. */
  leasePool?: ResourceLeasePool;
  /**
   * The scheduler-owned dev-server spawner (S2). When present AND a request's
   * resolved deliverable recipe has a `start` command, the scheduler spawns a dev
   * server on the leased port, threads its baseUrl into capture, and tears it down
   * after. Absent (or no `start`) ⇒ the static url/htmlPath capture path is
   * unchanged (MVP Rung-0 behavior). The concrete DevServerManager (a service) is
   * injected at index.ts; the scheduler never imports it.
   */
  devServerProvider?: DevServerProvider;
  /**
   * Resolves a request's dev-server spawn context (project worktree cwd + the
   * matching verify.json deliverable recipe). Injected as a plain async function so
   * the scheduler stays fs/electron/service-free — the closure (wired at index.ts)
   * does the loadVerifyConfig + project-path fs work. Absent ⇒ no dev server is
   * ever spawned (static capture path preserved).
   */
  devServerContextResolver?: DevServerContextResolver;
  /**
   * Per-request capture+judge deadline in ms. On expiry the in-flight attempt is
   * `signal.abort()`ed and the row is marked 'timeout' (lease released). Defaults
   * to DEFAULT_REQUEST_TIMEOUT_MS (5 min). Tests pass a small value to exercise it.
   */
  requestTimeoutMs?: number;
  /**
   * S5 — the golden-baseline SSIM pre-diff resolver. When present AND a request's
   * baselineKey resolves to an accepted baseline PNG, the scheduler compares the
   * freshly-captured PNG(s) before spending a vision call: a near-pixel match is a
   * cheap deterministic PASS (verdictSource:'ssim_match', NO VLM call); below the
   * match threshold the request falls through to the VLM with the resolved
   * baselinePath. Absent ⇒ intent-only judging (pre-S5 behavior, baselinePath
   * undefined). The concrete resolver (fs + image decode) is wired at index.ts; the
   * scheduler imports only this TYPE (standalone-typecheck invariant).
   */
  baselinePreDiff?: BaselinePreDiffResolver;
  /**
   * S5 — the SSIM baseline-match threshold (0..1). A pre-diff similarity at or above
   * this short-circuits the VLM with an 'ssim_match' PASS. Defaults to
   * DEFAULT_SSIM_MATCH_THRESHOLD. (The resolver itself returns `match`, but the
   * scheduler stamps the threshold-derived PASS, so it owns the gate.)
   */
  baselineMatchThreshold?: number;
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** A queued/leased/running verification_requests row, as the drain SELECT reads it. */
interface VerificationRequestRow {
  id: string;
  run_id: string;
  project_id: number;
  status: string;
  verify_type: string;
  deliverable_json: string;
  chain_json: string | null;
  current_backend: string | null;
  attempt: number;
}

// ---------------------------------------------------------------------------
// VerificationScheduler
// ---------------------------------------------------------------------------

export class VerificationScheduler {
  private static instance: VerificationScheduler | null = null;

  private readonly db: DatabaseLike;
  private readonly backends: VerificationBackendRegistry;
  private readonly judge: VlmJudge;
  private readonly artifactsDirResolver: (runId: string) => string;
  private readonly logger?: LoggerLike;
  private readonly config: ResolvedVisualVerifyConfig;
  private readonly onVerdict?: OnVerdict;
  private readonly leasePool: ResourceLeasePool;
  private readonly requestTimeoutMs: number;
  private readonly devServerProvider?: DevServerProvider;
  private readonly devServerContextResolver?: DevServerContextResolver;
  private readonly baselinePreDiff?: BaselinePreDiffResolver;
  private readonly baselineMatchThreshold: number;

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
    this.judge = deps.judge;
    this.artifactsDirResolver = deps.artifactsDirResolver;
    this.logger = deps.logger;
    this.config = deps.config ?? VISUAL_VERIFY_DEFAULTS;
    this.onVerdict = deps.onVerdict;
    this.leasePool = deps.leasePool ?? new ResourceLeasePool();
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.devServerProvider = deps.devServerProvider;
    this.devServerContextResolver = deps.devServerContextResolver;
    this.baselinePreDiff = deps.baselinePreDiff;
    this.baselineMatchThreshold = deps.baselineMatchThreshold ?? DEFAULT_SSIM_MATCH_THRESHOLD;
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
   * Mirrors recoverActiveStateOrphans (runRecovery.ts): "no in-process worker → the
   * row is an orphan; force it terminal so nothing waits on it forever". Called ONCE
   * at scheduler init from index.ts boot recovery, BEFORE any nudge, so a stale row
   * can never be confused with a live in-flight one (inFlight is empty at boot).
   * Returns the number of rows re-drained. Idempotent: a second call finds none.
   */
  runRecovery(): number {
    const res = this.db
      .prepare(
        `UPDATE verification_requests
            SET status = 'timeout', ended_at = ?, error_message = 'orphaned by process restart'
          WHERE status IN ('leased', 'running')`,
      )
      .run(new Date().toISOString());
    if (res.changes > 0) {
      this.logger?.info('[VerificationScheduler] re-drained orphaned requests on boot', {
        timedOut: res.changes,
      });
    }
    return res.changes;
  }

  // --------------------------------------------------------------------------
  // enqueue — INSERT a 'queued' request and kick the drain
  // --------------------------------------------------------------------------

  /**
   * Insert ONE verification request as 'queued' and return its id immediately.
   * Called by the mcp-request-verification handler (P6); the lane never blocks on
   * the outcome. The chain is stamped from chain_json (resolved live chain); the
   * scheduler picks the cheapest usable backend within it at drain time.
   */
  enqueue(req: {
    runId: string;
    projectId: number;
    type: VerificationType;
    input: VerificationRequestInput;
    chain: VisualBackendId[];
  }): string {
    const id = `vr_${randomUUID().replace(/-/g, '')}`;
    this.db
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, 0)`,
      )
      .run(
        id,
        req.runId,
        req.projectId,
        req.type,
        JSON.stringify(req.input),
        JSON.stringify(req.chain),
      );
    this.logger?.debug('[VerificationScheduler] enqueued request', {
      requestId: id,
      runId: req.runId,
      type: req.type,
      chain: req.chain,
    });
    this.nudge();
    return id;
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
    const rows = this.selectQueued();
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
    }
  }

  /** SELECT the 'queued' backlog in fair FIFO order. */
  private selectQueued(): VerificationRequestRow[] {
    return this.db
      .prepare(
        `SELECT id, run_id, project_id, status, verify_type, deliverable_json,
                chain_json, current_backend, attempt
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
    const input = this.parseInput(row.deliverable_json);
    if (!input) {
      this.markTerminal(row.id, 'skipped', { error: 'unparseable deliverable_json' });
      await this.deliver(row, 'skipped', undefined, []);
      return { work: null };
    }

    const chain = this.parseChain(row.chain_json);
    // Live, present, capability-ordered backends for this request, cheapest first.
    const usable = chain
      .map((id) => this.backends[id])
      .filter((b): b is VisualBackend => b !== undefined)
      .sort((a, b) => a.rung - b.rung);

    if (usable.length === 0) {
      // Empty chain OR every listed backend absent from the registry — missing
      // precondition. SKIP, never fail (a missing TCC grant must not wedge a sprint).
      this.markTerminal(row.id, 'skipped', {
        error: chain.length === 0 ? 'empty chain' : 'no listed backend available',
      });
      await this.deliver(row, 'skipped', undefined, [], input);
      return { work: null };
    }

    // Pick the cheapest backend whose required lease is currently free.
    let chosen: VisualBackend | null = null;
    let lease: LeaseHandle | null = null;
    for (const backend of usable) {
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
        chain: usable.map((b) => b.id),
      });
      return { work: null };
    }

    // Transition leased→running SYNCHRONOUSLY (the lease is already held), then
    // detach the capture work so the drain loop proceeds to the next row at once.
    this.markLeased(row.id, chosen.id);
    this.markRunning(row.id, chosen.id);
    return { work: this.runChosen(row, type, input, chosen, lease) };
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
   * The DETACHED capture work for a row whose lease is already held + status is
   * already 'running' (processRow did both synchronously). Runs capture → judge →
   * terminal verdict, releasing the lease in finally. A capture that fails (ok:false
   * or no PNG) is recorded as 'failed' for THIS slice (full fall-forward to the next
   * rung is L2+); a judge verdict drives passed/failed/low_confidence. The
   * per-request abort signal is plumbed to backend + judge for timeout / cancel.
   *
   * Because the lease is held until this promise's finally, two SCREEN-lease rows
   * cannot run concurrently (the second couldn't acquire the lease in processRow),
   * while two NULL-lease rows both reach here and run in parallel.
   */
  private async runChosen(
    row: VerificationRequestRow,
    type: VerificationType,
    input: VerificationRequestInput,
    backend: VisualBackend,
    lease: LeaseHandle,
  ): Promise<void> {
    const controller = new AbortController();
    // Register the controller so cancelForRun(runId) + the per-request timeout can
    // reach in and `.abort()` THIS live capture/judge. Deleted in the finally.
    this.inFlight.set(row.id, controller);

    // Per-request deadline: on expiry abort the in-flight signal. The catch below
    // (or the abort-aware capture/judge) then unwinds; `timedOut` distinguishes a
    // deadline abort (→ 'timeout') from a genuine capture/judge throw (→ 'failed').
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.logger?.warn('[VerificationScheduler] request timed out — aborting', {
        requestId: row.id,
        backend: backend.id,
        timeoutMs: this.requestTimeoutMs,
      });
      controller.abort();
    }, this.requestTimeoutMs);
    // Do not let the timer keep the event loop / process alive on its own.
    if (typeof deadline === 'object' && deadline !== null && 'unref' in deadline) {
      (deadline as { unref: () => void }).unref();
    }

    let fileNames: string[] = [];
    // The scheduler-owned dev server (S2) for this request, if one is spawned. Held
    // for the WHOLE capture lifetime and released in the SAME finally as the lease.
    let devServerHandle: DevServerHandle | null = null;
    // The batch worktree-sync mutex (L4) for a batched run, if this run carries a
    // batch_id. Held across capture+judge and released in the SAME finally as the
    // other leases. Null for a non-batch run (nothing acquired → nothing to release).
    let batchLease: LeaseHandle | null = null;

    try {
      // S2 — stand a dev server up on the leased port when the deliverable recipe
      // has a `start` command. BEFORE building CaptureContext so the spawned baseUrl
      // can be threaded into ctx.input.url. A null handle (no provider / no start /
      // lease is not a port lease) leaves the static url/htmlPath capture unchanged.
      devServerHandle = await this.maybeSpawnDevServer(row, input, lease, controller.signal);
      // A timeout/cancel that fired DURING dev-server spawn: stop here, mark
      // 'timeout', releasing both the dev server (in finally) and the lease.
      if (controller.signal.aborted) {
        this.markTerminal(row.id, 'timeout', {
          backend: backend.id,
          error: timedOut ? 'request timed out' : 'aborted',
        });
        await this.deliver(row, 'timeout', undefined, [], input);
        return;
      }

      // L4 batch worktree-sync mutex (locked decision #5): AFTER the dev-server/
      // port lease, BEFORE capture. For a batched run this BLOCKS until any other
      // verification on the same batchId releases, so a capture never reads a
      // half-committed shared sprint worktree relative to a concurrent lane's
      // verification. A non-batch run acquires nothing (byte-identical to before).
      batchLease = await this.acquireBatchMutex(row.run_id);
      // A timeout/cancel that fired WHILE we waited on the batch mutex: stop here,
      // mark 'timeout'; the batch mutex (now held) is released in finally.
      if (controller.signal.aborted) {
        this.markTerminal(row.id, 'timeout', {
          backend: backend.id,
          error: timedOut ? 'request timed out' : 'aborted',
        });
        await this.deliver(row, 'timeout', undefined, [], input);
        return;
      }

      const captureInput: VerificationRequestInput = devServerHandle
        ? { ...input, url: devServerHandle.baseUrl }
        : input;
      const ctx: CaptureContext = {
        requestId: row.id,
        runId: row.run_id,
        artifactsDir: this.artifactsDirResolver(row.run_id),
        type,
        input: captureInput,
      };

      const capture = await backend.capture(ctx, controller.signal);
      // A timeout/cancel that fired DURING capture: stop here, mark 'timeout',
      // regardless of what the (now-aborted) capture nominally returned.
      if (controller.signal.aborted) {
        this.markTerminal(row.id, 'timeout', {
          backend: backend.id,
          error: timedOut ? 'request timed out' : 'aborted',
        });
        await this.deliver(row, 'timeout', undefined, [], input);
        return;
      }
      if (!capture.ok || capture.fileNames.length === 0) {
        this.markTerminal(row.id, 'failed', {
          backend: backend.id,
          error: capture.error ?? 'capture produced no images',
        });
        await this.deliver(row, 'failed', undefined, [], input);
        return;
      }

      fileNames = capture.fileNames;

      // DETERMINISTIC-FIRST ORDER (decision #3, composing with S3 + S5):
      //
      //  (1) BACKEND DETERMINISTIC VERDICT — a backend that reached a verdict WITHOUT
      //      a vision call (the Rung-1 Playwright backend's a11y/assertion gate) sets
      //      captureResult.deterministicVerdict. When present, USE it and SKIP the
      //      rest. A null verdict is treated as absent (no deterministic signal). The
      //      skip is conservative by construction: a deterministic PASS only on
      //      all-pass explicit assertions, a deterministic FAIL always unambiguous.
      //
      //  (2) SSIM PRE-DIFF (S5) — if no backend verdict AND the request's baselineKey
      //      resolves to an accepted baseline PNG, compare the captured PNG(s) before
      //      spending a vision call. A near-pixel match (>= baselineMatchThreshold) is
      //      a CHEAP deterministic PASS (verdictSource:'ssim_match', NO VLM call).
      //      Otherwise fall through to the VLM with the resolved baselinePath.
      //
      //  (3) BUDGET / VLM — if no deterministic + no SSIM match, run the VLM, passing
      //      the resolved baselinePath. The per-project judge-call budget is enforced
      //      HERE (before the call): exhausted ⇒ a non-blocking low_confidence verdict
      //      (the SAME human-review finding path, never a FAIL / fabricated pass) with
      //      NO vision call. A real VLM call increments this request's judge_calls_used
      //      (the budget aggregation + cost-telemetry counter).
      //
      // The baseline PNGs are resolved ONCE per request here (from input.baselineKey).
      let verdict: VerdictV1;
      if (capture.deterministicVerdict != null) {
        verdict = capture.deterministicVerdict;
      } else {
        const preDiff = await this.resolveBaselinePreDiff(row, input, ctx, fileNames);
        if (controller.signal.aborted) {
          this.markTerminal(row.id, 'timeout', {
            backend: backend.id,
            error: timedOut ? 'request timed out' : 'aborted',
          });
          await this.deliver(row, 'timeout', undefined, fileNames, input);
          return;
        }
        if (preDiff?.match) {
          // SSIM short-circuit: a cheap deterministic PASS, NO vision call.
          verdict = {
            status: 'pass',
            confidence: 1,
            issues: [],
            feedback: `matched golden baseline (SSIM ${preDiff.ssimScore.toFixed(4)} ≥ ${this.baselineMatchThreshold})`,
            judgedFileNames: fileNames,
            baselineUsed: true,
            model: 'ssim-prediff',
            verdictSource: 'ssim_match',
            ssimScore: preDiff.ssimScore,
          };
        } else if (this.isProjectBudgetExhausted(row.project_id)) {
          // BUDGET-EXHAUSTION: route to the SAME non-blocking low_confidence finding
          // path — never a FAIL, never a fabricated pass, and NO vision call spent.
          verdict = {
            status: 'low_confidence',
            confidence: 0,
            issues: [],
            feedback: 'per-project visual-judge budget exhausted; needs human visual review',
            judgedFileNames: fileNames,
            baselineUsed: !!preDiff?.baselinePath,
            model: 'budget-exhausted',
            verdictSource: 'vlm_verdict',
          };
        } else {
          // A real vision call: count it against the budget BEFORE judging (the
          // counter UPDATE is this request's OWN row — consistent with markTerminal,
          // within the no-direct-router-table-write rule).
          this.incrementJudgeCallsUsed(row.id);
          const vlmVerdict = await this.judge.judge(
            {
              intent: input.intent,
              artifactsDir: ctx.artifactsDir,
              fileNames,
              type,
              ...(preDiff?.baselinePath ? { baselinePath: preDiff.baselinePath } : {}),
            },
            controller.signal,
          );
          // Stamp provenance: a VLM-produced verdict is 'vlm_verdict' (+ the SSIM
          // score when a baseline was compared but did not match, for telemetry).
          verdict = {
            ...vlmVerdict,
            verdictSource: 'vlm_verdict',
            ...(preDiff ? { ssimScore: preDiff.ssimScore } : {}),
          };
        }
      }

      // A timeout/cancel that fired DURING judging: mark 'timeout', drop the verdict.
      if (controller.signal.aborted) {
        this.markTerminal(row.id, 'timeout', {
          backend: backend.id,
          error: timedOut ? 'request timed out' : 'aborted',
        });
        await this.deliver(row, 'timeout', undefined, fileNames, input);
        return;
      }

      const status = this.statusFromVerdict(verdict);
      this.markTerminal(row.id, status, { backend: backend.id, verdict });
      await this.deliver(row, status, verdict, fileNames, input);
    } catch (err) {
      // An abort-aware backend/judge that THROWS on abort (vs. returning) lands
      // here. If the signal was aborted (deadline or cancel) it is a 'timeout', not
      // a 'failed' — a genuine capture/judge error keeps 'failed'.
      const aborted = controller.signal.aborted;
      controller.abort();
      const message = err instanceof Error ? err.message : String(err);
      const status: RequestStatus = aborted ? 'timeout' : 'failed';
      this.markTerminal(row.id, status, {
        backend: backend.id,
        error: aborted ? (timedOut ? 'request timed out' : 'aborted') : message,
      });
      this.logger?.error('[VerificationScheduler] capture/judge error', {
        requestId: row.id,
        backend: backend.id,
        aborted,
        error: message,
      });
      await this.deliver(row, status, undefined, fileNames, input);
    } finally {
      clearTimeout(deadline);
      this.inFlight.delete(row.id);
      // Tear the dev server down BEFORE releasing the port lease — release() kills
      // the process tree that was holding the leased port. Guard on null (no dev
      // server was spawned). Fail-soft: a teardown error must never leave the lease
      // un-released, so it is logged, not propagated.
      if (devServerHandle) {
        try {
          await devServerHandle.release();
        } catch (err) {
          this.logger?.error('[VerificationScheduler] dev-server teardown threw', {
            requestId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Release the L4 batch worktree-sync mutex (independent named mutex — reverse
      // order vs. the port lease is not required). Guarded on null: a non-batch run
      // acquired nothing, so there is nothing to release.
      if (batchLease) {
        batchLease.release();
      }
      lease.release();
    }
  }

  /**
   * Stand a scheduler-owned dev server up for this request when its resolved
   * deliverable recipe has a `start` command (S2 / locked decision #1). Returns the
   * live DevServerHandle (the caller threads handle.baseUrl into ctx.input.url and
   * release()s it in finally), or null when no dev server is spawned:
   *   - no provider / no context resolver injected (static-capture deployment), OR
   *   - the held lease is NOT a port lease (rung 0 / null lease — nothing to run on), OR
   *   - no verify.json / no matching deliverable / no `start` command, OR
   *   - the worktree cwd could not be resolved.
   * In every null case the static url/htmlPath capture path is preserved unchanged.
   *
   * A spawn FAILURE (build/start/readiness reject) propagates so runChosen marks the
   * request failed/timeout (the provider has already torn down what it spawned).
   */
  private async maybeSpawnDevServer(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    lease: LeaseHandle,
    signal: AbortSignal,
  ): Promise<DevServerHandle | null> {
    if (!this.devServerProvider || !this.devServerContextResolver) {
      return null;
    }
    // A dev server is bound to a leased PORT. A rung-0 / null lease (no port) cannot
    // host one — the request is a static url/htmlPath capture.
    const port = this.portFromLease(lease.name);
    if (port === null) {
      return null;
    }

    const resolved = await this.devServerContextResolver({
      runId: row.run_id,
      projectId: row.project_id,
      input,
    });
    if (!resolved) {
      return null;
    }
    const { cwd, deliverable } = resolved;
    if (!deliverable.start || deliverable.start.trim().length === 0) {
      // No start command — nothing to stand up; capture the static target as-is.
      return null;
    }

    this.logger?.debug('[VerificationScheduler] spawning dev server', {
      requestId: row.id,
      port,
      deliverable: deliverable.id,
    });
    return this.devServerProvider.spawn({ config: deliverable, port, cwd, signal });
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
   * S5 — resolve + run the golden-baseline SSIM pre-diff for a request, or null when
   * there is nothing to compare (no resolver injected / no baselineKey / no accepted
   * baseline for any captured viewport). Fail-soft: a resolver throw degrades to null
   * (run the VLM with no baseline) rather than wedging the drain. The `match` flag is
   * re-derived against THIS scheduler's threshold so the gate is owned here even if a
   * resolver reports its own.
   */
  private async resolveBaselinePreDiff(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    ctx: CaptureContext,
    fileNames: string[],
  ): Promise<BaselinePreDiffResult | null> {
    if (!this.baselinePreDiff) return null;
    if (!input.baselineKey || input.baselineKey.trim().length === 0) return null;
    try {
      const result = await this.baselinePreDiff({
        projectId: row.project_id,
        runId: row.run_id,
        input,
        artifactsDir: ctx.artifactsDir,
        fileNames,
      });
      if (!result) return null;
      // Own the gate: re-derive `match` against this scheduler's threshold.
      return { ...result, match: result.ssimScore >= this.baselineMatchThreshold };
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] baseline pre-diff failed; running VLM', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * S5 — has this project reached its per-project judge-call budget cap? Reads
   * projects.visual_verify_budget_calls (NULL = unlimited) + the cumulative
   * SUM(verification_requests.judge_calls_used) for the project via the injected
   * DatabaseLike. Returns true only when a budget is set AND the cumulative used
   * count is at/above it. Fail-soft: a thrown query (missing column / minimal test
   * DB) degrades to "not exhausted" so a budget-less deployment is byte-identical to
   * before this layer (the per-run cap still applies upstream at the capped judge).
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

  /**
   * Map a judge VerdictV1 to a terminal request status, applying the confidence
   * floor: a 'pass'/'fail' below vlmConfidenceThreshold is demoted to
   * 'low_confidence' (a human review_item, never an auto-loop / fabricated verdict).
   */
  private statusFromVerdict(verdict: VerdictV1): RequestStatus {
    if (verdict.status === 'low_confidence') return 'low_confidence';
    if (verdict.confidence < this.config.vlmConfidenceThreshold) return 'low_confidence';
    return verdict.status === 'pass' ? 'passed' : 'failed';
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

  /** queued → leased (records the chosen backend + leased_at). */
  private markLeased(id: string, backend: VisualBackendId): void {
    this.db
      .prepare(
        `UPDATE verification_requests
            SET status = 'leased', current_backend = ?, leased_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .run(backend, new Date().toISOString(), id);
  }

  /** leased → running. */
  private markRunning(id: string, backend: VisualBackendId): void {
    this.db
      .prepare(
        `UPDATE verification_requests
            SET status = 'running', current_backend = ?
          WHERE id = ? AND status = 'leased'`,
      )
      .run(backend, id);
  }

  /**
   * Write a terminal status (passed/failed/low_confidence/skipped/timeout) +
   * verdict_json / error_message / ended_at. attempt is bumped so a re-judged
   * request reflects its fall-forward count.
   */
  private markTerminal(
    id: string,
    status: RequestStatus,
    extra: { backend?: VisualBackendId; verdict?: VerdictV1; error?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE verification_requests
            SET status = ?,
                current_backend = COALESCE(?, current_backend),
                verdict_json = ?,
                error_message = ?,
                attempt = attempt + 1,
                ended_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        extra.backend ?? null,
        extra.verdict ? JSON.stringify(extra.verdict) : null,
        extra.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  // --------------------------------------------------------------------------
  // Verdict delivery (stubbed hook — P8 wires the real routers)
  // --------------------------------------------------------------------------

  /**
   * Fire the injected onVerdict hook (if any). For THIS slice the real
   * side-effects (ArtifactRouter enrich + ReviewItemRouter finding +
   * SprintLaneStore advance/loopback) are stubbed behind this callback; P8 wires
   * the concrete one. Fail-soft: a throwing hook is logged, never propagated (it
   * must not wedge the drain loop or leave the lease unreleased — release already
   * ran in runChosen's finally before deliver here is reached for the judged path,
   * and the skip/parse paths hold no lease).
   */
  private async deliver(
    row: VerificationRequestRow,
    status: RequestStatus,
    verdict: VerdictV1 | undefined,
    fileNames: string[],
    input?: VerificationRequestInput,
  ): Promise<void> {
    if (this.onVerdict) {
      try {
        await this.onVerdict({
          requestId: row.id,
          runId: row.run_id,
          projectId: row.project_id,
          type: row.verify_type as VerificationType,
          status,
          verdict,
          fileNames,
          input,
        });
      } catch (err) {
        this.logger?.error('[VerificationScheduler] onVerdict hook threw', {
          requestId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fire the terminal event LAST — after onVerdict (so any merge-gate lane write
    // is already visible) and REGARDLESS of whether a hook is wired. This is the
    // wake signal the programmatic visual merge-gate awaits to un-park a lane. It
    // fires for EVERY terminal status (incl. skipped/timeout, which the merge-gate
    // does not lane-write) so a parked programmatic lane can never hang. Fail-soft:
    // a throwing listener must never wedge the drain loop.
    try {
      const event: VerificationTerminalEvent = {
        runId: row.run_id,
        requestId: row.id,
        projectId: row.project_id,
        status,
        type: row.verify_type as VerificationType,
        ...(input?.taskRef ? { taskRef: input.taskRef } : {}),
      };
      verificationEvents.emit(verificationChannel(row.run_id), event);
    } catch (err) {
      this.logger?.error('[VerificationScheduler] terminal event emit threw', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Parsing helpers
  // --------------------------------------------------------------------------

  /** Parse deliverable_json into a VerificationRequestInput; null on malformed JSON / shape. */
  private parseInput(json: string): VerificationRequestInput | null {
    try {
      const parsed: unknown = JSON.parse(json);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { intent?: unknown }).intent === 'string'
      ) {
        return parsed as VerificationRequestInput;
      }
      return null;
    } catch {
      return null;
    }
  }

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
