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
import { emitSeamError } from '../telemetrySink';
import { classifyErrorPattern } from '../programmatic/systemicError';
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
// status uniformly — including skipped/timeout (which the merge-gate ADVANCES per
// R4, and a non-sprint run leaves as a lane-less no-op). Mirrors
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
// Abort-bounded await (R1 #1a — the scheduler must NEVER hang on a collaborator
// that ignores its abort signal)
//
// The per-request deadline `.abort()`s the shared controller, but a backend/judge
// that does not honour the signal (e.g. an offscreen renderer wedged on a GPU
// stall) may never settle its capture promise. Awaiting that promise raw would
// hang runChosen forever → drain()'s Promise.allSettled never resolves → `draining`
// stays true → every future request across all runs strands 'queued'. raceWithAbort
// closes that hole at the SCHEDULER: it rejects with a distinguishable AbortRaceError
// THE MOMENT the signal aborts, even if the underlying promise never settles. The
// orphaned promise is intentionally DETACHED (its eventual settle/reject is logged,
// not awaited). The backend-side cleanup (CapturePageBackend destroys its window on
// abort) is the complementary fix that prevents a leaked wedged window; this race is
// the hard guarantee that the loop itself can never wedge.
// ---------------------------------------------------------------------------

/**
 * The distinguishable rejection raceWithAbort throws when the signal aborts before
 * the raced promise settles. runChosen's catch keys timeout-vs-failed off
 * `signal.aborted` (not this identity), but the named class keeps the abort path
 * greppable in logs + assertable in tests.
 */
export class AbortRaceError extends Error {
  constructor(label: string) {
    super(`aborted while awaiting ${label}`);
    this.name = 'AbortRaceError';
  }
}

/**
 * Await `promise`, but reject with an AbortRaceError the instant `signal` aborts —
 * even if `promise` never settles (an abort-unaware collaborator). When the abort
 * wins, the underlying promise is DETACHED: its later settle/reject is logged at
 * debug (so a leaked orphan is observable) and dropped. When the promise wins, its
 * value/error propagates and the abort listener is removed. Orchestrator-local (no
 * electron/service import) so the scheduler stays standalone-typecheck-clean.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  label: string,
  logger?: LoggerLike,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new AbortRaceError(label));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new AbortRaceError(label));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          logger?.debug('[VerificationScheduler] detached work settled after abort', { label });
          return;
        }
        settled = true;
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          logger?.debug('[VerificationScheduler] detached work rejected after abort', {
            label,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
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
 * How long a backend's `healthCheck()` result is memoized (R2 #2). The health probe
 * is the SECOND selection gate (after registry presence): an unregistered OR
 * unhealthy backend is treated identically (dropped from the candidate chain). To
 * avoid re-probing every backend on every drain — a peekaboo TCC probe or a chromium
 * install check is not free — the scheduler caches each backend's result for this
 * TTL, keyed by backend id. A later-granted TCC / freshly-installed chromium is
 * picked up once the TTL expires and the next drain re-probes. Exported so the
 * regression test can drive the memo boundary with an injected clock.
 */
export const HEALTH_CHECK_MEMO_TTL_MS = 60 * 1000;

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
  /**
   * Injectable monotonic clock (ms) for the healthCheck memo TTL (R2 #2). Defaults
   * to `Date.now`. Tests pass a controllable clock to exercise the memo boundary
   * (two drains within the TTL probe once; after expiry the next drain re-probes)
   * without a real 60s wait.
   */
  now?: () => number;
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
  private readonly now: () => number;

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
    this.now = deps.now ?? (() => Date.now());
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
    const rows = this.db
      .prepare(
        `SELECT id, run_id, project_id, status, verify_type, deliverable_json,
                chain_json, current_backend, attempt
           FROM verification_requests
          WHERE status IN ('leased', 'running')
          ORDER BY enqueued_at ASC, id ASC`,
      )
      .all() as VerificationRequestRow[];
    let recovered = 0;
    for (const row of rows) {
      // Parse the input so the delivery can attribute the lane (deliverable_json →
      // taskRef); an unparseable row still recovers to 'timeout' with no attribution.
      const input = this.parseInput(row.deliverable_json) ?? undefined;
      await this.markTerminalAndDeliver(
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
    return recovered;
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
    const parsed = this.parseInput(row.deliverable_json);
    if (!parsed) {
      await this.markTerminalAndDeliver(
        row,
        'skipped',
        { error: 'unparseable deliverable_json' },
        undefined,
        [],
      );
      return { work: null };
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
      await this.markTerminalAndDeliver(
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
    return { work: this.runChosen(row, type, input, chosen, lease, resolved) };
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
    resolvedContext: { cwd: string; deliverable: DeliverableVerifyConfig } | null,
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
      devServerHandle = await this.maybeSpawnDevServer(row, lease, resolvedContext, controller.signal);
      // A timeout/cancel that fired DURING dev-server spawn: stop here, mark
      // 'timeout', releasing both the dev server (in finally) and the lease.
      if (controller.signal.aborted) {
        await this.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted' },
          undefined,
          [],
          input,
        );
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
        await this.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted' },
          undefined,
          [],
          input,
        );
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

      // ABORT-BOUNDED (R1 #1a): race the capture against the deadline/cancel signal
      // so an abort-unaware backend that never settles can NEVER hang the drain. On
      // abort raceWithAbort rejects (→ catch, marked 'timeout'); the orphaned capture
      // is detached (its late settle is logged). The backend-side window teardown
      // (CapturePageBackend) prevents the leaked wedged renderer.
      const capture = await raceWithAbort(
        backend.capture(ctx, controller.signal),
        controller.signal,
        'capture',
        this.logger,
      );
      // A timeout/cancel that fired DURING capture: stop here, mark 'timeout',
      // regardless of what the (now-aborted) capture nominally returned.
      if (controller.signal.aborted) {
        await this.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted' },
          undefined,
          [],
          input,
        );
        return;
      }
      if (!capture.ok || capture.fileNames.length === 0) {
        await this.markTerminalAndDeliver(
          row,
          'failed',
          { backend: backend.id, error: capture.error ?? 'capture produced no images' },
          undefined,
          [],
          input,
        );
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
          await this.markTerminalAndDeliver(
            row,
            'timeout',
            { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted' },
            undefined,
            fileNames,
            input,
          );
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
          // ABORT-BOUNDED (R1 #1a): a hung vision call can no more wedge the drain
          // than a hung capture — race it against the deadline/cancel signal.
          const vlmVerdict = await raceWithAbort(
            this.judge.judge(
              {
                intent: input.intent,
                artifactsDir: ctx.artifactsDir,
                fileNames,
                type,
                ...(preDiff?.baselinePath ? { baselinePath: preDiff.baselinePath } : {}),
              },
              controller.signal,
            ),
            controller.signal,
            'judge',
            this.logger,
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
        await this.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted' },
          undefined,
          fileNames,
          input,
        );
        return;
      }

      const status = this.statusFromVerdict(verdict);
      await this.markTerminalAndDeliver(
        row,
        status,
        { backend: backend.id, verdict },
        verdict,
        fileNames,
        input,
      );
    } catch (err) {
      // An abort-aware backend/judge that THROWS on abort (vs. returning) lands
      // here. If the signal was aborted (deadline or cancel) it is a 'timeout', not
      // a 'failed' — a genuine capture/judge error keeps 'failed'.
      const aborted = controller.signal.aborted;
      controller.abort();
      const message = err instanceof Error ? err.message : String(err);
      const status: RequestStatus = aborted ? 'timeout' : 'failed';
      this.logger?.error('[VerificationScheduler] capture/judge error', {
        requestId: row.id,
        backend: backend.id,
        aborted,
        error: message,
      });
      await this.markTerminalAndDeliver(
        row,
        status,
        { backend: backend.id, error: aborted ? (timedOut ? 'request timed out' : 'aborted') : message },
        undefined,
        fileNames,
        input,
      );
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
   *   - no provider injected (static-capture deployment), OR
   *   - the held lease is NOT a port lease (rung 0 / null lease — nothing to run on), OR
   *   - no verify.json / no matching deliverable / no `start` command, OR
   *   - the worktree cwd could not be resolved.
   * In every null case the static url/htmlPath capture path is preserved unchanged.
   *
   * S8 — the verify.json deliverable was already resolved ONCE in processRow (used to
   * hydrate `input` BEFORE lease selection) and is THREADED in here as
   * `resolvedContext`, so verify.json is loaded a single time per request (no second
   * devServerContextResolver call). A null resolvedContext is the same fail-soft
   * "no dev server" path as before.
   *
   * A spawn FAILURE (build/start/readiness reject) propagates so runChosen marks the
   * request failed/timeout (the provider has already torn down what it spawned).
   */
  private async maybeSpawnDevServer(
    row: VerificationRequestRow,
    lease: LeaseHandle,
    resolvedContext: { cwd: string; deliverable: DeliverableVerifyConfig } | null,
    signal: AbortSignal,
  ): Promise<DevServerHandle | null> {
    if (!this.devServerProvider) {
      return null;
    }
    // A dev server is bound to a leased PORT. A rung-0 / null lease (no port) cannot
    // host one — the request is a static url/htmlPath capture.
    const port = this.portFromLease(lease.name);
    if (port === null) {
      return null;
    }

    if (!resolvedContext) {
      return null;
    }
    const { cwd, deliverable } = resolvedContext;
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

  /**
   * Write a terminal status (passed/failed/low_confidence/skipped/timeout) +
   * verdict_json / error_message / ended_at. attempt is bumped so a re-judged
   * request reflects its fall-forward count.
   *
   * CANCEL-SAFE (R1 #3b): the write is guarded to a NON-TERMINAL current status
   * (`status IN ('queued','leased','running')`). If a cancelForRun / timeout sweep
   * already made the row terminal (e.g. 'timeout') it WON the race — the guard
   * changes 0 rows so we do NOT clobber the canceled status. Returns the .changes so
   * markTerminalAndDeliver can suppress delivery when the write lost the race.
   * (The non-terminal set — a superset of the leased/running the running path sees —
   * is required because this same writer performs the queued→skipped transition for
   * the processRow skip paths, which must still succeed on a live 'queued' row.)
   */
  private markTerminal(
    id: string,
    status: RequestStatus,
    extra: { backend?: VisualBackendId; verdict?: VerdictV1; error?: string } = {},
  ): number {
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = ?,
                current_backend = COALESCE(?, current_backend),
                verdict_json = ?,
                error_message = ?,
                attempt = attempt + 1,
                ended_at = ?
          WHERE id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .run(
        status,
        extra.backend ?? null,
        extra.verdict ? JSON.stringify(extra.verdict) : null,
        extra.error ?? null,
        new Date().toISOString(),
        id,
      ).changes;
  }

  /**
   * Write a terminal status AND fire verdict delivery — but ONLY when the
   * status-guarded markTerminal actually transitioned the row (changes === 1). A
   * 0-change write means a cancel/timeout sweep already made the row terminal and
   * WON the race: we must NOT overwrite it and must NOT deliver — no artifact
   * enrich, no ReviewItemRouter finding, no SprintLaneStore merge-gate write, no
   * terminal event — for a canceled run (R1 #3b). This is the SINGLE chokepoint
   * pairing the guarded write with delivery so every runChosen / skip exit is
   * cancel-safe by construction.
   */
  private async markTerminalAndDeliver(
    row: VerificationRequestRow,
    status: RequestStatus,
    extra: { backend?: VisualBackendId; verdict?: VerdictV1; error?: string },
    verdict: VerdictV1 | undefined,
    fileNames: string[],
    input?: VerificationRequestInput,
  ): Promise<void> {
    const changes = this.markTerminal(row.id, status, extra);
    if (changes === 0) {
      this.logger?.debug('[VerificationScheduler] terminal write lost race to cancel/timeout; skipping delivery', {
        requestId: row.id,
        attemptedStatus: status,
      });
      return;
    }
    // Report a verification that ended in a FAILURE-ish terminal state (failed /
    // timed out / skipped-because-unable) — a passed / low_confidence verdict is
    // not an error. Only after the guarded write won (changes === 1) so a
    // cancel-race never double-reports. errorClass buckets the cause.
    if (status === 'failed' || status === 'timeout' || status === 'skipped') {
      emitSeamError('verify-request-failed', new Error((extra.error ?? status).slice(0, 500)), {
        requestStatus: status,
        verifyType: row.verify_type,
        ...(extra.backend ? { backend: extra.backend } : {}),
        errorClass: classifyErrorPattern(extra.error),
      });
    }
    await this.deliver(row, status, verdict, fileNames, input);
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
    // fires for EVERY terminal status (incl. skipped/timeout — which the merge-gate
    // now ADVANCES per R4) so a parked programmatic lane can never hang. Fail-soft:
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
