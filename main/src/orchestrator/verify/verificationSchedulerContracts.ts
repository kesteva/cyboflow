/**
 * VerificationScheduler's public CONTRACTS — the terminal-event emitter, the
 * dev/static-server and baseline pre-diff provider seams, the onVerdict hook, the
 * timing/threshold constants, and the `VerificationSchedulerDeps` bag
 * `VerificationScheduler.initialize` takes. Extracted verbatim from
 * verificationScheduler.ts (issue #19 step 5); that file re-exports everything
 * here, so existing importers are unchanged.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron', 'fs',
 * 'better-sqlite3', or concrete main/src/services import — shared types and
 * primitives only.
 */
import { EventEmitter } from 'node:events';
import type { DatabaseLike, LoggerLike } from '../types';
import type {
  CaptureOrigin,
  DeliverableVerifyConfig,
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerdictV1,
  VerificationBackendRegistry,
  VerificationFailureClass,
  VerificationFailureEvidence,
  VerificationModality,
  VerificationReportV1,
  VerificationRequestInput,
  VerificationType,
  VisualBackendId,
  VlmJudge,
} from '../../../../shared/types/visualVerification';
import type { VerificationAgentRunnerLike } from './verificationAgentRunner';
import type { AgentPreflightResult } from './preflight';
import type { VerifyCapabilityStore } from './capabilityStore';
import type { VerifyRunbookStatusDetail, VerifyRunbookStore } from './runbookStore';
import type { BootstrapRunOutcome, RunbookBootstrapArgs } from './runbookBootstrapRunner';
import type { VerifyRunbookModalityEntry } from '../../../../shared/types/verifyRunbook';
import { ResourceLeasePool } from './verificationLeases';

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
// Static-server provider seam (S9 — scheduler-owned static file server)
//
// The zero-config `htmlPath` promise: a request that points at a BUILT html file
// (no dev server, no verify.json `start`) must still render correctly. Loading it
// over `file://` (the pre-S9 CapturePage path) silently blanks any bundler output —
// Chromium treats file:// as an opaque origin and CORS-blocks every
// `<script type="module">`. S9 fixes the class: the scheduler stands the file's
// static root up on an ephemeral loopback HTTP server and threads the resulting
// URL into capture, exactly like the S2 dev server (URL threading is the
// scheduler's job; the backend stays stateless). The OS assigns the port
// (127.0.0.1:0) so NO `verify:port` lease is needed — that pool exists to
// interpolate `${PORT}` into user start commands; an OS-assigned port never
// collides — keeping rung-0 captures fully parallel. The concrete server (a
// service, node:http) is injected at index.ts; the scheduler imports only these
// TYPES (standalone-typecheck invariant), mirroring DevServerProvider.
// ---------------------------------------------------------------------------

/** The args the scheduler passes the provider to stand a static deliverable up. */
export interface StaticServerSpawnArgs {
  /** Absolute path of the html entry file (already worktree-resolved + verified). */
  absoluteHtmlPath: string;
  /**
   * Absolute directory the server confines itself to. Defaults upstream to
   * dirname(absoluteHtmlPath); a verify.json deliverable may widen it via its
   * explicit `staticRoot` for layouts whose assets live above the html's dir.
   */
  staticRoot: string;
  /** Per-request abort — interrupts an in-flight listen/spawn cleanly. */
  signal: AbortSignal;
}

/**
 * A live static server the scheduler must tear down after capture. `baseUrl` is
 * the full tokenized URL OF THE HTML ENTRY (not the bare origin) — the scheduler
 * rewrites it into ctx.input.url verbatim. `release()` closes the listener and
 * force-destroys open sockets; the scheduler calls it exactly once, in the SAME
 * finally that releases the S2 dev server.
 */
export interface StaticServerHandle {
  baseUrl: string;
  release(): Promise<void>;
}

/**
 * The narrow static-server spawner interface injected into the scheduler. `spawn`
 * binds 127.0.0.1:0 and resolves once listening; it rejects (after closing
 * whatever it opened) on bind failure or abort. The concrete StaticServerManager
 * (a service) implements it and is wired in at index.ts.
 */
export interface StaticServerProvider {
  spawn(args: StaticServerSpawnArgs): Promise<StaticServerHandle>;
}

/**
 * Resolves a request's static-serve context: the ABSOLUTE html path (a relative
 * request htmlPath resolves against the run's WORKTREE first, project root on
 * fallback — never the Electron process cwd) + the confining static root
 * (explicit verify.json `staticRoot` when the matched deliverable declares one,
 * else dirname(html)). INJECTED as a plain async function (wired at index.ts over
 * the DB path lookup + fs existence checks) so the scheduler stays fs/electron/
 * service-free. Returns null when the html file cannot be resolved/found — the
 * scheduler then skips the static server and the request captures its raw
 * url/htmlPath unchanged (pre-S9 behavior preserved, fail-soft).
 */
export type StaticHtmlContextResolver = (args: {
  runId: string;
  projectId: number;
  /** The request's raw (possibly relative) htmlPath. */
  htmlPath: string;
  /** Explicit static root from the matched verify.json deliverable, if any. */
  staticRoot?: string;
}) => Promise<{ absoluteHtmlPath: string; staticRoot: string } | null>;

/**
 * The `extra` payload runChosen hands markTerminal(AndDeliver) for one terminal
 * write. `backend` / `verdict` / `error` are the load-bearing fields markTerminal
 * persists (+ the seam-error tags). `captureOrigin` (Codex finding 9, type in
 * shared/types/visualVerification.ts) and `diagnostics` (Codex finding 7) are
 * PURELY ADDITIVE human-facing provenance: markTerminal does NOT persist them —
 * markTerminalAndDeliver forwards them through deliver() into the onVerdict hook,
 * whose concrete delivery (verdictDelivery.ts) renders them on the review-item
 * finding body + the screenshots artifact payload. NOTHING derives pass/fail from
 * them (diagnostics are page-controlled text and never reach the VlmJudge).
 */
export interface TerminalExtra {
  backend?: VisualBackendId;
  verdict?: VerdictV1;
  error?: string;
  captureOrigin?: CaptureOrigin;
  diagnostics?: string[];
  /**
   * The verification AGENT's normalized report (redesign §5.4/§5.6). Persisted to
   * `verification_requests.report_json` in the SAME status-guarded terminal write as
   * the status + verdict (markTerminal), so the report commits atomically with the
   * terminal transition. Absent on the legacy capture/judge path (report_json stays
   * NULL there). The delivery-outbox `delivery_state` marker is a later slice — not
   * written here.
   */
  report?: VerificationReportV1;
  /**
   * The §3.1 conservative classifier's verdict for a terminal FAILURE
   * (docs/proposals/verification-setup-flow.md), persisted to migration 095's
   * `failure_class`. Absent on a pass and on every legacy-path terminal (the
   * column stays NULL, exactly as for a pre-095 row).
   */
  failureClass?: VerificationFailureClass;
  /**
   * The harness-derived evidence the {@link TerminalExtra.failureClass} verdict
   * rests on, persisted to `failure_evidence_json`. §3.1's auditable invariant:
   * an `'env'` verdict — the only class that converts a lane-blocking FAIL into
   * an advancing SKIP — must always point at a harness source here, never at
   * model prose, so a misclassification is inspectable after the fact rather
   * than being an unfalsifiable label.
   */
  failureEvidence?: VerificationFailureEvidence[];
  /**
   * The §3.5 pre-deploy preflight result, persisted to `preflight_json`. Written
   * on EVERY agent terminal (not just failures) so the phase-3 health panel can
   * distinguish "the host was fine and the check still failed" from "the host
   * could never have run it".
   */
  preflight?: AgentPreflightResult;
}

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
  /**
   * HUMAN-FACING capture provenance (S9 / Codex finding 9): how the deliverable
   * was stood up for this attempt. Present for every runChosen terminal; the
   * processRow skip paths (no capture attempted) pass undefined.
   */
  captureOrigin?: CaptureOrigin;
  /**
   * UNTRUSTED capture diagnostics (S9 / Codex finding 7): capped page-console
   * lines + capture-side notes (file:// breadcrumb, fold truncation). Page code
   * controls this text — the delivery renders it on human surfaces (review-item
   * finding body / screenshots payload) ONLY; it must never feed a judge or
   * derive pass/fail.
   */
  diagnostics?: string[];
}) => void | boolean | Promise<void | boolean>;
// ^ Return contract (§5.6 amended, adversarial-review fix 2026-07-23): an
// explicit `false` means at least one REQUIRED delivery consumer (artifact
// merge / merge-gate lane write / finding creation) failed — the scheduler
// then leaves the row `delivery_state='pending'` for replay instead of
// stamping 'delivered'. `void`/`true` (and legacy hooks that return nothing)
// count as fully delivered.

/**
 * The default per-request deadline (5 minutes). When a capture+judge attempt runs
 * longer than this the scheduler `signal.abort()`s the in-flight work and marks the
 * row 'timeout' (releasing the lease). Tunable via VerificationSchedulerDeps.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Delivery-retry backoff (§5.6 amended): when a delivery leaves a terminal row
 * `pending` (a required consumer failed), an in-process sweep re-runs
 * replayPendingDeliveries after this base delay, doubling per consecutive failed
 * sweep up to the cap — so recovery from a transient router/DB error does not
 * have to wait for the next boot. Reset to the base once a sweep fully drains.
 */
export const DELIVERY_RETRY_BASE_MS = 60 * 1000;
export const DELIVERY_RETRY_MAX_MS = 15 * 60 * 1000;

/**
 * Default per-request deadline for an AGENT-engine row (redesign §5.4 step 6): 10
 * minutes — an agent deployment builds, serves, drives, and judges, so it needs far
 * longer than a single capture. It is also the FLOOR: since F2 a composed
 * `task.timeoutMs` may only RAISE the deadline (the ceiling below still caps any
 * value) — see {@link VerificationScheduler.agentDeadlineMs}. Applied through the
 * SAME per-request abort/raceWithAbort machinery as the legacy deadline.
 */
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard ceiling on an agent row's deadline — a task-supplied `timeoutMs` can never exceed this. */
export const AGENT_REQUEST_TIMEOUT_CEILING_MS = 20 * 60 * 1000;

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
  /**
   * The LIVE config, re-read per call. `config` above is resolved once at boot,
   * which is right for the judge threshold and the port pools (a run must not
   * change shape underneath itself) and wrong for a user-facing toggle: a switch
   * flipped in Settings is expected to bind the next run, not the next launch.
   * That mattered most in the OFF direction — unchecking "let runs set up
   * verification themselves" mid-incident left the next lane still committing.
   */
  liveConfig?: () => ResolvedVisualVerifyConfig;
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
   * The scheduler-owned static file server (S9). When present AND a request has an
   * htmlPath but no url and no dev-server recipe, the scheduler serves the html's
   * static root on an ephemeral loopback port (no lease — the OS assigns the port),
   * threads the tokenized entry URL into capture, and tears it down after. Absent ⇒
   * the raw htmlPath capture path is unchanged (pre-S9 file:// behavior). The
   * concrete StaticServerManager (a service) is injected at index.ts.
   */
  staticServerProvider?: StaticServerProvider;
  /**
   * Resolves a request's static-serve context (worktree-resolved absolute html path
   * + confining static root). Injected as a plain async function so the scheduler
   * stays fs/electron/service-free — the closure (wired at index.ts) does the DB
   * path lookup + fs work. Absent ⇒ no static server is ever spawned.
   */
  staticHtmlContextResolver?: StaticHtmlContextResolver;
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
  /**
   * The verification-AGENT engine (redesign §5.4). When a run's stamped
   * `verify_chain` is `['agent']`, the scheduler routes its requests to THIS runner
   * (snapshot build → deploy the workflow-defined agent → validate → mutation-check
   * → teardown) instead of the capture-backend + VLM waterfall. Absent ⇒ an
   * agent-stamped row resolves 'skipped' (fail-open) — an old binary / a deployment
   * wired without the runner never wedges. Injected at index.ts; the scheduler
   * imports only the TYPE (standalone-typecheck invariant).
   */
  agentRunner?: VerificationAgentRunnerLike;
  /**
   * Per-request deadline for an agent row (default {@link DEFAULT_AGENT_REQUEST_TIMEOUT_MS},
   * capped by {@link AGENT_REQUEST_TIMEOUT_CEILING_MS}). Tests pass a small value.
   */
  agentRequestTimeoutMs?: number;
  /** Ceiling on an agent row's deadline (default {@link AGENT_REQUEST_TIMEOUT_CEILING_MS}). */
  agentRequestCeilingMs?: number;
  /**
   * Probe whether a leased verification PORT is genuinely free (§5.4 step 6). Used
   * at agent teardown to decide release-vs-quarantine, and re-run by the pool before
   * a later acquisition of a quarantined slot. Returns true when the port is free.
   * Default: always-free (so a deployment without a real net probe releases normally
   * and never quarantines — safe in tests). The real net-connect probe is wired at
   * index.ts. Injected as a plain function so the scheduler stays net/service-free.
   */
  portFreeProbe?: (port: number) => Promise<boolean>;
  /**
   * Enqueue-age ceiling (ms) covering a request's QUEUED + lease-wait time
   * (redesign §5.6). A row whose `enqueued_at` is older than this at drain time —
   * i.e. it never acquired a lease within the window — is terminalized 'skipped'
   * (fail-open, concrete lease reason) through the normal delivery path so a
   * merge-gate lane parked at awaiting-verify is never wedged behind a starved
   * request. Defaults to config.queuedAgeCeilingMs (15 min). Tests pass a small
   * value to exercise the boundary.
   */
  queuedAgeCeilingMs?: number;
  /**
   * §5.8 legacy kill-switch check — whether `CYBOFLOW_VERIFY_LEGACY` is active,
   * read ONCE per `runRecovery()` pass (never inline `process.env`, and never
   * re-read per row) so the boot terminalization below is deterministic within a
   * single pass. INJECTED as a plain function (mirrors `now`/`portFreeProbe`) so
   * tests can flip the posture without mutating global env; defaults to the same
   * `process.env.CYBOFLOW_VERIFY_LEGACY === '1'` check `workflowRegistry.ts` uses
   * to stamp NEW runs onto the legacy chain — this dep is the missing BOOT half of
   * that rollback contract (existing in-flight AGENT-chain rows get terminalized
   * too, not just future runs redirected).
   */
  legacyKillSwitch?: () => boolean;
  /**
   * The §3.3/§3.4 per-(project, modality) capability ledger — the `unsupported`
   * mark and the K-consecutive-env-failure circuit breaker
   * (docs/proposals/verification-setup-flow.md). Consulted BEFORE any lease is
   * acquired (a suppressed modality never deploys) and fed AFTER every terminal
   * (an env-class failure counts toward the breaker; a pass or a
   * deliverable-attributed failure resets it). Absent ⇒ no suppression is ever
   * active and no outcome is recorded — byte-identical to the pre-phase-0
   * behavior, which is what every legacy test and any pre-095 DB gets.
   */
  capabilityStore?: VerifyCapabilityStore;
  /**
   * §3.2 degrade path — whether this (project, modality) has a PROVEN
   * verification runbook. The phase-2 setup flow ("derive → prove → persist")
   * owns the real store; until it lands the default answers `'absent'` for every
   * project, which is the honest answer: no project has ever proven one, because
   * the concept does not exist yet.
   *
   * CONTRACT for the phase-2 replacement: `'proven'` means a runbook was
   * test-executed end-to-end through the real verification path on THIS host;
   * `'unproven-draft'` means one was derived but never proved (treated exactly
   * like `'absent'` by the gate — a merely-written config is precisely what the
   * failed `.cyboflow/verify.json` model already proved insufficient, §1);
   * `'absent'` means none exists.
   *
   * ASYNC (phase 2): the real answer is a CONJUNCTION re-checked on every read —
   * a freshly computed project input-hash must match the stored one, so must the
   * host fingerprint, and IF the probe path carries a portable file at all it
   * must parse and hash to the record's hash (§5.3 "Any component changing
   * demotes"). That last conjunct is conditional since F10: the record, not the
   * file, is what a proof executes, so a tree that simply has not merged the
   * export yet skips it and is judged on the other two — while a file that IS
   * there and disagrees is content drift and still refuses. Two of the three are
   * filesystem work, so the thunk cannot be synchronous without either blocking
   * the drain on IO or answering from a cache that is exactly what drift
   * detection must not rely on.
   *
   * `probePath` is the TREE to check, and the gate passes the REQUESTING RUN's
   * worktree (lane-runbook-bootstrap.md §3). It used to pass nothing, and the
   * thunk probed the project root — while the enqueue-side injection
   * ({@link VerificationScheduler.resolveProvenRunbook}) had always probed the
   * run's worktree. The two therefore described DIFFERENT TREES, and a runbook a
   * run commits to its own branch stayed invisible to the gate until that branch
   * merged: every request in that run kept skipping with a setup CTA even though
   * the tree it would execute in carried a proven runbook. Omitting `probePath`
   * still falls back to the project root, which is what the project-level health
   * badge wants.
   */
  runbookStatus?: (
    projectId: number,
    modality: VerificationModality,
    probePath?: string,
  ) => Promise<VerifyRunbookStatusDetail>;
  /**
   * The machine-local runbook record store (§5.2 seam 1 + §5.3), injected as the
   * concrete class exactly like {@link VerificationSchedulerDeps.capabilityStore}
   * — the scheduler needs three of its verbs and splitting them into three
   * thunks would only obscure that they are all views of ONE record:
   *
   *  - `status` + `getCurrent` back {@link VerificationScheduler.resolveProvenRunbook},
   *    the ENQUEUE-time pinned injection both enqueue entry points call (§5.2
   *    seam 3);
   *  - `markProven` is the ENGINE-ENFORCED proof flip (§5.3): a `setup_proof`
   *    request that actually PASSED through the real verification path is the
   *    only thing that may turn a draft into a proven runbook — deliberately
   *    not something the setup agent can accomplish by asserting it.
   *
   * ABSENT ⇒ no request is ever pinned and no proof is ever recorded, which is
   * byte-identical to the pre-phase-2 behavior (and what every legacy test and
   * any pre-096 DB gets).
   */
  runbookStore?: VerifyRunbookStore;
  /**
   * Files the ONE non-blocking finding the §3.4 circuit breaker raises when it
   * trips. INJECTED rather than imported, for the standalone-typecheck
   * invariant: the concrete implementation is verdictDelivery's
   * `createCapabilityBreakerFinding`, which owns the ReviewItemRouter chokepoint
   * — this module never touches a router. Absent ⇒ the breaker still suppresses,
   * it just does so silently.
   */
  capabilityFinding?: CapabilityBreakerFindingFn;
  /**
   * §4 roster — whether this host can capture the screen at all, the ONE gate
   * that decides whether a `native-screen` request is deployable. The intended
   * (and index.ts-wired) implementation is the retired capture backend's
   * `peekabooBackend.healthCheck()`: binary-on-PATH AND both macOS TCC grants,
   * never-throws, exactly as §4 "Driver additions for native-screen" prescribes
   * ("the retired peekabooBackend.healthCheck() (both-grants probe,
   * never-throws) is reused as the live grant probe").
   *
   * ABSENT ⇒ the phase-0 behavior is preserved verbatim: every `native-screen`
   * request is skipped as unsupported without asking. That default is the honest
   * one — an unprobed host is not evidence of a capable host, and the whole
   * point of §3 is to stop deploying on hope. Answering TRUE lets the request
   * proceed as an OBSERVE-ONLY verification; nothing here makes it drivable
   * (the runner's behavior coercion and the driver's refusal enforce that —
   * §4 fn.²).
   *
   * Injected as a plain thunk (mirrors `portFreeProbe`/`now`) so this module
   * keeps the standalone-typecheck invariant and never imports a service.
   */
  nativeCaptureProbe?: () => Promise<boolean>;
  /**
   * The ACTING half of the lane runbook bootstrap
   * (docs/proposals/lane-runbook-bootstrap.md §12 steps 3–8): derive, commit,
   * register, and prove a runbook for a lane whose verification would otherwise
   * be skipped.
   *
   * Injected as one closure rather than as its several collaborators because the
   * scheduler has no business holding a git binary, an SDK query, or a
   * filesystem — index.ts assembles those and hands down a single
   * `(args) => outcome` seam. Absent (every unit test, and any deployment where
   * the toggle can never be on) ⇒ the preflight still computes and logs its
   * decision and nothing acts on it, which is byte-identical to phase 2.
   */
  runbookBootstrap?: (args: RunbookBootstrapArgs) => Promise<BootstrapRunOutcome>;
}

/**
 * §3.2 runbook state for one (project, modality). `'unproven-draft'` is
 * deliberately NOT a pass: the proposal's whole thesis is that a written config
 * nobody proved is what already failed once (§1, the `.cyboflow/verify.json`
 * era) — only `'proven'` opens the gate.
 */
export type RunbookStatus = 'proven' | 'unproven-draft' | 'absent';

/**
 * One PROVEN runbook revision, resolved at enqueue time by
 * {@link VerificationScheduler.resolveProvenRunbook} — the content to merge into
 * the composed task plus the two values that become the request row's PIN
 * (migration 096 `runbook_hash` / `runbook_local_version`).
 *
 * `hash` and `version` travel together on purpose: the hash content-addresses
 * the COMMITTED half (so the runner can resolve the exact revision from a
 * snapshot whose tree predates the file entirely) while the version is the
 * MACHINE-LOCAL record's CAS token (so a registration that swapped the record
 * underneath an in-flight request is diagnosable rather than silent).
 */
export interface ProvenRunbookRevision {
  hash: string;
  version: number;
  entry: VerifyRunbookModalityEntry;
}

/** The §3.4 circuit-breaker notice seam — see {@link VerificationSchedulerDeps.capabilityFinding}. */
export type CapabilityBreakerFindingFn = (args: {
  projectId: number;
  runId: string;
  modality: VerificationModality;
  /** The env-failure reason that tripped the breaker (the last terminal's evidence). */
  reason: string;
}) => void | Promise<void>;
