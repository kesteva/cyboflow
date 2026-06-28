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
import { VISUAL_VERIFY_DEFAULTS } from '../../../../shared/types/visualVerification';

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
   * simulator. The exact name the backend returned is included so a backend that
   * names a specific port still contends within the pool.
   */
  private poolCandidatesFor(required: string): readonly string[] | null {
    if (required.startsWith('verify:port:')) {
      const fromPool = this.config.devServerPorts.map(verifyPortLease);
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
      const verdict = await this.judge.judge(
        {
          intent: input.intent,
          artifactsDir: ctx.artifactsDir,
          fileNames,
          type,
          baselinePath: undefined,
        },
        controller.signal,
      );

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
