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
import { EventEmitter } from 'node:events';
import { mutex as globalMutex, type Mutex } from '../../utils/mutex';
import { emitSeamError } from '../telemetrySink';
import { classifyErrorPattern, unclassifiedErrorTags } from '../programmatic/systemicError';
import type { DatabaseLike, LoggerLike } from '../types';
import type {
  CaptureContext,
  CaptureOrigin,
  DeliverableVerifyConfig,
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerificationBackendRegistry,
  VerificationFailureClass,
  VerificationFailureEvidence,
  VerificationModality,
  VerificationReportV1,
  VerificationRequestInput,
  VerificationTaskV1,
  VerificationType,
  VerdictV1,
  VerifyChainEntry,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
} from '../../../../shared/types/visualVerification';
import {
  VERIFY_PORT_ANY,
  VISUAL_VERIFY_DEFAULTS,
  isVerificationModality,
  parseVerificationTaskV1,
  resolveTaskModality,
  runbookBootstrapKillSwitchEngaged,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationAgentRunnerLike,
  VerificationAgentRequest,
  VerificationAgentRunResult,
} from './verificationAgentRunner';
import type { AgentPreflightResult } from './preflight';
import { classifyVerificationFailure } from './failureClassifier';
import type { VerifyCapabilityStore } from './capabilityStore';
import type { VerifyRunbookStore, VerifyRunbookStatusDetail } from './runbookStore';
import {
  declineForRunbookStatus,
  taskDerivesEnvironment,
  type BootstrapDecision,
  type BootstrapDeclineReason,
} from './bootstrapEligibility';
import { runbookBootstrapPreflight } from './runbookBootstrapPreflight';
import type { BootstrapRunOutcome, RunbookBootstrapArgs } from './runbookBootstrapRunner';
import type { VerifyRunbookModality } from '../../../../shared/types/verifyRunbook';
// The `this`-free constants, row shapes and pure policy functions this class
// reads — extracted to a sibling module for the issue #19 size ratchet and
// RE-EXPORTED further down, so every existing consumer's import still resolves
// off this file.
import {
  orderAgentDrainRows,
  isTerminalRequestStatus,
  isRequestStatus,
  parseVerdictFeedback,
  AWAIT_TERMINAL_POLL_INTERVAL_MS,
  AWAIT_TERMINAL_TIMEOUT_MESSAGE,
  AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
  VERIFY_SCREEN_LEASE,
  verifyAgentSlot,
  verifyPortLease,
  verifySimLease,
  sprintVerifyBatchLease,
  raceWithAbort,
} from './schedulerHelpers';
import {
  MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
  mobileSlotNames,
  mobileToolchainDetail,
} from './mobileGates';
import type {
  ProvenRunbookRevision,
  CapabilityBreakerFindingFn,
  AwaitTerminalOutcome,
  VerificationRequestSummary,
  VerificationRequestRow,
} from './schedulerHelpers';

// Re-exported for existing consumers — the type moved to shared so the
// screenshots-artifact payload (shared/types/artifacts.ts) can carry it without a
// shared->main import.
export type { CaptureOrigin } from '../../../../shared/types/visualVerification';

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
// Phase-0 gate vocabulary (docs/proposals/verification-setup-flow.md §3.2/§3.3)
// ---------------------------------------------------------------------------

/**
 * Modalities the AGENT engine has no executable path for, with the reason a
 * human sees on the skip (§3.3). Until phase 1 ships the roster these land here
 * with an explicit statement instead of today's deploy-and-fail-organically: the
 * agent path never consults `verify_type` (dispatch keys solely on the run's
 * chain stamp) and `VerificationAgentRequest` carries no type field, so a
 * `native-desktop` / `mobile-flow` request is otherwise deployed as if it were a
 * web check and burns the full deadline before failing incomprehensibly.
 *
 * A modality ABSENT from this map is supported. Typed as a partial record so
 * adding a member to the shared union makes this a compile-visible decision.
 *
 * `native-screen` and `mobile` are both CONDITIONALLY unsupported: each entry is
 * the answer for a deployment with NO probe wired (the phase-0 posture — an
 * unprobed host cannot be assumed capable), and the matching probe
 * ({@link VerificationSchedulerDeps.nativeCaptureProbe} /
 * {@link VerificationSchedulerDeps.mobileToolchainProbe}) overrides it when it
 * answers true.
 */
const UNSUPPORTED_MODALITY_REASONS: Partial<Record<VerificationModality, string>> = {
  'native-screen': 'native-screen capture/drive not yet wired on the agent path (proposal §4)',
  mobile: MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
};

/**
 * The detail a `native-screen` skip carries when a capability probe WAS wired
 * and answered FALSE — i.e. this host was asked and said no. The skip is
 * structurally identical to the probe-less one above (same
 * `unsupported modality '<m>': <detail>` shape, same `markUnsupported` ledger
 * write, same `env` failure class, same evidence row); only the DETAIL differs,
 * and it differs on purpose: "not yet wired" is a statement about cyboflow that
 * a user can do nothing about, whereas the grant pair is the one native-screen
 * failure a human can actually fix (grant Screen Recording + Accessibility, or
 * install the binary). The probe (`peekabooBackend.healthCheck`) collapses
 * binary-absent and grant-declined into a single boolean by design — it never
 * throws and never distinguishes — so this names both halves rather than
 * guessing which one bit.
 */
const NATIVE_CAPTURE_UNAVAILABLE_DETAIL =
  'this host cannot capture the screen — the peekaboo binary is missing, or one of the two required macOS TCC grants (Screen Recording + Accessibility) is not held';

/**
 * The §3.2 degrade-path skip reason. Exported because verdictDelivery matches on
 * it to attach the setup CTA to the non-blocking finding — this is the ONE skip
 * reason a human can act on directly, and phase 2 will turn that CTA into a real
 * launch affordance for the verification-setup flow.
 */
export const VERIFY_NO_RUNBOOK_REASON =
  'no proven verification runbook for this project (run verification setup)';

/**
 * The §3.2 skip reason for §4's PRE-MERGE case: a runbook IS proven for this
 * project, this branch just does not carry the portable file yet.
 *
 * A separate string because the remedy is the opposite of the one above.
 * `VERIFY_NO_RUNBOOK_REASON` tells a human to run verification setup; doing that
 * HERE would derive a fresh runbook and UPSERT it over the proven singleton
 * record every other branch depends on (runbookStore's `registerDraft`),
 * breaking verification for the projects that configured it properly. The right
 * action is to merge the branch that already carries it.
 *
 * MOSTLY UNREACHABLE SINCE F10. The store's `statusDetail` no longer answers
 * `'proven-file-absent-here'` for a genuinely absent file — the record, not the
 * file, is what a proof executes, so the portable-hash conjunct is skipped and
 * the branch is judged on its project inputs. Kept because the mapping is still
 * total over {@link VerifyRunbookStatusDetail} and an injected/stubbed resolver
 * may still produce that reason.
 */
export const VERIFY_RUNBOOK_ELSEWHERE_REASON =
  'a proven verification runbook exists for this project but is not in this branch';

/**
 * The §3.2 skip reason for a runbook that WAS proven and has since drifted —
 * its own content, the project inputs it builds through, or the host. Since F4
 * (docs/proposals/visual-verification-brittleness-fixes.md) the read that
 * produces this LEAVES THE RECORD INTACT and merely refuses: the drift is
 * recomputed on every gate/badge read, so it can go away on its own (the inputs
 * come back) or be cleared by a re-prove that re-stamps the provenance. What it
 * needs is re-proving, never re-deriving.
 */
export const VERIFY_RUNBOOK_DRIFTED_REASON =
  "this project's proven verification runbook no longer matches its inputs";
// ONE STRING FOR BOTH DRIFTS, deliberately (F4 fix round). The store tells
// provenance drift (`'drifted'`) from content drift (`'content-drifted'`)
// because their REMEDIES differ — the first is re-proven automatically, the
// second must be re-registered — but to a REQUEST they are the same fact, and
// forking the skip text here would fork `runbookDeclineForSkipReason` below,
// which reverse-maps the persisted string. `bootstrapEligibility` holds the
// distinction; the gate stays coarse.

/**
 * The §3.2 skip reason when the runbook record could not be READ at all (a
 * pre-096 DB, a SQL error, an input hash that would not compute). Distinct from
 * "none exists" on purpose: the store fails soft to `'absent'`, and reporting
 * that as "never set up" would send a human to re-run a setup flow that already
 * succeeded.
 */
export const VERIFY_RUNBOOK_UNREADABLE_REASON =
  'the verification runbook record for this project could not be read';

/**
 * The skip reason for a runbook decline — the forward direction of
 * {@link runbookDeclineForSkipReason}.
 *
 * `null` (the status is bootstrappable: nothing derived, a draft, or a file this
 * host never proved) and `'already-proven'` both fall through to the ORIGINAL
 * reason string, so every pre-existing consumer and every existing test keeps
 * matching exactly what it matched before. Only the three genuinely different
 * situations get their own text. `'already-proven'` is unreachable from the gate
 * (a proven status returns before this) and is mapped rather than thrown on so a
 * future caller cannot turn a classification into a crash.
 */
function skipReasonForRunbookDecline(decline: BootstrapDeclineReason | null): string {
  switch (decline) {
    case 'proof-belongs-elsewhere':
      return VERIFY_RUNBOOK_ELSEWHERE_REASON;
    case 'stale-proof':
      return VERIFY_RUNBOOK_DRIFTED_REASON;
    case 'unobservable':
      return VERIFY_RUNBOOK_UNREADABLE_REASON;
    default:
      return VERIFY_NO_RUNBOOK_REASON;
  }
}

/**
 * Reverse-map a persisted `error_message` back to the situation that produced
 * it, so a consumer holding only the string (verdictDelivery, building the
 * human-facing finding) can attach the RIGHT remedy. `null` for anything that is
 * not a runbook-shaped skip.
 */
export function runbookDeclineForSkipReason(
  errorMessage: string | null,
): BootstrapDeclineReason | null {
  switch (errorMessage) {
    case VERIFY_RUNBOOK_ELSEWHERE_REASON:
      return 'proof-belongs-elsewhere';
    case VERIFY_RUNBOOK_DRIFTED_REASON:
      return 'stale-proof';
    case VERIFY_RUNBOOK_UNREADABLE_REASON:
      return 'unobservable';
    default:
      return null;
  }
}

/**
 * The prefix stamped on a terminal the §3.1 GATE-INTEGRITY guard blocked — a
 * DEPLOYED session whose skip nothing corroborated (see
 * {@link VerificationScheduler.isUnprovenAdvancingSkip}). Exported so tests and
 * any future health-panel grouping can key on the exact string rather than
 * re-deriving it; the original runner message is appended after it, because the
 * conversion changes the STATUS and must never destroy the evidence.
 */
export const VERIFY_UNPROVEN_SKIP_BLOCKED = 'unverified result blocked (§3.1 gate integrity)';

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
   * QUARANTINED lease names (redesign §5.4 step 6): a lease whose underlying
   * resource (a leaked verification port) would NOT free at teardown. The mutex
   * slot is kept HELD (the retained `release` is stored, never called at
   * quarantine time) so the next acquisition can never hand out a still-dirty
   * port; each entry carries a `probeFree` re-check that `tryAcquireOneOf` runs
   * before considering the slot, freeing it once the resource is genuinely free.
   */
  private readonly quarantined = new Map<
    string,
    { probeFree: () => Promise<boolean>; reason: string; release: () => void }
  >();

  /**
   * Quarantine a held lease instead of releasing it (§5.4 step 6). The mutex slot
   * stays HELD — `handle.release()` is retained, not called — so a leaked port can
   * never collide with the next verification. `probeFree` is re-run on a later
   * acquisition attempt for this exact name; when it reports the resource free the
   * slot is released and re-enters normal rotation. A no-lease handle is a no-op.
   */
  quarantine(handle: LeaseHandle, probeFree: () => Promise<boolean>, reason: string): void {
    if (handle.name === null) return;
    this.quarantined.set(handle.name, { probeFree, reason, release: handle.release });
  }

  /** True when `name` is currently held in quarantine (test/observability helper). */
  isQuarantined(name: string): boolean {
    return this.quarantined.has(name);
  }

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
      // A quarantined slot (§5.4 step 6) is re-probed before it can be handed out:
      // if its resource freed, release the held quarantine (which frees the mutex
      // slot) and fall through to the normal acquire; otherwise skip this candidate.
      const q = this.quarantined.get(name);
      if (q) {
        if (await q.probeFree()) {
          this.quarantined.delete(name);
          q.release();
        } else {
          continue;
        }
      }
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
   * The mobile twin of `nativeCaptureProbe` (mobile-verification-tier §10): can
   * this host stand up an iOS Simulator verification at all — Xcode
   * command-line tools present, an iOS runtime available, and a device type that
   * runtime supports. Same injection shape, same never-throws contract, same
   * ABSENT semantics (an unprobed host is not a capable host, so every `mobile`
   * request is skipped without asking). A throw is FAIL-CLOSED — see
   * {@link mobileToolchainDetail}.
   */
  mobileToolchainProbe?: () => Promise<boolean>;
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

// ---------------------------------------------------------------------------
// Moved to ./schedulerHelpers (issue #19 size ratchet)
//
// The §5.4 drain-priority policy, the §5.2 seam-2 await primitives and the row
// shapes they read are `this`-free, so they live in a sibling module. They are
// RE-EXPORTED here verbatim: every previously-exported name still resolves off
// './verificationScheduler', so no consumer's import changed.
// ---------------------------------------------------------------------------

export {
  SETUP_PROOF_PROMOTION_MS,
  VERIFY_SCREEN_LEASE,
  VERIFY_AGENT_LEASE,
  verifyAgentSlot,
  verifyPortLease,
  verifySimLease,
  sprintVerifyBatchLease,
  AbortRaceError,
  raceWithAbort,
  orderAgentDrainRows,
  NON_TERMINAL_REQUEST_STATUSES,
  isTerminalRequestStatus,
  AWAIT_TERMINAL_POLL_INTERVAL_MS,
  AWAIT_TERMINAL_TIMEOUT_MESSAGE,
  AWAIT_TERMINAL_NOT_FOUND_MESSAGE,
} from './schedulerHelpers';
export type {
  RunbookStatus,
  ProvenRunbookRevision,
  CapabilityBreakerFindingFn,
  AgentDrainOrderRow,
  AwaitTerminalOutcome,
  VerificationRequestSummary,
} from './schedulerHelpers';

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
  private readonly liveConfig: (() => ResolvedVisualVerifyConfig) | null;
  private readonly onVerdict?: OnVerdict;
  private readonly leasePool: ResourceLeasePool;
  private readonly requestTimeoutMs: number;
  private readonly devServerProvider?: DevServerProvider;
  private readonly devServerContextResolver?: DevServerContextResolver;
  private readonly staticServerProvider?: StaticServerProvider;
  private readonly staticHtmlContextResolver?: StaticHtmlContextResolver;
  private readonly baselinePreDiff?: BaselinePreDiffResolver;
  private readonly baselineMatchThreshold: number;
  private readonly now: () => number;
  private readonly agentRunner?: VerificationAgentRunnerLike;
  private readonly agentRequestTimeoutMs: number;
  private readonly agentRequestCeilingMs: number;
  private readonly portFreeProbe: (port: number) => Promise<boolean>;
  private readonly queuedAgeCeilingMs: number;
  private readonly legacyKillSwitch: () => boolean;
  private readonly capabilityStore?: VerifyCapabilityStore;
  private readonly runbookStatus: (
    projectId: number,
    modality: VerificationModality,
    probePath?: string,
  ) => Promise<VerifyRunbookStatusDetail>;
  private readonly runbookStore?: VerifyRunbookStore;
  private readonly capabilityFinding?: CapabilityBreakerFindingFn;
  private readonly nativeCaptureProbe?: () => Promise<boolean>;
  private readonly mobileToolchainProbe?: () => Promise<boolean>;
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
   * In-process delivery-retry sweep (§5.6 amended): armed when a delivery leaves a
   * terminal row `pending` (a required consumer failed); fires
   * replayPendingDeliveries after a backoff so recovery does not wait for the next
   * boot. One timer at a time, `unref`ed like queuedAgeTimer.
   */
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current retry backoff — doubles per consecutive failed sweep, reset on a full drain. */
  private deliveryRetryDelayMs = DELIVERY_RETRY_BASE_MS;

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
    this.liveConfig = deps.liveConfig ?? null;
    this.onVerdict = deps.onVerdict;
    this.leasePool = deps.leasePool ?? new ResourceLeasePool();
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.devServerProvider = deps.devServerProvider;
    this.devServerContextResolver = deps.devServerContextResolver;
    this.staticServerProvider = deps.staticServerProvider;
    this.staticHtmlContextResolver = deps.staticHtmlContextResolver;
    this.baselinePreDiff = deps.baselinePreDiff;
    this.baselineMatchThreshold = deps.baselineMatchThreshold ?? DEFAULT_SSIM_MATCH_THRESHOLD;
    this.now = deps.now ?? (() => Date.now());
    this.agentRunner = deps.agentRunner;
    this.agentRequestTimeoutMs = deps.agentRequestTimeoutMs ?? DEFAULT_AGENT_REQUEST_TIMEOUT_MS;
    this.agentRequestCeilingMs = deps.agentRequestCeilingMs ?? AGENT_REQUEST_TIMEOUT_CEILING_MS;
    this.portFreeProbe = deps.portFreeProbe ?? (async () => true);
    this.queuedAgeCeilingMs = deps.queuedAgeCeilingMs ?? this.config.queuedAgeCeilingMs;
    this.legacyKillSwitch = deps.legacyKillSwitch ?? (() => process.env.CYBOFLOW_VERIFY_LEGACY === '1');
    this.capabilityStore = deps.capabilityStore;
    // §3.2: an UNWIRED deployment has no way to know a project proved anything —
    // 'absent' is the honest default, not a placeholder. (Phase 2 wires the real
    // store at index.ts; this default is what legacy tests and a pre-096 DB get.)
    this.runbookStatus =
      deps.runbookStatus ??
      // Unwired ⇒ the honest pre-phase-2 answer: nothing was ever derived.
      (async (): Promise<VerifyRunbookStatusDetail> => ({ status: 'absent', reason: 'no-record' }));
    this.runbookStore = deps.runbookStore;
    this.capabilityFinding = deps.capabilityFinding;
    // §4: deliberately NOT defaulted to an always-true thunk — absent means "no
    // probe ran", which the gate reads as unsupported (phase-0 behavior).
    this.nativeCaptureProbe = deps.nativeCaptureProbe;
    this.mobileToolchainProbe = deps.mobileToolchainProbe;
    this.runbookBootstrap = deps.runbookBootstrap;
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
    const replayed = await this.replayPendingDeliveries();

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
      const input = this.parseInput(row.deliverable_json) ?? undefined;
      await this.markTerminalAndDeliver(
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
      const input = this.parseInput(row.deliverable_json) ?? undefined;
      const ageMin = Math.round(ageMs / 60000);
      await this.markTerminalAndDeliver(
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

    // DISPATCH ON THE ENGINE KEY (redesign §5.8): an agent-engine request routes
    // to the VerificationAgentRunner instead of the capture-backend + VLM
    // waterfall below. `isAgentEngineRequest` reads the request's own
    // `chain_json` first (the `__quick__` late-binding case, where posture is
    // resolved at call time and the run stamp cannot carry it) and falls back to
    // the RUN stamp for everything else — which is what every flow run hits, since
    // its request's chain_json is always the empty intersection. A legacy stamp
    // (or an unreadable one — fail-soft) falls through byte-identically.
    if (this.isAgentEngineRequest(row)) {
      return this.processAgentRow(row, parsed);
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

  // --------------------------------------------------------------------------
  // Verification-AGENT engine (redesign §5.4/§5.7)
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
          ? { ...common, mode: 'derive', adopt: decision.adopt }
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
   * Any future table entry is unconditional. `native-screen`: no probe wired ⇒
   * the table's phase-0 detail (unprobed is not capable); probe true ⇒ null
   * (proceed, observe-only); probe false or throwing ⇒
   * {@link NATIVE_CAPTURE_UNAVAILABLE_DETAIL}. `mobile` is the exact same shape
   * over its own probe — see {@link mobileToolchainDetail}.
   */
  private async unsupportedModalityDetail(modality: VerificationModality): Promise<string | null> {
    const tableDetail = UNSUPPORTED_MODALITY_REASONS[modality];
    if (tableDetail === undefined) return null;
    if (modality === 'mobile') return mobileToolchainDetail(this.mobileToolchainProbe, this.logger);
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
   *  1. UNSUPPORTED MODALITY (§3.3/§4). A modality with no executable path on
   *     THIS HOST — the agent path never consults `verify_type` at all
   *     (dispatch keys solely on the run's chain stamp), so such a
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
  private async processAgentRow(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
  ): Promise<{ work: Promise<void> | null }> {
    if (!this.agentRunner) {
      await this.markTerminalAndDeliver(
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
      await this.markTerminalAndDeliver(
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
    // A `mobile` deployment takes the BOUNDED simulator-slot pool in the same
    // position instead (mobile-verification-tier §8): N simulators genuinely run
    // in parallel, so mobile is bounded rather than exclusive.
    let screenLease: LeaseHandle | null = null;
    let mobileLease: LeaseHandle | null = null;
    if (modality === 'native-screen') {
      screenLease = await this.leasePool.tryAcquire(VERIFY_SCREEN_LEASE);
      if (!screenLease) {
        agentLease.release();
        this.logger?.debug('[VerificationScheduler] screen lease held; leaving native-screen row queued', {
          requestId: row.id,
        });
        return { work: null };
      }
    } else if (modality === 'mobile') {
      mobileLease = await this.leasePool.tryAcquireOneOf(mobileSlotNames(this.config.mobileSimSlots));
      if (!mobileLease) {
        agentLease.release();
        this.logger?.debug('[VerificationScheduler] no free mobile simulator slot; leaving queued', {
          requestId: row.id,
        });
        return { work: null };
      }
    }
    // (3) One pooled port (VERIFY_PORT for a serve, and its +1 for the driver CDP).
    // NOT for `mobile` (§8, M1): that tier serves nothing over HTTP and drives no
    // CDP endpoint, so leasing it a port would queue a mobile row behind a
    // port-exhausted pool for a resource it never uses.
    let portLease: LeaseHandle | null = null;
    let leasedPort: number | null = null;
    if (modality !== 'mobile') {
      portLease = await this.leasePool.tryAcquireOneOf(
        this.config.devServerPorts.map(verifyPortLease),
      );
      if (!portLease) {
        mobileLease?.release();
        screenLease?.release();
        agentLease.release();
        this.logger?.debug('[VerificationScheduler] no free verify port; leaving queued', { requestId: row.id });
        return { work: null };
      }
      leasedPort = this.portFromLease(portLease.name);
    }
    if (portLease !== null && leasedPort === null) {
      portLease.release();
      mobileLease?.release();
      screenLease?.release();
      agentLease.release();
      await this.markTerminalAndDeliver(
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
      portLease?.release();
      mobileLease?.release();
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
        mobileLease,
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
   *
   * MOBILE raises the floor further (mobile-verification-tier §19, M9). A cold
   * `xcodebuild` plus a first simulator boot were both MEASURED past two minutes
   * on the owner's host, so the composer's guess is even less trustworthy here
   * than it was for web; `mobileDeadlineFloorMs` is the harness's own number.
   * The CEILING still wins over the floor — an installation that configured a
   * floor above the 20-minute cap gets the cap and one warn line saying the
   * floor was clipped, never a request that outlives the scheduler's contract.
   */
  private agentDeadlineMs(task: VerificationTaskV1, modality: VerificationModality): number {
    const requested =
      typeof task.timeoutMs === 'number' && task.timeoutMs > 0 ? task.timeoutMs : this.agentRequestTimeoutMs;
    const floor =
      modality === 'mobile'
        ? Math.max(this.agentRequestTimeoutMs, this.config.mobileDeadlineFloorMs)
        : this.agentRequestTimeoutMs;
    const deadline = Math.min(this.agentRequestCeilingMs, Math.max(floor, requested));
    if (deadline < floor) {
      this.logger?.warn('[VerificationScheduler] mobile deadline floor clipped by the request ceiling', {
        floorMs: floor,
        ceilingMs: this.agentRequestCeilingMs,
      });
    }
    return deadline;
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
    /** One `verify:mobile:<i>` slot for a `mobile` row; null for every other modality (§8). */
    mobileLease: LeaseHandle | null,
    /** Both null for a `mobile` row — that tier leases no port at all (§8, M1). */
    portLease: LeaseHandle | null,
    leasedPort: number | null,
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

    // ONE evaluation, reused by the abort timer and the runner request, so the
    // mobile floor's warn (see agentDeadlineMs) fires once per deployment.
    const deadlineMs = this.agentDeadlineMs(task, modality);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.logger?.warn('[VerificationScheduler] agent request timed out — aborting', {
        requestId: row.id,
        timeoutMs: deadlineMs,
      });
      controller.abort();
    }, deadlineMs);
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
        await this.markTerminalAndDeliver(
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
        await this.markTerminalAndDeliver(
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
        await this.markTerminalAndDeliver(
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
        verifyDriverPort: leasedPort === null ? null : leasedPort + 1,
        // Thread the effective deadline into the query boundary so its internal
        // deadline matches this method's abort timer — a task-supplied timeoutMs
        // above the query default is honored instead of silently cut to 10 min.
        timeoutMs: deadlineMs,
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
        await this.markTerminalAndDeliver(
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
      await this.markTerminalAndDeliver(
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
      if (portLease !== null && leasedPort !== null) {
        await this.releaseOrQuarantinePort(portLease, leasedPort);
      }
      // The mobile slot releases UNCONDITIONALLY too, and for the screen lease's
      // reason: the per-request simulator is created and destroyed inside the
      // runner, so nothing this deployment leaves behind can occupy the slot.
      mobileLease?.release();
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

    await this.markTerminalAndDeliver(
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
   * The DETACHED capture work for a row whose lease is already held + status is
   * already 'running' (processRow did both synchronously). Runs capture → judge →
   * terminal verdict, releasing the lease in finally. A capture that fails (ok:false
   * or no PNG) is recorded as 'failed' for THIS slice (full fall-forward to the next
   * rung is L2+); a judge verdict drives passed/failed/low_confidence. The
   * per-request abort signal is plumbed to backend + judge for timeout / cancel.
   *
   * Before capture it may stand a scheduler-owned server up and thread its URL into
   * ctx.input.url — the S2 dev server for a startable deliverable (leased port) OR,
   * when none is spawned, the S9 ephemeral static server for a built htmlPath (the
   * file:// ES-module-block fix). The two are mutually exclusive (a startable
   * deliverable is S2's job) and BOTH are released in the SAME finally as the lease.
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
    // The scheduler-owned static server (S9) for this request, if one is spawned. Held
    // for the WHOLE capture lifetime and released in the SAME finally as the dev
    // server. Null when no static server is stood up (a dev server was, or the request
    // is not a bare-htmlPath deliverable) → the raw url/htmlPath capture runs unchanged.
    let staticServerHandle: StaticServerHandle | null = null;
    // The batch worktree-sync mutex (L4) for a batched run, if this run carries a
    // batch_id. Held across capture+judge and released in the SAME finally as the
    // other leases. Null for a non-batch run (nothing acquired → nothing to release).
    let batchLease: LeaseHandle | null = null;
    // HUMAN-FACING capture provenance (Codex finding 9), stamped onto every terminal
    // payload. Computed ONCE per attempt and REFINED as each server spawns: it starts
    // as the best-known origin (a running url the agent passed, else the raw file://
    // htmlPath), is promoted to 'dev-server' if S2 stands one up, else to
    // 'static-server' if S9 does. This progressive form is what lets the abort checks
    // BEFORE the S9 spawn stamp the best-known origin (dev-server/url/file) without
    // restructuring the flow, and keeps it in scope for the catch block below.
    const originalUrlPresent = typeof input.url === 'string' && input.url.trim().length > 0;
    let captureOrigin: CaptureOrigin = originalUrlPresent ? 'url' : 'file';

    try {
      // S2 — stand a dev server up on the leased port when the deliverable recipe
      // has a `start` command. BEFORE building CaptureContext so the spawned baseUrl
      // can be threaded into ctx.input.url. A null handle (no provider / no start /
      // lease is not a port lease) leaves the static url/htmlPath capture unchanged.
      devServerHandle = await this.maybeSpawnDevServer(row, lease, resolvedContext, controller.signal);
      if (devServerHandle) {
        captureOrigin = 'dev-server';
      }
      // A timeout/cancel that fired DURING dev-server spawn: stop here, mark
      // 'timeout', releasing both the dev server (in finally) and the lease. (The S9
      // static server has not been attempted yet, so captureOrigin here is at most
      // dev-server/url/file — the best-known origin at this point.)
      if (controller.signal.aborted) {
        await this.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // S9 — when NO dev server was stood up, stand an ephemeral loopback static file
      // server up for a bare-htmlPath deliverable (the file:// ES-module-block fix).
      // Mutually exclusive with the dev server: a startable deliverable is S2's job, so
      // we only consider a static serve when devServerHandle is null. Its baseUrl is
      // threaded into ctx.input.url exactly like the dev server; released in the SAME
      // finally. A null handle (no static deps / no htmlPath / a running url / resolve
      // or spawn failed) leaves the raw url/htmlPath capture unchanged (pre-S9 behavior).
      staticServerHandle = devServerHandle
        ? null
        : await this.maybeSpawnStaticServer(row, input, resolvedContext, controller.signal);
      if (staticServerHandle) {
        captureOrigin = 'static-server';
      }
      // A timeout/cancel that fired DURING static-server spawn: stop here, mark
      // 'timeout', releasing both the static server (in finally) and the lease.
      if (controller.signal.aborted) {
        await this.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
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
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // Thread the scheduler-owned server's URL into the capture input: the S2 dev
      // server wins, else the S9 static server, else the raw url/htmlPath is captured.
      const captureInput: VerificationRequestInput = devServerHandle
        ? { ...input, url: devServerHandle.baseUrl }
        : staticServerHandle
          ? { ...input, url: staticServerHandle.baseUrl }
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
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // UNTRUSTED capture diagnostics (Codex finding 7): error-level page console
      // lines + capture-side notes the backend surfaced. Capped defensively (page code
      // controls this text) and attached to the HUMAN-facing terminal payloads only —
      // the capture-failure and judged-outcome ones below. They MUST NOT reach the
      // VlmJudge inputs (prompt-injection surface); the judge call stays byte-identical.
      const cappedDiagnostics =
        Array.isArray(capture.diagnostics) && capture.diagnostics.length > 0
          ? this.capDiagnostics(capture.diagnostics)
          : undefined;

      if (!capture.ok || capture.fileNames.length === 0) {
        await this.markTerminalAndDeliver(
          row,
          'failed',
          {
            backend: backend.id,
            error: capture.error ?? 'capture produced no images',
            captureOrigin,
            ...(cappedDiagnostics ? { diagnostics: cappedDiagnostics } : {}),
          },
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
      //      the resolved baselinePath. The per-project VERIFICATION budget (the SAME
      //      counter runAgentChosen checks for an agent deployment, §5.8) is enforced
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
            { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
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
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
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
        {
          backend: backend.id,
          verdict,
          captureOrigin,
          ...(cappedDiagnostics ? { diagnostics: cappedDiagnostics } : {}),
        },
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
        {
          backend: backend.id,
          error: aborted ? (timedOut ? 'request timed out' : 'aborted') : message,
          captureOrigin,
        },
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
      // Tear the S9 static server down (closes the listener + force-destroys open
      // sockets). Guarded on null (none spawned). Fail-soft in the SAME shape as the
      // dev-server teardown: a release() throw is logged, never propagated, so it can
      // never leave the port/screen lease un-released below.
      if (staticServerHandle) {
        try {
          await staticServerHandle.release();
        } catch (err) {
          this.logger?.error('[VerificationScheduler] static-server teardown threw', {
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
   * Stand a scheduler-owned STATIC file server up for this request when it targets a
   * BUILT html file with no running url and no dev-server recipe (S9 / the file://
   * ES-module-block fix). Returns the live StaticServerHandle (the caller threads
   * handle.baseUrl into ctx.input.url and release()s it in the SAME finally as the S2
   * dev server), or null when no static server is stood up — and in EVERY null case
   * the request captures its raw url/htmlPath UNCHANGED (pre-S9 file:// behavior), so
   * a non-static request is byte-identical to before this layer:
   *   - EITHER dep absent (staticServerProvider / staticHtmlContextResolver): a
   *     deployment wired without the S9 seam — the static-capture path is preserved.
   *   - the request carries no htmlPath (empty after trim): there is nothing to serve.
   *   - the request already declares a running `url`: the agent pointed at a live
   *     server, so we capture that url directly and NEVER shadow it with a static serve.
   *   - the request declares a dev server (non-empty `start`): a STARTABLE deliverable
   *     is S2's job (maybeSpawnDevServer stands it up on a leased port); statically
   *     serving the UNBUILT source html would be wrong. inputDeclaresDevServer is the
   *     SAME signal the dev-server selection gate keys off, so the two seams are
   *     mutually exclusive by construction (runChosen also skips S9 when a dev server
   *     was already spawned).
   *   - the resolver returns null / THROWS: the html could not be worktree-resolved or
   *     does not exist. Fail-soft (debug log) to the raw-htmlPath capture — the rung-0
   *     backend's own file:// module-block diagnostic breadcrumb explains the resulting
   *     blank styled shell to a human.
   *   - the provider.spawn THROWS (bind failure / abort mid-listen): warn + return
   *     null. A static-serve failure must NEVER wedge the request — capturing the raw
   *     htmlPath (blank though it may render) is strictly better than a fabricated FAIL,
   *     and the same file:// diagnostic breadcrumb covers the confusion.
   *
   * The confining static root rides `resolvedContext` (the matched verify.json
   * deliverable's explicit `staticRoot`, when it declares one) rather than the request
   * input — staticRoot is a serve-time concern, not an input field. The resolver
   * defaults it to dirname(html) when absent.
   */
  private async maybeSpawnStaticServer(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    resolvedContext: { cwd: string; deliverable: DeliverableVerifyConfig } | null,
    signal: AbortSignal,
  ): Promise<StaticServerHandle | null> {
    if (!this.staticServerProvider || !this.staticHtmlContextResolver) {
      return null;
    }
    const htmlPath = input.htmlPath?.trim() ?? '';
    if (htmlPath.length === 0) {
      return null;
    }
    // A running url the agent passed is captured directly — never shadowed by a static
    // serve of a build output.
    if (typeof input.url === 'string' && input.url.trim().length > 0) {
      return null;
    }
    // A startable deliverable is the dev-server seam's job (S2), not ours.
    if (this.inputDeclaresDevServer(input)) {
      return null;
    }

    // Resolve the absolute html path + confining static root (fs work lives in the
    // injected closure). A throw is the same fail-soft "no static server" path as a
    // null return — the raw htmlPath capture runs unchanged.
    let context: { absoluteHtmlPath: string; staticRoot: string } | null;
    try {
      context = await this.staticHtmlContextResolver({
        runId: row.run_id,
        projectId: row.project_id,
        htmlPath,
        staticRoot: resolvedContext?.deliverable?.staticRoot,
      });
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] static html context resolve threw; capturing raw htmlPath', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!context) {
      this.logger?.debug('[VerificationScheduler] no static html context; capturing raw htmlPath', {
        requestId: row.id,
      });
      return null;
    }

    // Stand the server up. A bind/abort failure fail-softs to the raw htmlPath capture
    // (never a request FAIL) — the rung-0 file:// diagnostic breadcrumb covers it.
    try {
      this.logger?.debug('[VerificationScheduler] spawning static server', {
        requestId: row.id,
        absoluteHtmlPath: context.absoluteHtmlPath,
        staticRoot: context.staticRoot,
      });
      return await this.staticServerProvider.spawn({
        absoluteHtmlPath: context.absoluteHtmlPath,
        staticRoot: context.staticRoot,
        signal,
      });
    } catch (err) {
      this.logger?.warn('[VerificationScheduler] static server spawn threw; capturing raw htmlPath (fail-soft)', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Bound UNTRUSTED capture diagnostics (Codex finding 7) before they ride a terminal
   * payload to the human surfaces: cap at 10 entries AND 2000 total chars. Entries are
   * taken in order; the entry that would overflow the char budget is TRUNCATED to the
   * remaining budget and every entry after it is DROPPED. Page code controls this text
   * (prompt-injection surface), so it is defensively bounded here and NEVER threaded
   * into VlmJudge inputs — it is metadata for the result payload / review item only.
   */
  private capDiagnostics(diagnostics: string[]): string[] {
    const MAX_ENTRIES = 10;
    const MAX_TOTAL_CHARS = 2000;
    const capped: string[] = [];
    let total = 0;
    for (const entry of diagnostics.slice(0, MAX_ENTRIES)) {
      const remaining = MAX_TOTAL_CHARS - total;
      if (remaining <= 0) break;
      if (entry.length <= remaining) {
        capped.push(entry);
        total += entry.length;
      } else {
        // The overflowing entry is truncated to fit the budget; the rest are dropped.
        capped.push(entry.slice(0, remaining));
        break;
      }
    }
    return capped;
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
    extra: TerminalExtra = {},
  ): number {
    // The migration-095 classification columns are written in the SAME guarded
    // write as the status, so a health-panel audit can never observe a terminal
    // row whose verdict and its evidence disagree. FAIL-SOFT (mirrors
    // agentColumnsForRow): a pre-095 DB — every minimal test fixture, and any
    // binary rolled back below the migration — throws on `prepare`, BEFORE any
    // row is touched, so falling through to the legacy write below is safe and
    // byte-identical to the pre-phase-0 behavior.
    const hasClassification =
      extra.failureClass !== undefined ||
      extra.failureEvidence !== undefined ||
      extra.preflight !== undefined;
    if (hasClassification) {
      try {
        return this.markTerminalWithClassification(id, status, extra);
      } catch (err) {
        this.logger?.debug('[VerificationScheduler] classification columns unavailable; writing legacy terminal', {
          requestId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = ?,
                current_backend = COALESCE(?, current_backend),
                verdict_json = ?,
                report_json = COALESCE(?, report_json),
                error_message = ?,
                delivery_state = 'pending',
                attempt = attempt + 1,
                ended_at = ?
          WHERE id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .run(
        status,
        extra.backend ?? null,
        extra.verdict ? JSON.stringify(extra.verdict) : null,
        // report_json (redesign §5.6): committed atomically with the terminal
        // status. COALESCE(NULL, report_json) leaves the legacy path's report_json
        // untouched (always NULL there); an agent row writes its normalized report.
        extra.report ? JSON.stringify(extra.report) : null,
        extra.error ?? null,
        new Date().toISOString(),
        id,
      ).changes;
  }

  /**
   * The migration-095 widening of {@link markTerminal}: the identical guarded
   * UPDATE plus `failure_class` / `failure_evidence_json` / `preflight_json`
   * (docs/proposals/verification-setup-flow.md §3.1 — "The classifier's inputs
   * and verdict are persisted on the request row so the health panel can show the
   * env/deliverable/ambiguous histogram and misclassification can be audited").
   * Throws on a pre-095 DB; {@link markTerminal} owns that fallback.
   */
  private markTerminalWithClassification(id: string, status: RequestStatus, extra: TerminalExtra): number {
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = ?,
                current_backend = COALESCE(?, current_backend),
                verdict_json = ?,
                report_json = COALESCE(?, report_json),
                error_message = ?,
                failure_class = ?,
                failure_evidence_json = ?,
                preflight_json = ?,
                delivery_state = 'pending',
                attempt = attempt + 1,
                ended_at = ?
          WHERE id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .run(
        status,
        extra.backend ?? null,
        extra.verdict ? JSON.stringify(extra.verdict) : null,
        extra.report ? JSON.stringify(extra.report) : null,
        extra.error ?? null,
        extra.failureClass ?? null,
        extra.failureEvidence ? JSON.stringify(extra.failureEvidence) : null,
        extra.preflight ? JSON.stringify(extra.preflight) : null,
        new Date().toISOString(),
        id,
      ).changes;
  }

  /**
   * Delivery-outbox stamp (§5.6): flip `delivery_state` to 'delivered' AFTER all
   * three verdict-delivery consumers (artifact / lane / finding) have SUCCEEDED —
   * written only by markTerminalAndDeliver + the replay sweeps, and only when
   * deliver() reported success. markTerminal stamps 'pending' atomically with the
   * terminal status, so both a crash in the window between the two AND a failed
   * consumer leave 'pending' for replay to pick up. A legacy/pre-078 row
   * (delivery_state NULL) never reaches here. Best-effort — a failed flip merely
   * re-delivers once more (idempotently) at the next sweep/boot.
   */
  private markDelivered(id: string): void {
    try {
      this.db.prepare(`UPDATE verification_requests SET delivery_state = 'delivered' WHERE id = ?`).run(id);
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] delivery_state=delivered stamp failed (fail-soft)', {
        requestId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    extra: TerminalExtra,
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
    // Report a verification that genuinely FAILED or TIMED OUT. Deliberately NOT
    // 'skipped': a skip is this scheduler's by-design non-failure for a missing
    // precondition (no usable/healthy backend, missing TCC grant, uninstalled
    // chromium, static-only chain, unparseable input) — and on a host without a
    // provisioned visual-verify backend (the documented common case) EVERY request
    // skips, which would flood Sentry with non-errors under a seam named
    // 'verify-request-failed' and bury real signal. Passed / low_confidence are
    // valid verdicts, also not errors. Only after the guarded write won
    // (changes === 1) so a cancel-race never double-reports.
    if (status === 'failed' || status === 'timeout') {
      // extra.error (a capture/judge error) may include a URL or path, so it is
      // NOT put in the exception message — only the bounded errorClass, derived
      // from it, plus the bounded requestStatus/verifyType/backend tags.
      const verifyErrorClass = classifyErrorPattern(extra.error);
      emitSeamError('verify-request-failed', new Error(`verify ${status} (${verifyErrorClass})`), {
        requestStatus: status,
        verifyType: row.verify_type,
        ...(extra.backend ? { backend: extra.backend } : {}),
        errorClass: verifyErrorClass,
        // An UNCLASSIFIED verify failure is otherwise blind: the message is
        // withheld above and `other`/`unknown` says nothing about which failure
        // it was. The shape+digest split it without shipping the text — the last
        // `other`-emitting seam to be wired for this (cf. stepResultStore,
        // monitorQuery, claudeCodeManager).
        ...unclassifiedErrorTags(verifyErrorClass, extra.error),
      });
    }
    const deliveredOk = await this.deliver(row, status, verdict, fileNames, input, extra);
    // §5.6 delivery-outbox (amended, adversarial-review fix 2026-07-23): flip the
    // 'pending' stamp markTerminal wrote to 'delivered' ONLY when every required
    // consumer succeeded. A crash before this line leaves the row
    // terminal-but-'pending' for the boot replay — and now a swallowed consumer
    // error does too: the row stays 'pending' and an in-process retry sweep
    // re-delivers it (idempotently) without waiting for a reboot.
    if (deliveredOk) {
      this.markDelivered(row.id);
    } else {
      this.logger?.warn('[VerificationScheduler] delivery incomplete; leaving row pending for retry', {
        requestId: row.id,
        status,
      });
      this.armDeliveryRetryTimer();
    }
  }

  /**
   * §5.6 delivery-outbox replay: re-deliver every TERMINAL row still marked
   * `delivery_state='pending'` (a crash struck after markTerminal committed the
   * status but before/within the three verdict deliveries, OR a required consumer
   * failed on a prior attempt), stamping 'delivered' only for rows whose delivery
   * fully succeeds; the rest stay pending and re-arm the in-process retry sweep.
   * Runs at boot from runRecovery AND from armDeliveryRetryTimer's backoff sweep.
   * Reconstructs the deliver() args from the
   * persisted columns; the load-bearing consumers (artifact merge keyed by
   * (taskRef, requestId), the requestAttempt-guarded lane advance, the
   * requestId-correlated finding) are all idempotent, so a double replay is a
   * no-op. Legacy/pre-078 rows have NULL delivery_state and are self-excluded.
   * fileNames / captureOrigin are best-effort (the agent path's captureOrigin is
   * always 'agent'; diagnostics are not persisted and are omitted on replay).
   */
  private async replayPendingDeliveries(): Promise<number> {
    let rows: Array<{
      id: string;
      run_id: string;
      project_id: number;
      status: string;
      verify_type: string;
      deliverable_json: string;
      verdict_json: string | null;
      report_json: string | null;
    }>;
    try {
      rows = this.db
        .prepare(
          `SELECT id, run_id, project_id, status, verify_type, deliverable_json, verdict_json, report_json
             FROM verification_requests
            WHERE delivery_state = 'pending'
              AND status IN ('passed', 'failed', 'low_confidence', 'skipped', 'timeout')
            ORDER BY enqueued_at ASC, id ASC`,
        )
        .all() as typeof rows;
    } catch (err) {
      // A minimal DB lacking delivery_state (pre-078) has nothing to replay.
      this.logger?.debug('[VerificationScheduler] delivery-outbox replay query failed (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    let replayed = 0;
    let stillFailing = 0;
    for (const row of rows) {
      const input = this.parseInput(row.deliverable_json) ?? undefined;
      const verdict = this.parseVerdict(row.verdict_json);
      const fileNames = this.deriveReplayFileNames(row.report_json, verdict);
      // A persisted report_json means the agent engine produced this terminal —
      // its capture origin is always 'agent' (§5.9); the legacy path leaves it
      // undefined on replay (diagnostics are not persisted either).
      const extra: TerminalExtra = row.report_json ? { captureOrigin: 'agent' } : {};
      const deliverRow: VerificationRequestRow = {
        id: row.id,
        run_id: row.run_id,
        project_id: row.project_id,
        status: row.status,
        verify_type: row.verify_type,
        deliverable_json: row.deliverable_json,
        chain_json: null,
        current_backend: null,
        attempt: 0,
        enqueued_at: '',
      };
      const ok = await this.deliver(deliverRow, row.status as RequestStatus, verdict, fileNames, input, extra);
      if (ok) {
        this.markDelivered(row.id);
        replayed += 1;
      } else {
        stillFailing += 1;
      }
    }
    if (replayed > 0) {
      this.logger?.info('[VerificationScheduler] replayed pending verdict deliveries', { replayed });
    }
    if (stillFailing > 0) {
      // A consumer failed again — keep the rows pending and re-arm the sweep with
      // the doubled backoff. A permanently failing row retries at the capped
      // cadence (cheap idempotent DB writes) and is still picked up at next boot.
      this.logger?.warn('[VerificationScheduler] deliveries still failing; retry sweep re-armed', {
        stillFailing,
        nextDelayMs: this.deliveryRetryDelayMs,
      });
      this.armDeliveryRetryTimer();
    } else {
      this.deliveryRetryDelayMs = DELIVERY_RETRY_BASE_MS;
    }
    return replayed;
  }

  /**
   * Arm the in-process delivery-retry sweep (§5.6 amended). One timer at a time;
   * each arming consumes the current backoff and doubles it (capped) so a
   * persistently failing consumer cannot hot-loop. `unref`ed so it never keeps the
   * process alive; the sweep itself is replayPendingDeliveries, whose consumers
   * are idempotent by requestId.
   */
  private armDeliveryRetryTimer(): void {
    if (this.deliveryRetryTimer !== null) return;
    const delay = this.deliveryRetryDelayMs;
    this.deliveryRetryDelayMs = Math.min(this.deliveryRetryDelayMs * 2, DELIVERY_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.deliveryRetryTimer = null;
      void this.replayPendingDeliveries().catch((err: unknown) => {
        this.logger?.warn('[VerificationScheduler] delivery-retry sweep failed (fail-soft)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.deliveryRetryTimer = timer;
  }

  /** Parse a persisted verdict_json into a VerdictV1; undefined on NULL/malformed. */
  private parseVerdict(verdictJson: string | null): VerdictV1 | undefined {
    if (typeof verdictJson !== 'string' || verdictJson.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(verdictJson);
      return parsed !== null && typeof parsed === 'object' ? (parsed as VerdictV1) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort fileNames for a replayed delivery: the agent report's screenshot
   * basenames when a report_json is present, else the verdict's judgedFileNames,
   * else empty. Only feeds the artifact merge's fileNames union + the label — the
   * load-bearing report entry is composed by verdictDelivery from report_json.
   */
  private deriveReplayFileNames(reportJson: string | null, verdict: VerdictV1 | undefined): string[] {
    if (typeof reportJson === 'string' && reportJson.length > 0) {
      try {
        const parsed: unknown = JSON.parse(reportJson);
        if (parsed !== null && typeof parsed === 'object') {
          const shots = (parsed as { screenshots?: unknown }).screenshots;
          if (Array.isArray(shots)) {
            const names = shots
              .map((s) => (s !== null && typeof s === 'object' ? (s as { fileName?: unknown }).fileName : undefined))
              .filter((n): n is string => typeof n === 'string' && n.length > 0);
            if (names.length > 0) return names;
          }
        }
      } catch {
        // fall through to verdict-derived names
      }
    }
    return verdict?.judgedFileNames ?? [];
  }

  // --------------------------------------------------------------------------
  // Verdict delivery (stubbed hook — P8 wires the real routers)
  // --------------------------------------------------------------------------

  /**
   * Fire the injected onVerdict hook (if any). The real side-effects
   * (ArtifactRouter enrich + ReviewItemRouter finding + SprintLaneStore
   * advance/loopback) live behind this callback (verdictDelivery.ts). Fail-soft:
   * a throwing hook is logged, never propagated (it must not wedge the drain loop
   * or leave the lease unreleased — release already ran in runChosen's finally
   * before deliver here is reached for the judged path, and the skip/parse paths
   * hold no lease).
   *
   * Returns TRUE when the hook fully delivered (or none is wired), FALSE when it
   * threw or explicitly returned `false` (a required consumer failed) — the
   * caller then leaves the outbox row 'pending' for replay (§5.6 amended). The
   * terminal event fires REGARDLESS of the hook outcome and never affects the
   * return value: it is a wake signal for in-process listeners, not a durable
   * consumer, and a parked lane must always be woken.
   */
  private async deliver(
    row: VerificationRequestRow,
    status: RequestStatus,
    verdict: VerdictV1 | undefined,
    fileNames: string[],
    input?: VerificationRequestInput,
    extra?: TerminalExtra,
  ): Promise<boolean> {
    let deliveredOk = true;
    if (this.onVerdict) {
      try {
        const hookResult = await this.onVerdict({
          requestId: row.id,
          runId: row.run_id,
          projectId: row.project_id,
          type: row.verify_type as VerificationType,
          status,
          verdict,
          fileNames,
          input,
          // S9 human-facing provenance: forwarded (not persisted by markTerminal)
          // so verdictDelivery can render origin + capped page diagnostics on the
          // review-item finding body + screenshots payload.
          ...(extra?.captureOrigin ? { captureOrigin: extra.captureOrigin } : {}),
          ...(extra?.diagnostics && extra.diagnostics.length > 0
            ? { diagnostics: extra.diagnostics }
            : {}),
        });
        if (hookResult === false) deliveredOk = false;
      } catch (err) {
        deliveredOk = false;
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
    return deliveredOk;
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
