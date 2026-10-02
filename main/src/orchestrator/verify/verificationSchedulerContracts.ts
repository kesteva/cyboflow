/**
 * VerificationScheduler's public CONTRACTS — the terminal-event emitter, the
 * onVerdict hook, the timing constants, and the `VerificationSchedulerDeps` bag
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
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerdictV1,
  VerificationFailureClass,
  VerificationFailureEvidence,
  VerificationModality,
  VerificationReportV1,
  VerificationRequestInput,
  VerificationType,
} from '../../../../shared/types/visualVerification';
import type { VerificationAgentRunnerLike } from './verificationAgentRunner';
import type { AgentPreflightResult } from './preflight';
import type { VerifyCapabilityStore } from './capabilityStore';
import type { VerifyRunbookStatusDetail, VerifyRunbookStore } from './runbookStore';
import type { BootstrapRunOutcome, RunbookBootstrapArgs } from './runbookBootstrapRunner';
import type { ExploreStaleProofFinding } from './runbookBootstrapPreflight';
import type { RunbookLearningFindingFn } from './learnedRunbook';
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

/**
 * The `extra` payload a terminal write hands markTerminal(AndDeliver). `verdict` /
 * `error` are the load-bearing fields markTerminal persists (+ the seam-error
 * tags). `captureOrigin` (Codex finding 9, type in
 * shared/types/visualVerification.ts) and `diagnostics` (Codex finding 7) are
 * PURELY ADDITIVE human-facing provenance: markTerminal does NOT persist them —
 * markTerminalAndDeliver forwards them through deliver() into the onVerdict hook,
 * whose concrete delivery (verdictDelivery.ts) renders them on the review-item
 * finding body + the screenshots artifact payload. NOTHING derives pass/fail from
 * them.
 */
export interface TerminalExtra {
  verdict?: VerdictV1;
  error?: string;
  captureOrigin?: CaptureOrigin;
  diagnostics?: string[];
  /**
   * The verification AGENT's normalized report (redesign §5.4/§5.6). Persisted to
   * `verification_requests.report_json` in the SAME status-guarded terminal write as
   * the status + verdict (markTerminal), so the report commits atomically with the
   * terminal transition. Absent on a report-less terminal (a skip / timeout).
   */
  report?: VerificationReportV1;
  /**
   * The §3.1 conservative classifier's verdict for a terminal FAILURE
   * (docs/proposals/verification-setup-flow.md), persisted to migration 095's
   * `failure_class`. Absent on a pass (the column stays NULL, exactly as for a
   * pre-095 row).
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
// Injected collaborators + optional verdict side-effect hook
// ---------------------------------------------------------------------------

/**
 * The optional verdict-delivery callback. The real side-effects (ArtifactRouter
 * enrich + ReviewItemRouter finding + SprintLaneStore advance/loopback) live
 * behind this hook (verdictDelivery.ts). The scheduler never imports the routers (standalone-typecheck
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
   * was stood up for this attempt — 'agent' for an agent-engine terminal; the
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
 * The per-request hold unit (5 minutes) the batch worktree-sync mutex's acquire
 * timeout is sized from (× {@link BATCH_MUTEX_MAX_QUEUED_HOLDERS}). Tunable via
 * VerificationSchedulerDeps.requestTimeoutMs.
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
 * per-request abort/raceWithAbort machinery.
 */
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard ceiling on an agent row's deadline — a task-supplied `timeoutMs` can never exceed this. */
export const AGENT_REQUEST_TIMEOUT_CEILING_MS = 20 * 60 * 1000;

/**
 * How many concurrent batched holders a waiter on `sprint-verify-<batchId>` may
 * legitimately queue behind. The batch mutex is a count-1 serialization point, so a
 * waiter can stack behind several already-held deployments (see drain's
 * Promise.allSettled), so the waiter's acquire timeout is sized as
 * requestTimeoutMs * this factor — NOT the Mutex 30s default, which would
 * spuriously throw 'Mutex timeout' and mark the second concurrent batched request
 * 'failed' instead of serializing it. Chosen larger than any realistic per-batch lane
 * fan-out so a genuinely serialized waiter waits rather than fails.
 */
export const BATCH_MUTEX_MAX_QUEUED_HOLDERS = 16;

/** The dependency bag VerificationScheduler.initialize takes. */
export interface VerificationSchedulerDeps {
  db: DatabaseLike;
  /** Resolves a run's $CYBOFLOW_RUN_ARTIFACTS_DIR (injected from index.ts). */
  artifactsDirResolver: (runId: string) => string;
  logger?: LoggerLike;
  /** Resolved visualVerify config (port/sim pools, agent slots). Defaults applied. */
  config?: ResolvedVisualVerifyConfig;
  /**
   * The LIVE config, re-read per call. `config` above is resolved once at boot,
   * which is right for the port pools (a run must not
   * change shape underneath itself) and wrong for a user-facing toggle: a switch
   * flipped in Settings is expected to bind the next run, not the next launch.
   * That mattered most in the OFF direction — unchecking "let runs set up
   * verification themselves" mid-incident left the next lane still committing.
   */
  liveConfig?: () => ResolvedVisualVerifyConfig;
  /** Verdict-delivery side-effect hook (verdictDelivery.ts in production). */
  onVerdict?: OnVerdict;
  /** Shared lease pool override (tests). Defaults to a pool over the global mutex. */
  leasePool?: ResourceLeasePool;
  /**
   * The per-request hold unit (ms) the batch worktree-sync mutex's acquire
   * timeout is sized from. Defaults to DEFAULT_REQUEST_TIMEOUT_MS (5 min).
   */
  requestTimeoutMs?: number;
  /**
   * Injectable monotonic clock (ms) for the queued-age deadline and the
   * setup-proof drain promotion. Defaults to `Date.now`. Tests pass a
   * controllable clock to exercise those boundaries without real waits.
   */
  now?: () => number;
  /**
   * The verification-AGENT engine (redesign §5.4). When a run's stamped
   * `verify_chain` is `['agent']`, the scheduler routes its requests to THIS runner
   * (snapshot build → deploy the workflow-defined agent → validate → mutation-check
   * → teardown). Absent ⇒ an
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
   * (redesign §5.6), measured from max(enqueue, last drain progress) and
   * hard-capped at ceiling + 2 × AGENT_REQUEST_TIMEOUT_CEILING_MS from enqueue
   * (queuedAgeDeadline.ts). A row past it at drain time — i.e. it never acquired
   * a lease within the window — is terminalized 'skipped'
   * (fail-open, concrete lease reason) through the normal delivery path so a
   * merge-gate lane parked at awaiting-verify is never wedged behind a starved
   * request. Defaults to config.queuedAgeCeilingMs (15 min). Tests pass a small
   * value to exercise the boundary.
   */
  queuedAgeCeilingMs?: number;
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
   * §A7 drift finding — files the non-blocking "runbook needs re-proving, lanes
   * explore meanwhile" notice the bootstrap preflight raises. Injected for the
   * same standalone-typecheck reason as {@link capabilityFinding}; the concrete
   * implementation is verdictDelivery's `createExploreStaleProofFinding`.
   * Absent ⇒ no finding.
   */
  staleProofFinding?: (finding: ExploreStaleProofFinding) => void | Promise<void>;
  /**
   * §A5 "learn from success" notices (recipe learned / learned recipe promoted
   * / suggested runbook entry). Injected for the same standalone-typecheck
   * reason as {@link capabilityFinding}; the concrete implementation is
   * verdictDelivery's `createRunbookLearningFinding`. Absent ⇒ no finding.
   */
  runbookLearningFinding?: RunbookLearningFindingFn;
  /**
   * §4 roster — whether this host can capture the screen at all, the ONE gate
   * that decides whether a `native-screen` request is deployable. The intended
   * (and verifyComposition.ts-wired) implementation is
   * `PeekabooGrantProbe.healthCheck()`: binary-on-PATH AND both macOS TCC
   * grants, never-throws, exactly as §4 "Driver additions for native-screen"
   * prescribes.
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
   * `mobileToolchainDetail` in ./mobileGates.
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

/**
 * The arguments of the two enqueue-side revision resolvers
 * ({@link VerificationScheduler.resolveProvenRunbook} and its §A5 twin
 * `resolveLearnedDraft`). `probePath` is the caller's own worktree when it has
 * one (skips the run-row lookup); absent ⇒ the run's worktree, else the
 * project root.
 */
export interface RunbookRevisionArgs {
  projectId: number;
  runId: string;
  modality: VerificationModality;
  probePath?: string;
}

/** The §3.4 circuit-breaker notice seam — see {@link VerificationSchedulerDeps.capabilityFinding}. */
export type CapabilityBreakerFindingFn = (args: {
  projectId: number;
  runId: string;
  modality: VerificationModality;
  /** The env-failure reason that tripped the breaker (the last terminal's evidence). */
  reason: string;
}) => void | Promise<void>;
