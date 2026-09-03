/**
 * VerificationAgentRunner — deploys the workflow-defined `visual-verify` agent
 * for ONE verification request (docs/proposals/verification-agent-redesign.md
 * §5.4). It is the replacement for the capture-backend + VLM-judge core: instead
 * of the scheduler capturing a screenshot and a VLM judging it, the runner hands
 * a provisioned environment to a single Claude SDK session that BUILDS, SERVES,
 * DRIVES, and JUDGES a composed `VerificationTaskV1` itself, returning a
 * structured `VerificationReportV1`.
 *
 * Electron-free by construction (mirrors the backends / vlmJudge): every
 * side-effecting collaborator is INJECTED — the SDK boundary (`query`), the
 * effective-agent + model resolvers, snapshot provisioning, git checks, fs
 * probes, and the driver-teardown seams all have real defaults but are faked in
 * the unit test, so the module under test imports NO `@anthropic-ai/*` SDK,
 * `electron`, or `better-sqlite3`. The scheduler owns the leases, the per-request
 * deadline, the budget, and persisting the terminal status + `report_json`; this
 * module owns steps 1-6 of §5.4 (resolve → provision → deploy → validate →
 * mutation-check → teardown) and returns the mapped verdict.
 *
 * Provider dispatch (§5.4 step 1): the resolved agent's runtime picks the query
 * seam. An explicit `runtime: 'codex-sdk'` pin — or an unpinned agent inheriting a
 * Codex-provider run — routes to the injected `codexQuery`; a CLAUDE runtime
 * routes to the Claude `query`. On the Claude branch model resolution is
 * Claude-namespace-only (a pinned alias → concrete, else the Claude-provider run
 * model, else a validated Claude default). On the Codex branch the model is
 * `agent.providerModel` (normalized `providerModel ?? codexModel` upstream by
 * effectiveAgents, so either field reads the same value), else the
 * Codex-provider run model, else the account default the query resolves.
 *
 * ANY non-Claude provider with no wired query seam — Codex without `codexQuery`,
 * and every provider that has no verify seam at all (OMP today: its T3 tier is
 * deliberately a later phase) — maps to the fail-open `skipped` bucket with an
 * actionable message. Never a silent Claude fallback: a verifier that quietly
 * ran on the wrong provider would report a verdict nobody asked for.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, chmod, access, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { LoggerLike } from '../types';
import { emitSeamError } from '../telemetrySink';
import { resolveGitCommand } from '../../utils/gitExeFinder';
import { cmdCommandLine, cmdExeInvocation } from '../../utils/win32CmdLine';
import {
  type VerificationTaskV1,
  type VerificationReportV1,
  type VerdictV1,
  type RequestStatus,
  type VerificationModality,
  type VerificationType,
  type AttestationSpec,
  normalizeVerificationReportV1,
  resolveTaskModality,
} from '../../../../shared/types/visualVerification';
import { verifyTranscriptFileName } from '../../../../shared/types/artifacts';
import type { AgentModelAlias } from '../../../../shared/types/agents';
import { providerForRuntime, type AgentProvider } from '../../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import type { EffectiveAgent } from '../agents/effectiveAgents';
import {
  provisionSnapshot,
  SnapshotProvisionError,
  type SnapshotProvision,
  type ProvisionSnapshotOptions,
} from './snapshotProvisioner';
import { runAgentPreflight, type AgentPreflightResult } from './preflight';
import type { PinnedRunbookRecord } from './runbookStore';
import type {
  VerifyRunbookModality,
  VerifyRunbookModalityEntry,
  VerifyRunbookV1,
} from '../../../../shared/types/verifyRunbook';
import { resolveLeverEnv } from './runbookLevers';
import { canonicalJsonStringify } from '../agentThread/specHash';
import {
  createDefaultDriverDeps,
  evaluateOverCdp,
  extractWindowTitles,
  peekabooListWindowsArgs,
  pidFilePath,
  probeChromiumExecutable,
  servePidFilePath,
  DEFAULT_PEEKABOO_BIN,
  PEEKABOO_TIMEOUT_MS,
} from './driver/driverCore';
import {
  performHarnessAttestation,
  type HarnessAttestationDeps,
  type HarnessAttestationResult,
} from './harnessAttestation';

const execFileAsync = promisify(execFile);

/** The hard tool ceiling the agent runs under — config can NEVER widen it (§5.4 step 3). */
export const VERIFY_AGENT_ALLOWED_TOOLS: readonly string[] = ['Bash', 'Read', 'Grep', 'Glob'] as const;

/** Subdir under VERIFY_ARTIFACTS_DIR holding the driver wrapper script (co-located with the driver's pid file). */
const DRIVER_STATE_DIR = '.driver';
/** The wrapper script the agent invokes as `$VERIFY_DRIVER` (a .cmd on Windows). */
const DRIVER_SCRIPT_NAME = process.platform === 'win32' ? 'verify-driver.cmd' : 'verify-driver.sh';

// ---------------------------------------------------------------------------
// SDK-query seam (the module under test injects a fake — NO SDK import here)
// ---------------------------------------------------------------------------

/** Args the runner hands the (production or fake) structured SDK query. */
export interface VerificationAgentQueryArgs {
  /** The composed user prompt (task JSON + framing). */
  prompt: string;
  /** The full custom system prompt (workflow instructions + immutable harness contract). */
  systemPrompt: string;
  /** cwd of the deployed session — the provisioned snapshot worktree (or the live worktree in fallback). */
  cwd: string;
  /** The resolved Claude model id (namespace-checked upstream). */
  model?: string;
  /** The hard tool ceiling — {@link VERIFY_AGENT_ALLOWED_TOOLS}. */
  allowedTools: string[];
  /** The VERIFY_* env the agent's Bash needs (merged onto process.env by the production impl). */
  env: Record<string, string>;
  /**
   * The scheduler's effective per-request deadline (adversarial-review fix). When
   * present the query uses THIS for its internal deadline instead of its own
   * default — so a task-supplied `timeoutMs` above the query default is honored
   * rather than silently cut to 10 minutes.
   */
  timeoutMs?: number;
  /** Deadline/cancel signal. */
  signal?: AbortSignal;
}

/**
 * The result of one deployed SDK session: the last `structured_output` (or null
 * on drain-without-result) PLUS the harness-accumulated transcript (markdown),
 * captured so a wrong verdict is auditable (verifier-transcript capture).
 */
export interface VerificationAgentQueryOutcome {
  /** The last structured_output (or null on drain-without-result). */
  structured: unknown;
  /** Harness-accumulated transcript of the session (markdown), or null when nothing accumulated. */
  transcript: string | null;
}

/**
 * The SDK boundary: deploy ONE structured session and return the outcome
 * (structured output + transcript). The production impl (verificationAgentQuery.ts)
 * bakes in the hermetic sandbox (`settingSources: []`, `strictMcpConfig`,
 * `mcpServers: {}`, `outputFormat: json_schema`); this seam carries only what the
 * runner controls so the runner stays SDK-free + fakeable.
 */
export interface VerificationAgentQueryFn {
  (args: VerificationAgentQueryArgs): Promise<VerificationAgentQueryOutcome>;
}

/**
 * Thrown by the production query on failure/timeout so a partial transcript
 * survives the throw (verifier-transcript capture) — the runner's catch writes it
 * fail-soft before mapping the error to the usual skipped/timeout result.
 */
export class VerificationAgentQueryError extends Error {
  readonly transcript: string | null;
  /**
   * True when the query's INTERNAL deadline fired (adversarial-review fix): the
   * runner maps a timed-out deploy to the terminal `timeout` status instead of the
   * fail-open `skipped` bucket, so a deadline expiry is not misreported as an
   * infra skip. A caller-signal abort is classified by the runner's own
   * `controller.signal.aborted` check, not this flag.
   */
  readonly timedOut: boolean;
  constructor(message: string, transcript: string | null, timedOut = false) {
    super(message);
    this.name = 'VerificationAgentQueryError';
    this.transcript = transcript;
    this.timedOut = timedOut;
  }
}

// ---------------------------------------------------------------------------
// Agent resolution (injected thunk)
// ---------------------------------------------------------------------------

/**
 * The resolved workflow-defined `visual-verify` agent plus the run's
 * provider/model — everything the runner needs to apply the Claude-namespace
 * model rule (§5.4 step 1). Built at index.ts over `resolveRunEffectiveAgents`.
 */
export interface ResolvedVerifyAgent {
  agent: EffectiveAgent;
  runProvider: AgentProvider;
  runModel: string | null;
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

/** One verification the runner deploys the agent for. */
export interface VerificationAgentRequest {
  runId: string;
  requestId: string;
  projectId: number;
  /** The composed task the agent drives + judges. */
  task: VerificationTaskV1;
  /** The run's live shared worktree — the snapshot source and the dirty-fallback cwd. */
  runWorktreePath: string;
  /** The git sha to snapshot at (§5.5); null ⇒ dirty-worktree fallback. */
  snapshotSha: string | null;
  /** VERIFY_ARTIFACTS_DIR — where the agent writes screenshots. */
  artifactsDir: string;
  /** The leased dev-server port, exported as VERIFY_PORT only when the task implies a server; else null. */
  verifyPort: number | null;
  /** The CDP port for the bundled driver (VERIFY_DRIVER_PORT) — always present. */
  verifyDriverPort: number;
  /**
   * The scheduler's effective per-request deadline in ms (`agentDeadlineMs`:
   * task.timeoutMs capped by the ceiling, else the default). Threaded into the
   * query so its internal deadline matches — absent (older callers/fakes) the
   * query falls back to its own default.
   */
  timeoutMs?: number;
  /**
   * The §4 roster modality this request runs under, when the SCHEDULER already
   * resolved one (it owns the `VerificationType` this module never sees — the
   * agent path historically "never consults verify_type", §3.3). OPTIONAL
   * today because that scheduler-side plumbing is a follow-up: when absent the
   * runner derives the modality from the task alone
   * ({@link resolveRequestModality}). A present value WINS — only the
   * scheduler can know a request is `native-desktop`/`mobile-flow`, which no
   * amount of task-shape inspection can recover.
   */
  modality?: VerificationModality;
  /**
   * §5.2 seam 3 — the CONTENT-ADDRESSED runbook pin stamped on the request row
   * at enqueue (migration 096 `runbook_hash`), when this request was composed
   * against a proven runbook. Present ⇒ the runner resolves exactly this
   * revision through {@link VerificationAgentRunnerDeps.resolveRunbookByHash}
   * and refuses to execute anything else (see
   * {@link VerificationAgentRunner.run}). Absent ⇒ no pin was taken — the
   * degenerate pre-live shapes that derive no environment — and the check does
   * not run.
   */
  runbookHash?: string;
  /**
   * The machine-local record's CAS version at enqueue, carried alongside
   * {@link VerificationAgentRequest.runbookHash} as PROVENANCE. On an ORDINARY
   * request it is deliberately NOT an independent reject condition:
   * `registerDraft` bumps the version on every re-registration, so re-registering
   * byte-identical content would fail a version equality check while the thing
   * that actually matters — the commands about to run — is unchanged. Content
   * equality is the invariant there; the version is how a human reconstructs
   * which revision produced which verdict.
   *
   * On a {@link VerificationAgentRequest.setupProof} request it IS a reject
   * condition — see {@link checkRunbookPin}. The asymmetry is the point: an
   * ordinary request only needs the commands to match, whereas a proof run's
   * whole output is an attestation ABOUT one specific record revision, and an
   * attestation naming a revision that has already been superseded is false
   * rather than merely stale.
   */
  runbookLocalVersion?: number;
  /**
   * §3.6/§5.3 — this request is the SETUP FLOW's proof run (the request row's
   * `setup_proof` column), not ordinary lane traffic. The runner needs it for
   * exactly one decision: which half of {@link checkRunbookPin}'s revision check
   * applies. A proof run legitimately executes against an `'unproven-draft'`
   * record (proving it is the entire point, so requiring `'proven'` would
   * deadlock the bootstrap), and in exchange it must pin to the EXACT record
   * version it was enqueued against.
   */
  setupProof?: boolean;
  /** The scheduler's per-request deadline/cancel signal. */
  signal: AbortSignal;
}

/** The mapped verdict the scheduler persists (§5.7). */
export interface VerificationAgentRunResult {
  status: Extract<RequestStatus, 'passed' | 'failed' | 'skipped' | 'timeout' | 'low_confidence'>;
  /** Present for a judged outcome (passed/failed/low_confidence); build/launch failures are verdict-less. */
  verdict?: VerdictV1;
  /** The normalized report (persisted as report_json), when one was produced + validated. */
  report?: VerificationReportV1;
  /** Concrete reason for skipped/timeout, or the build/launch log excerpt for a build failure. */
  errorMessage?: string;
  /** The screenshot fileNames for the artifact payload. */
  fileNames: string[];
  /**
   * Whether an SDK agent session was ACTUALLY deployed for this request
   * (docs/proposals/verification-setup-flow.md §3.6, budget accounting). REQUIRED
   * — the scheduler charges `judge_calls_used` off THIS flag rather than off
   * "we got as far as calling the runner", so the §3.5 pre-deploy preflight (and
   * the other genuinely pre-deploy exits: an unresolvable agent, a failed
   * snapshot provision, an abort before deploy) cannot burn a project's lifetime
   * verification budget on work that never spent a token. `true` from the moment
   * the query seam is invoked — INCLUDING a query that then threw, since that
   * session was deployed and did consume budget.
   */
  deployed: boolean;
  /**
   * The §3.5 pre-deploy preflight result, when preflight ran (it always does on
   * this path today). The scheduler persists it to `preflight_json` and feeds it
   * to the §3.1 classifier as the EVIDENCE BASE for an `'env'` verdict — a
   * failure with no failed preflight check has no harness-derived provenance and
   * stays conservatively `'ambiguous'` (blocking).
   */
  preflight?: AgentPreflightResult;
  /**
   * How the code under test was provisioned: `'snapshot'` (the normal detached
   * worktree at the recorded sha) or `'fallback'` (the dirty live worktree).
   * Absent when provisioning never started. The §3.1 classifier reads this: only
   * a JUDGED `'snapshot'`-mode failure may be classified `'deliverable'`, because
   * a degraded provisioning path cannot attest to the deliverable's own health.
   */
  provisionMode?: 'snapshot' | 'fallback';
  /**
   * §5.2 seam 3 — this result is the PIN REJECTION: the request carried a
   * runbook pin the runner could not resolve, or resolved to content the
   * composed task no longer matches, so nothing was executed. The scheduler
   * feeds this straight into the §3.1 classifier's `runbookMismatch` input,
   * which makes the terminal `'env'`-class with a `'runner'`-source evidence
   * entry — an ADVANCING skip that never charges the lane's retry budget,
   * because there is no defect here to retry against.
   */
  runbookMismatch?: boolean;
  /**
   * This `'skipped'` came from a CONNECT-LEVEL transport failure of the deployed
   * session — the SDK layer threw (a {@link VerificationAgentQueryError}, a
   * socket reset, a 5xx) before the session produced ANY transcript — rather
   * than from anything the agent said.
   *
   * It exists for ONE consumer: the scheduler's §3.1 gate-integrity guard
   * (`settleAgentTerminal`), which converts a deployed-but-unexplained
   * `'skipped'` into a blocking `'failed'`. That guard must NOT fire here, and
   * the guard cannot tell the difference on its own: a transport skip and a
   * model-authored skip both arrive classified `'ambiguous'` with no report. The
   * distinction is real and it is harness-owned — the exception was raised by
   * OUR code, so no amount of model content can manufacture it — so the runner
   * states it explicitly rather than leaving the scheduler to infer it from an
   * error string.
   *
   * NARROWED TO AN EMPTY SESSION (round-3 finding 4). "Our code raised it" is
   * not by itself enough to make the flag safe, because the agent can REACH our
   * code: it holds `Bash`, and a session that kills its own SDK process (or
   * wedges it until the deadline fires) produces exactly this exception. The
   * flag therefore requires the session to have accumulated NOTHING — no
   * transcript at all — which is the shape only a genuine connect-level failure
   * has. See {@link TRANSPORT_MID_SESSION_MESSAGE} for what happens to the
   * mid-session case and why.
   */
  transportFailure?: boolean;
}

/**
 * The narrow shape the scheduler injects + calls (mirrors how the capture backends
 * are injected as an interface, not the concrete class). Keeping the scheduler dep
 * an interface lets tests pass a plain stub — {@link VerificationAgentRunner} has a
 * private field, so a class type would be nominal + un-stubbable.
 */
export interface VerificationAgentRunnerLike {
  run(req: VerificationAgentRequest): Promise<VerificationAgentRunResult>;
}

// ---------------------------------------------------------------------------
// Injected deps
// ---------------------------------------------------------------------------

export interface VerificationAgentRunnerDeps {
  query: VerificationAgentQueryFn;
  /**
   * The Codex-runtime query seam, dispatched to when the resolved agent's provider
   * is `codex` (a `runtime: 'codex-sdk'` pin or an unpinned agent inheriting a
   * Codex-provider run). ABSENT ⇒ a codex-routed request maps to the fail-open
   * `skipped` bucket with an actionable message — never a silent Claude fallback.
   */
  codexQuery?: VerificationAgentQueryFn;
  resolveVerifyAgent: (runId: string) => ResolvedVerifyAgent | undefined;
  /** Alias→concrete Claude model id (wraps `bareModelId` at index.ts); null when unresolvable. */
  resolveClaudeAlias: (alias: AgentModelAlias) => string | null;
  /** The validated Claude fallback model (reuse the vlm/eval default source). */
  claudeDefaultModel: string;
  /** Resolve the node executable for the driver wrapper (wraps `findNodeExecutable`). */
  resolveNode: () => Promise<string>;
  /** Absolute path to the compiled driverCli.js (resolved at index.ts for dev + asar). */
  driverCliPath: string;
  logger?: LoggerLike;
  // -- seams (real defaults; faked in tests) --
  /**
   * §3.5 preflight probe: resolve a launchable chromium binary, or `null` when
   * none is installed. Defaults to the driver's OWN resolution
   * (`driverCore.probeChromiumExecutable`, LAZILY imported so this module keeps
   * its no-playwright-at-module-scope posture) — deliberately the same function
   * the driver's launch fallback calls, so the preflight verdict and the driver's
   * later behavior can never disagree.
   */
  resolveChromium?: () => Promise<string | null>;
  /**
   * §3.5 preflight probe: `true` when nothing is listening on `port`. The REAL
   * implementation is injected from index.ts — the very same TCP connect probe
   * the scheduler's agent teardown uses to decide release-vs-quarantine, so
   * "occupied" means the identical thing at both ends of a request. Defaults to
   * always-free, which makes the check a harmless no-op under test and on any
   * deployment wired without a net probe (fail-open: an unprobed port must never
   * be affirmative evidence of a squatter).
   */
  portFreeProbe?: (port: number) => Promise<boolean>;
  /**
   * §3.5 preflight probe for the `native-screen` modality only: `true` when
   * this host can actually capture the screen (the retired
   * `peekabooBackend.healthCheck()` — binary present AND both TCC grants —
   * is the intended wiring, §4 "Driver additions"). ABSENT means the check
   * does not run at all rather than fails: the scheduler-side gate already
   * refuses a `native-screen` request on a host with no capability probe, so
   * a second, evidence-free failure here would only add noise.
   */
  nativeCaptureProbe?: () => Promise<boolean>;
  /**
   * The peekaboo binary exported as `VERIFY_PEEKABOO_BIN` for a
   * `native-screen` request (the driver's `attest window` /
   * `native-screenshot` commands shell it).
   *
   * MUST be the same binary the capability gate probed. `index.ts` resolves it
   * once (`verifyPeekabooPath`) and hands it to both this runner and the
   * `PeekabooBackend` behind `nativeCaptureProbe` — because a gate measuring
   * one binary while the driver runs another affirms a capability that then
   * fails deep inside a deployed run, after the count-1 screen lease and the
   * budget have already been spent.
   *
   * Defaults to the bare `peekaboo` PATH name, which is only right when the
   * probe side has no bundled copy either. `driverCore` cannot resolve the
   * bundled path itself — it is node-builtins-only by design and never imports
   * Electron — so this dep is the sole channel.
   */
  peekabooBin?: string;
  /**
   * PERFORM the §7.1 identity probe against the still-live surface — the ONLY
   * attestation evidence the floor accepts. Defaults to
   * {@link performHarnessAttestation} wired to real HTTP/CDP/peekaboo probes;
   * tests inject a thunk.
   *
   * WHY THIS IS A VERB AND NOT A READ. It used to be `readAttestFile`, pointed
   * at `<artifactsDir>/.driver/attest.json`, on the reasoning that a model
   * "cannot forge a file only the driver CLI writes". The agent has `Bash` and
   * owns `VERIFY_ARTIFACTS_DIR`, so it could — one redirect produced a perfect
   * record for a channel that never ran, and the nonce could not help because
   * the nonce is exported into the agent's OWN environment. Attestation is now
   * something the HARNESS DOES, over sockets the agent does not mediate;
   * nothing under `VERIFY_ARTIFACTS_DIR` carries evidentiary weight for
   * identity any more.
   */
  attest?: (
    spec: AttestationSpec,
    args: { verifyPort: number | null; driverPort: number; nonce: string },
  ) => Promise<HarnessAttestationResult>;
  /**
   * §7.1 SERVE-IDENTITY BINDING, probe 0 of 3: read the pid the driver's
   * `serve` command recorded for the detached process-GROUP leader it started
   * (`<artifactsDir>/.driver/serve.pid`). `null` when the file is absent or
   * unparseable.
   *
   * This is a CLAIM, not evidence — the file sits in agent-writable space. It
   * is the only thing the two KERNEL probes below can be checked against, which
   * is the whole design: a forged value cannot change who the kernel says owns
   * the port, so a forgery can only make the binding FAIL. See
   * {@link checkServeIdentityBinding}.
   */
  readServePid?: (artifactsDir: string) => Promise<number | null>;
  /**
   * §7.1 SERVE-IDENTITY BINDING, probe 1 of 3 (KERNEL TRUTH): which pid is
   * LISTENING on `port` (real default: `lsof -ti tcp:<port> -sTCP:LISTEN`), or
   * `null` when nothing is listening / the probe could not answer.
   *
   * `null` FAILS the binding rather than skipping it. That is the opposite of
   * this file's usual fail-open default, and deliberately so: the binding only
   * ever runs on the PASS path of a task that declared a port-mediated
   * attestation channel, so "we could not see who owns the port" is precisely
   * the unproven-identity case §7.1 refuses to let through.
   */
  listeningPidForPort?: (port: number) => Promise<number | null>;
  /**
   * §7.1 SERVE-IDENTITY BINDING, probe 2 of 3 (KERNEL TRUTH): one process's
   * group id and command line (real default: `ps -o pgid=,command= -p <pid>`),
   * or `null` when the pid is gone.
   *
   * ONE probe rather than the two `ps` invocations the review described, because
   * both facts come from one `ps` row and the binding needs a different fact from
   * each of two DIFFERENT pids — the port's listener (its group) and the recorded
   * leader (its command line). Splitting it per-field would double the process
   * spawns without narrowing anything.
   */
  processInfo?: (pid: number) => Promise<{ pgid: number; command: string } | null>;
  /**
   * §5.2 seam 3 — resolve the machine-local runbook record for
   * (project, modality) by the CONTENT HASH pinned on the request row. Wired at
   * index.ts to {@link VerifyRunbookStore.getByHash}; a `null` answer is the
   * MISMATCH condition itself (the pinned revision no longer resolves), not a
   * lookup to retry.
   *
   * ABSENT ⇒ the pin check does not run at all, rather than failing. A pin with
   * no resolver is a WIRING gap, not evidence that the runbook drifted, and
   * rejecting every pinned request on a deployment that simply never injected
   * the store would be a whole-feature outage dressed up as a safety property.
   * (index.ts always wires it; the absent case is legacy/test.)
   */
  resolveRunbookByHash?: (
    projectId: number,
    modality: VerificationModality,
    hash: string,
  ) => PinnedRunbookRecord | null;
  provision?: (opts: ProvisionSnapshotOptions) => Promise<SnapshotProvision>;
  /** `git diff --quiet HEAD` on the snapshot — true when the verifier mutated tracked sources. */
  checkSnapshotMutated?: (worktreePath: string) => Promise<boolean>;
  fileExists?: (absPath: string) => Promise<boolean>;
  /** Write the `$VERIFY_DRIVER` wrapper script; returns its absolute path. */
  writeDriverScript?: (artifactsDir: string, nodePath: string, driverCliPath: string) => Promise<string>;
  /** Best-effort `$VERIFY_DRIVER stop`. */
  stopDriver?: (driverScriptPath: string, env: Record<string, string>) => Promise<void>;
  /** Best-effort SIGKILL of the driver's recorded browser pid, if still alive. */
  reapBrowser?: (artifactsDir: string) => void;
  /**
   * Best-effort SIGKILL of the process GROUP the driver's `serve` command
   * started, if still alive. Runs at teardown, strictly AFTER the attestation
   * probe — the surface has to be alive to be proven.
   */
  reapServe?: (artifactsDir: string) => void;
  /**
   * Write the harness-captured transcript to `<artifactsDir>/<fileName>` (creating
   * the directory as needed). Injected so tests can assert the call without
   * touching disk; a failure here is ALWAYS fail-soft (logged, never changes the
   * verdict path — see {@link VerificationAgentRunner.run}).
   */
  writeTranscript?: (artifactsDir: string, fileName: string, content: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Immutable harness contract (config shapes persona/judgment, NEVER the sandbox)
// ---------------------------------------------------------------------------

/**
 * The head of the harness contract (environment + framing) — shared verbatim
 * across the Claude and Codex variants. Ends at the `Rules:` label; the
 * provider-specific rules block and the shared tail complete the contract.
 */
const VERIFY_CONTRACT_HEAD = `
=== VERIFICATION HARNESS CONTRACT (immutable) ===
You are a visual-verification agent deployed by cyboflow. You run in a git worktree
checked out at the code under test. Your job: build/serve the deliverable, drive its
UI, capture screenshots at meaningful states, and JUDGE each requested behavior
against its expected result — then return ONE structured report.

Environment (already set for your Bash tool):
- VERIFY_ARTIFACTS_DIR — write every screenshot here (bare filenames, no subdirs).
- VERIFY_DRIVER — a CLI you drive the headless browser with. Subcommands:
    "$VERIFY_DRIVER" serve '<command>'                    # starts the serve/app, detached
    "$VERIFY_DRIVER" goto <url>
    "$VERIFY_DRIVER" click <selector>
    "$VERIFY_DRIVER" type <selector> <text...>
    "$VERIFY_DRIVER" screenshot <name> [--viewport WxH]   # writes to VERIFY_ARTIFACTS_DIR
    "$VERIFY_DRIVER" native-screenshot <name> [--app <appTarget>]  # OS-screen capture
    "$VERIFY_DRIVER" attest http <urlPath>
    "$VERIFY_DRIVER" attest dom <selector>
    "$VERIFY_DRIVER" attest cdp <expression> <expected>
    "$VERIFY_DRIVER" attest window <titlePattern>
  All driver commands act on ONE persistent browser page across invocations.
- VERIFY_PORT — when present, bind your dev/preview server to THIS port (the task's
  serve command references it). When absent, the task points at an already-live target.
- VERIFY_ATTEST_NONCE — a per-request secret. It is what makes an attestation mean
  something: the surface must hand this exact value back (in the attest http
  response body, or in the attest dom element's text / data-verify-nonce
  attribute) when the HARNESS asks it, after you finish. A port answering, or a
  page rendering, proves nothing on its own — a stale server or the user's own
  running app answers too. Your job is to make the deliverable's serve step carry
  the nonce, not to report on it: you hold this value yourself, so you repeating
  it back could never prove anything.
- VERIFY_MODALITY — "web" | "cdp-app" | "native-screen" | "mobile".
- CDP-attach mode — when the task's serve has "attach": "cdp", its serve command
  launches the deliverable APP ITSELF exposing a DevTools endpoint on
  VERIFY_DRIVER_PORT (e.g. --remote-debugging-port="$VERIFY_DRIVER_PORT"). Start it
  the same way ("$VERIFY_DRIVER" serve '<that command>'), wait for the app window to
  be up, then drive with the SAME driver subcommands — the driver attaches to the
  app's own web-view (no separate browser, and usually no goto: the app window is
  already the surface under test).

STARTING THE SERVE/APP — AND LEAVING IT RUNNING:
- Start the task's serve command (or, in CDP-attach mode, the app itself) with
    "$VERIFY_DRIVER" serve '<the task's serve command, with \${PORT} substituted>'
  It returns immediately, having started the command detached and recorded it for
  the harness. You then poll readiness exactly as before; its output is captured at
  "$VERIFY_ARTIFACTS_DIR/.driver/serve.log" (tail that for a launch_failed excerpt).
  Do NOT background the command yourself with & or nohup.
- THE SERVE COMMAND MUST BE THE TASK'S, EXACTLY. Pass the task's serve.cmd string
  verbatim; substituting \${PORT} with the value of $VERIFY_PORT is the ONLY edit
  allowed. The harness binds the port that answers the attestation to the process
  group this command started, and reads that group's command line back from the OS:
  a substitute command, a wrapper script, a hand-rolled background job, a serve
  started outside "$VERIFY_DRIVER" serve, or a second serve replacing the first all
  fail identity binding, and an unbound surface FAILS the task exactly like an
  unattested one. Serving something else that echoes the nonce proves nothing —
  the nonce is in YOUR environment, so anything you start can repeat it.
- WHEN YOU FINISH, LEAVE EVERYTHING RUNNING. Do not kill the serve, do not kill the
  app, do not run "$VERIFY_DRIVER" stop. The harness verifies the surface's identity
  against the LIVE app after you finish, then tears everything down itself. A surface
  you shut down cannot be attested and the task will FAIL.

ATTESTATION (the harness proves identity; you cannot):
- Whenever the task carries an "attestation" object, the HARNESS runs that channel
  itself — after your session ends, against the still-live surface, before teardown.
  Nothing you write anywhere, including under VERIFY_ARTIFACTS_DIR, counts as proof:
  a file in your own working space proves only that you can write files. A pass the
  harness cannot independently attest is rejected as unproven, whatever your
  screenshots or your report say.
- The attest subcommands are SELF-CHECK aids, and worth running: kind "http-endpoint"
  → attest http <urlPath>; "dom-marker" → attest dom <selector>; "cdp-token" →
  attest cdp <expression> <expected>; "window-identity" → attest window
  <titlePattern>. A failure tells you your serve step is wrong (a stale process, the
  user's own app, a missing marker route) while you can still fix it and re-serve —
  which is exactly when that information is useful. Running one is never what makes
  the attestation count, and skipping one never makes it fail.
- You may echo what you saw in the report's optional "attestation" field
  ({ "verified": bool, "kind": "...", "detail": "..." }) — that is for humans reading
  the verdict; it is never treated as proof.

NATIVE-SCREEN IS OBSERVE-ONLY:
- When VERIFY_MODALITY is "native-screen" the goto/click/type/screenshot commands are
  REFUSED (driving a native surface has no supported path yet). Use
  native-screenshot to capture and attest window to prove identity. Any behavior you
  cannot exercise without driving MUST be reported "not_testable" — never guessed.

Rules:
`;

/** The Claude-runtime rules block — the tool ceiling is Bash/Read/Grep/Glob and
 * screenshots are viewed via the Read tool. */
const VERIFY_CONTRACT_CLAUDE_RULES = `- Use ONLY Bash, Read, Grep, Glob. You have NO Write/Edit and NO MCP tools. Do not
  attempt to modify tracked source files — you are JUDGING code, not changing it.
- Run the task's build steps first. If the build or the server launch fails, set
  outcome to "build_failed" / "launch_failed" and put the failing log tail in
  buildLogExcerpt — do not fabricate screenshots.
- Read your own screenshots (Read renders PNGs) and judge each behavior honestly.
  Mark a behavior "not_testable" when you genuinely could not exercise it; never
  guess a pass.
`;

/** The Codex-runtime rules block — the enforcement is the shell + view_image (no
 * Bash/Read tool ceiling), and there are no MCP tools on this runtime. */
const VERIFY_CONTRACT_CODEX_RULES = `- Use ONLY your shell and view_image tools. View each screenshot you capture with
  view_image and judge it honestly. You have NO MCP tools. Do not modify tracked
  source files — you are JUDGING code, not changing it.
- Run the task's build steps first. If the build or the server launch fails, set
  outcome to "build_failed" / "launch_failed" and put the failing log tail in
  buildLogExcerpt — do not fabricate screenshots.
- Mark a behavior "not_testable" when you genuinely could not exercise it; never
  guess a pass.
`;

/** The tail of the harness contract (the required output schema) — shared verbatim. */
const VERIFY_CONTRACT_TAIL = `
Return a VerificationReportV1 as the structured output:
{
  "version": 1,
  "behaviors": [{ "id": "<echoes the task behavior id>",
                  "result": "pass" | "fail" | "not_testable",
                  "evidence": { "screenshots": ["shot.png"], "notes": "..." } }],
  "screenshots": [{ "fileName": "shot.png", "caption": "..." }],
  "outcome": "pass" | "fail" | "build_failed" | "launch_failed",
  "buildLogExcerpt": "<required when outcome is build_failed/launch_failed>",
  "confidence": 0.0-1.0,
  "feedback": "<one-paragraph human summary>",
  "issues": [{ "severity": "low"|"medium"|"high", "description": "...", "fileName": "shot.png" }],
  "attestation": { "verified": true, "kind": "http-endpoint", "detail": "<what you saw>" }
}
Every screenshots[].fileName MUST be a file you actually wrote to VERIFY_ARTIFACTS_DIR.
=== END HARNESS CONTRACT ===`;

/**
 * Appended to the workflow-defined system prompt at deploy time (§5.4 step 3).
 * Restates the environment, the required output schema, and the prohibitions the
 * sandbox enforces — so an edited/overridden prompt can shape HOW the agent judges
 * but never what environment it believes it has or what it is allowed to do. Built
 * from the shared head/tail + the CLAUDE rules block so the Claude and Codex
 * variants cannot drift in their environment/schema framing.
 */
export const VERIFY_HARNESS_CONTRACT =
  VERIFY_CONTRACT_HEAD + VERIFY_CONTRACT_CLAUDE_RULES + VERIFY_CONTRACT_TAIL;

/**
 * The Codex-runtime harness contract — identical head/tail to
 * {@link VERIFY_HARNESS_CONTRACT}, with the Codex rules block (shell + view_image,
 * no Bash/Read tool ceiling) swapped in.
 */
export const VERIFY_HARNESS_CONTRACT_CODEX =
  VERIFY_CONTRACT_HEAD + VERIFY_CONTRACT_CODEX_RULES + VERIFY_CONTRACT_TAIL;

/** Pick the harness contract for the resolved provider (§5.4 step 3). */
export function verifyHarnessContract(provider: AgentProvider): string {
  return provider === 'codex' ? VERIFY_HARNESS_CONTRACT_CODEX : VERIFY_HARNESS_CONTRACT;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Normalize an INHERITED Claude run model exactly like the standard spawn seam
 * (`resolveAgentModelAlias('claude', …)` in agentModelContext): the persisted
 * picker sentinel `'auto'` (any case), `'default'`, blanks, and a cross-family id
 * all mean "no explicit model".
 *
 * `'auto'` is a real stored value, not a defensive hypothetical — migration 037
 * defines `workflow_runs.model` as "NULL/'auto' = SDK default" and the config
 * default IS `'auto'`. Forwarding it verbatim fails the deployment outright
 * ("There's an issue with the selected model (auto)"), which is exactly how it
 * reached production. The Codex branch has guarded this since the adversarial
 * review; the Claude branch had no equivalent.
 */
function normalizeClaudeModelSelection(value: string | null | undefined): string | undefined {
  const normalized = normalizeAgentModelSelection('claude', value);
  if (!normalized || normalized.toLowerCase() === 'auto') return undefined;
  return normalized;
}

/**
 * The CLAUDE branch of the provider dispatch (§5.4 step 1): Claude-namespace-only
 * model resolution, reached when {@link resolveVerifyProvider} returns `claude`. A
 * pinned alias resolves through the injected alias→concrete mechanism; an unpinned
 * agent inherits the run model ONLY on a Claude-provider run, and only once that
 * value survives {@link normalizeClaudeModelSelection}; otherwise the validated
 * Claude default. The result is ALWAYS a concrete-or-alias Claude selection the
 * SDK accepts — never a picker sentinel, and never a `gpt-*` id.
 */
export function resolveVerifyModel(
  resolved: ResolvedVerifyAgent,
  resolveClaudeAlias: (alias: AgentModelAlias) => string | null,
  claudeDefaultModel: string,
): string {
  const { agent, runProvider, runModel } = resolved;
  if (agent.model !== null) {
    return resolveClaudeAlias(agent.model) ?? claudeDefaultModel;
  }
  if (runProvider === 'claude') {
    const inherited = normalizeClaudeModelSelection(runModel);
    if (inherited) return inherited;
  }
  return claudeDefaultModel;
}

/**
 * The provider the verifier deploys on (§5.4 step 1). An explicit agent runtime pin
 * wins (`providerForRuntime` maps each runtime to its owner via the shared prefix
 * registry); an unpinned agent inherits the RUN provider — so an unpinned
 * visual-verify on a Codex-provider run resolves to Codex.
 */
export function resolveVerifyProvider(resolved: ResolvedVerifyAgent): AgentProvider {
  return resolved.agent.runtime ? providerForRuntime(resolved.agent.runtime) : resolved.runProvider;
}

/**
 * Normalize one Codex model selection exactly like the standard spawn seam
 * (`resolveAgentModelAlias('codex', …)` in agentModelContext — adversarial-review
 * fix): the persisted picker sentinel `'auto'` (any case), `'default'`, blanks, and
 * a cross-family Claude id all mean "no explicit model" — forwarding `'auto'`
 * verbatim to `turn/start` breaks the deployment.
 */
function normalizeCodexModelSelection(value: string | null | undefined): string | undefined {
  const normalized = normalizeAgentModelSelection('codex', value);
  if (!normalized || normalized.toLowerCase() === 'auto') return undefined;
  return normalized;
}

/**
 * The CODEX branch model (§5.4 step 1), reached when {@link resolveVerifyProvider}
 * returns `codex`. A pinned `agent.providerModel` (normalized `providerModel ??
 * codexModel` upstream, so either field carries the same value) wins; else the
 * run model when the run itself is Codex; else `undefined` — the Codex query
 * then resolves the account's default model. Both sources pass through
 * {@link normalizeCodexModelSelection}, so an `'auto'`/`'default'` sentinel (or a
 * cross-family id) falls through rather than reaching the query verbatim.
 */
export function resolveVerifyCodexModel(resolved: ResolvedVerifyAgent): string | undefined {
  const { agent, runProvider, runModel } = resolved;
  const pinned = normalizeCodexModelSelection(agent.providerModel ?? agent.codexModel);
  if (pinned) return pinned;
  if (runProvider === 'codex') return normalizeCodexModelSelection(runModel);
  return undefined;
}

/**
 * The `VerificationType` fed to {@link resolveTaskModality} when the runner
 * must DERIVE a modality from the task alone. `VerificationAgentRequest`
 * carries no type today (the agent dispatch path "never consults verify_type",
 * §3.3), and the resolver only uses the type to short-circuit the two
 * modalities a task shape cannot express — `native-desktop` → `native-screen`
 * and `mobile-flow` → `mobile`. Passing a web-shaped type therefore hands the
 * decision entirely to the `serve.attach === 'cdp'` discriminant, which IS
 * derivable, and leaves the two undertermined modalities to the explicit
 * declaration channels (`req.modality` from the scheduler, `task.modality`
 * from the composer).
 */
const MODALITY_DERIVATION_TYPE: VerificationType = 'interactive-web-behavior';

/**
 * Resolve the §4 roster modality for one request, in precedence order:
 * the SCHEDULER's explicit `req.modality` (it owns the request row's
 * `VerificationType`, the only source that can say `native-screen`/`mobile`),
 * then the COMPOSER's `task.modality` declaration, then the task-shape
 * derivation.
 *
 * A declared `web`/`cdp-app` that disagrees with the derivation is LOGGED, not
 * corrected: the two channels are meant to agree, and a silent override in
 * either direction would hide a composer bug (a `cdp-app` task composed with
 * no `attach: 'cdp'` serve drives the wrong surface; a `web` declaration on an
 * attach task launches a blank chromium). A declared `native-screen`/`mobile`
 * NEVER logs a mismatch — those are structurally underivable from a task, so
 * the "disagreement" carries no information.
 */
export function resolveRequestModality(
  req: Pick<VerificationAgentRequest, 'modality' | 'task'>,
  logger?: LoggerLike,
): VerificationModality {
  const derived = resolveTaskModality(MODALITY_DERIVATION_TYPE, req.task);
  const declared = req.modality ?? req.task.modality;
  if (declared === undefined) return derived;
  if ((declared === 'web' || declared === 'cdp-app') && declared !== derived) {
    logger?.warn('[VerificationAgentRunner] declared modality disagrees with the composed task shape', {
      declared,
      derived,
      attach: req.task.serve?.attach ?? null,
    });
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Runbook pin validation (§5.2 seam 3 — "the runner executes exactly that
// revision and rejects on any mismatch")
// ---------------------------------------------------------------------------

/**
 * The prefix every pin rejection's `errorMessage` carries. Exported so the
 * scheduler's tests and any future health-panel grouping can key on the exact
 * string the proposal names ("structured 'runbook/sha mismatch' feedback").
 */
export const RUNBOOK_MISMATCH_PREFIX = 'runbook/sha mismatch';

/**
 * The three fields of a runbook modality entry that decide HOW the deliverable
 * is stood up and how its identity is proven — i.e. everything the runner would
 * actually EXECUTE. Compared structurally (not by reference or key order) via
 * the same canonicalizer the portable hash is built on, so a re-serialized or
 * re-ordered runbook compares equal while any semantic change does not.
 *
 * `viewports`/`notes` are deliberately outside the comparison: they are capture
 * framing and human prose, not execution. Widening a pin to reject on them
 * would make an editorial note in a committed file invalidate in-flight
 * requests for no safety gain.
 */
function executableFingerprint(source: {
  build?: string[];
  serve?: { cmd: string; attach?: 'cdp'; readyWhen?: { urlPath?: string; timeoutMs?: number } };
  attestation?: AttestationSpec;
}): string {
  return canonicalJsonStringify({
    build: source.build ?? null,
    serve: source.serve ?? null,
    attestation: source.attestation ?? null,
  });
}

/**
 * What the REQUEST expects of the record its pin resolves to, beyond the
 * content compare. Defaulted to the ORDINARY posture so a call site that
 * forgets to pass it gets the STRICTER of the two answers (proven-status
 * required, no version equality) rather than the more permissive one — the same
 * fail-safe direction every other gate in this file picks.
 */
export interface RunbookPinExpectations {
  /** The §3.6 setup-flow proof run (`VerificationAgentRequest.setupProof`). */
  setupProof: boolean;
  /** The record CAS version stamped on the request row, or null when unstamped. */
  localVersion: number | null;
}

/**
 * Does the composed task still match the runbook revision it was pinned to —
 * AND is that revision still the one this request is entitled to execute?
 *
 * WHY THIS EXISTS AT ALL (§5.2 seam 3, the v2 correction). The verifier runs in
 * a DETACHED snapshot at the task's sha, so the runbook is unresolvable from
 * inside it in both directions — an uncommitted runbook is invisible there, a
 * committed one is absent from every branch cut before it. v1 said "read it live
 * at compose time", which breaks attribution the other way: revision-B commands
 * executing against revision-A code yield a verdict attesting to a hybrid state
 * NO REVISION EVER CONTAINED. So the content is pinned at enqueue and re-checked
 * here. A verdict is a claim about a specific tree; a verdict produced by
 * commands from a different tree is not a weaker claim, it is a false one.
 *
 * CONTENT EQUALITY IS NOT THE WHOLE CHECK, because a record carries two facts a
 * hash cannot: its STATUS and its VERSION, and each matters to exactly one of
 * the two request kinds.
 *
 *  - An ORDINARY request additionally requires `status === 'proven'`. The §3.2
 *    degrade gate already refused to enqueue an unproven build/serve task, so a
 *    record that is `'unproven-draft'` BY THE TIME THE RUNNER LOOKS was demoted
 *    in the window between enqueue and deploy — a real drift signal (an edited
 *    dev script, a moved host fingerprint) that the store recorded and this
 *    request would otherwise execute straight past. Resolving by hash alone
 *    cannot see it: the demotion changes the row's status, never its content
 *    address.
 *  - A SETUP-PROOF request instead requires `version === localVersion`, and
 *    deliberately does NOT require `'proven'` — proving the draft is the entire
 *    point, so a proven-status requirement would deadlock the bootstrap. The
 *    version equality that would be wrong for an ordinary request (see
 *    {@link VerificationAgentRequest.runbookLocalVersion}) is exactly right
 *    here: the flow registered a draft and immediately asked for a proof OF
 *    THAT draft, so a `registerDraft` landing mid-flight means the proof about
 *    to be produced would be recorded against content the record no longer
 *    holds. `markProven`'s own CAS would decline the flip afterwards anyway —
 *    rejecting here just declines it BEFORE spending a deployment on a proof
 *    that could never be recorded.
 *
 * Both rejections are env-class by construction at the call site (a status/
 * version read is a harness fact, never model prose): a demotion race or a
 * re-registration is host/state drift, not a defect in the deliverable, and
 * re-running the lane's implement agent could not fix either.
 *
 * Returns the mismatch DETAIL rather than a bare boolean so the rejection can
 * name what actually differs — the caller puts it on the request row, where it
 * is the only thing a human has to work from.
 */
export function checkRunbookPin(
  record: PinnedRunbookRecord | null,
  modality: VerificationModality,
  task: VerificationTaskV1,
  hash: string,
  expectations: RunbookPinExpectations = { setupProof: false, localVersion: null },
): { ok: true } | { ok: false; detail: string } {
  if (record === null) {
    return {
      ok: false,
      detail: `pinned runbook ${hash.slice(0, 12)} for modality "${modality}" no longer resolves (re-registered, deleted, or never persisted on this host)`,
    };
  }
  const entry: VerifyRunbookModalityEntry | undefined =
    record.runbook.modalities[modality as VerifyRunbookModality];
  if (entry === undefined) {
    return {
      ok: false,
      detail: `pinned runbook ${hash.slice(0, 12)} declares no "${modality}" modality`,
    };
  }
  const expected = executableFingerprint(entry);
  const actual = executableFingerprint(task);
  if (expected !== actual) {
    return {
      ok: false,
      detail: `the composed task's build/serve/attestation do not match pinned runbook ${hash.slice(0, 12)} (record v${record.version}, status "${record.status}") — expected ${expected}, task carries ${actual}`,
    };
  }
  if (expectations.setupProof) {
    if (expectations.localVersion !== null && record.version !== expectations.localVersion) {
      return {
        ok: false,
        detail: `setup-proof request pinned runbook ${hash.slice(0, 12)} at record v${expectations.localVersion}, but the record is now v${record.version} — it was re-registered mid-flight, so this proof would attest to a superseded revision`,
      };
    }
    return { ok: true };
  }
  if (record.status !== 'proven') {
    return {
      ok: false,
      detail: `runbook revision not proven: pinned runbook ${hash.slice(0, 12)} (record v${record.version}) is "${record.status}" — it was demoted between this request's enqueue and its deployment`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Attestation floor (§7.1 — "no attestation ⇒ no passed")
// ---------------------------------------------------------------------------

/** Terminal error for a pass the harness could not prove was about THIS deliverable. */
export const ATTESTATION_MISSING_MESSAGE =
  "attestation missing/mismatched — could not prove the verified surface is this task's deliverable";

/** Explanatory note attached when a pass is capped for having no attestation channel at all. */
export const ATTESTATION_UNCAPPED_MESSAGE = 'no attestation channel — pass capped at low_confidence';

/**
 * The prefix every serve-identity binding failure carries into the attestation
 * detail (and thence the terminal `error_message`). Exported so tests and any
 * future health-panel grouping key on ONE string rather than re-spelling it.
 */
export const SERVE_BINDING_FAILED_PREFIX = 'serve-identity binding failed';

/**
 * The terminal message for a transport failure that hit MID-SESSION (round-3
 * finding 4). Exported for the same reason as the prefixes above.
 *
 * THE ACCEPTED COST, stated where it will be read. A genuine Anthropic API
 * outage that lands after the agent has already been working now BLOCKS a lane
 * instead of advancing it. That is deliberate and it is §3.1's own rule:
 * "ambiguity is allowed to be annoying; it is not allowed to ship regressions."
 * A mid-session throw is genuinely ambiguous — the agent holds `Bash`, so it can
 * kill its own SDK process or wedge it past the deadline, and from outside those
 * are indistinguishable from an upstream reset. Treating them all as transport
 * handed the model a one-line route to an advancing skip.
 *
 * The empty-transcript case keeps the carve-out that actually mattered: an API
 * outage storm fails every session before it produces a single message, and
 * those still skip rather than looping implement agents against code the harness
 * never examined.
 *
 * THIS ALSO CATCHES THE QUERY'S OWN DEADLINE, deliberately. When the SDK layer's
 * internal timeout fires before the scheduler's abort does (the two are both 10
 * minutes, and a task may declare a longer one), the throw arrives here rather
 * than on the `'timeout'` path — and a session that burned its whole deadline
 * with a transcript behind it is the same ambiguity: an agent can stall itself
 * on purpose. Routing it back to an advancing outcome would reopen the hole
 * through a different door. The scheduler-abort `'timeout'` still advances, per
 * its own long-standing "timeout == environment failure" posture
 * (mergeGateLaneAdvance); that asymmetry is noted rather than papered over.
 */
export const TRANSPORT_MID_SESSION_MESSAGE =
  'the deployed session failed mid-transport after it had already started working — an upstream outage and an agent-induced failure are indistinguishable here, so this blocks rather than advancing the lane';

/** What the floor decided about a PASS report's identity proof. */
export type AttestationFloorOutcome =
  /** The declared channel was probed and matched (or is true by construction). */
  | { kind: 'verified'; channel: AttestationSpec['kind']; detail: string }
  /** A channel WAS declared but the harness's own probe did not verify it. */
  | { kind: 'missing'; detail: string }
  /** No channel was declared at all — the pass is advisory, capped at low_confidence. */
  | { kind: 'uncapped'; detail: string };

/**
 * The attestation channel a task's proof actually rests on: its own declared
 * spec, else an IMPLICIT `file-identity` for the degenerate pre-live path
 * (`target.htmlPath` with nothing to build and nothing to serve). The implicit
 * case is not a loophole — identity there is true by construction, because the
 * runner itself owns the path being opened: there is no live process, no port,
 * and nothing for a stale server or the user's own app to race.
 *
 * A `target.url` task gets NO implicit spec: a bare URL is exactly the shape
 * whose identity cannot be assumed (that URL may be answered by anything).
 */
export function effectiveAttestationSpec(task: VerificationTaskV1): AttestationSpec | null {
  if (task.attestation !== undefined) return task.attestation;
  const htmlPath = task.target?.htmlPath;
  const degenerate =
    typeof htmlPath === 'string' &&
    htmlPath.trim().length > 0 &&
    (task.build === undefined || task.build.length === 0) &&
    task.serve === undefined;
  return degenerate ? { kind: 'file-identity' } : null;
}

// ---------------------------------------------------------------------------
// Serve-identity binding (§7.1 — round-3 finding 3: bind the PROBED SURFACE to
// the PINNED serve command, using kernel truth)
// ---------------------------------------------------------------------------

/**
 * Which of the three bindings failed. Named on the unverified detail (and
 * therefore on the terminal `error_message`) because "the attestation did not
 * verify" is unactionable while "the port is held by a group your serve command
 * never started" tells a human exactly what to look at.
 */
export type ServeBindingFailure = 'serve-pid' | 'port-owner' | 'command';

/** The verdict of {@link checkServeIdentityBinding}. */
export type ServeBindingResult =
  | { bound: true; detail: string }
  | { bound: false; failure: ServeBindingFailure; detail: string };

/** The three probes {@link checkServeIdentityBinding} needs, in one bag (all injected). */
export interface ServeBindingProbes {
  readServePid: (artifactsDir: string) => Promise<number | null>;
  listeningPidForPort: (port: number) => Promise<number | null>;
  processInfo: (pid: number) => Promise<{ pgid: number; command: string } | null>;
}

/**
 * The attestation channels whose evidence arrives over a SOCKET, and are
 * therefore bindable to a port owner. `window-identity` is excluded on purpose:
 * a window title is not reached through a port, a native app under
 * `native-screen` need never bind the leased one, and binding it would fail
 * every honest native pass while closing nothing (its weakness is already
 * recorded on the verdict as "the weakest channel"). `file-identity` is excluded
 * because there is no live process at all.
 */
const PORT_MEDIATED_CHANNELS: ReadonlySet<AttestationSpec['kind']> = new Set([
  'http-endpoint',
  'dom-marker',
  'cdp-token',
]);

/** Bound a value echoed into a binding detail so a long command line cannot bloat the terminal message. */
function truncateDetail(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Does the serve-identity binding APPLY to this request, and if so, against
 * which port? Returns `null` when it does not — which is the whole "degenerate
 * shapes are untouched" rule, stated once:
 *
 *  - no serve command ⇒ nothing was started, so there is no group to bind (the
 *    degenerate `target.htmlPath` / already-live `target.url` shapes);
 *  - a non-port-mediated channel ⇒ see {@link PORT_MEDIATED_CHANNELS}.
 *
 * WHICH PORT. In CDP-attach mode the serve command launches the APP, and the
 * app's own DevTools endpoint on the driver port is what every attestation probe
 * talks to — so the driver port is the surface. Otherwise the deliverable is
 * served on `VERIFY_PORT` and the driver's chromium (a process the DRIVER
 * spawned, in its own group) sits on the driver port; binding that one would
 * assert a relationship that was never supposed to hold, so the verify port is
 * the surface even for the two CDP-evaluated channels — the page they read was
 * loaded from it.
 *
 * `portLever` is carried separately because it answers a different question:
 * what `${PORT}` in the PINNED command resolves to. In attach mode those two
 * ports differ, and substituting the driver port into the pinned template would
 * manufacture a command line nobody ever ran.
 */
export function serveBindingTarget(
  task: VerificationTaskV1,
  spec: AttestationSpec,
  ports: { verifyPort: number | null; driverPort: number },
): { serveCmd: string; probedPort: number | null; portLever: number | null } | null {
  const serveCmd = task.serve?.cmd;
  if (typeof serveCmd !== 'string' || serveCmd.trim().length === 0) return null;
  if (!PORT_MEDIATED_CHANNELS.has(spec.kind)) return null;
  const attach = task.serve?.attach === 'cdp';
  return {
    serveCmd: serveCmd.trim(),
    probedPort: attach ? ports.driverPort : ports.verifyPort,
    portLever: ports.verifyPort,
  };
}

/**
 * Does `leaderCommand` carry the task's pinned serve command?
 *
 * TWO ACCEPTED SPELLINGS, ONE COMMAND. The pinned `serve.cmd` is a lever
 * TEMPLATE (`pnpm dev --port ${PORT}` — §5.3 forbids persisting resolved values),
 * while the harness contract asks the agent to substitute `${PORT}` with the
 * leased port before handing the string to the driver. Both the template and its
 * substituted form are therefore the SAME command, differing only in who did the
 * substitution, and rejecting either would fail honest runs for a spelling.
 * Nothing else is normalized: a different command, a wrapper, or a `$VERIFY_PORT`
 * spelling the contract does not sanction all fail.
 *
 * CONTAINS, not equals, because the leader is `sh -c '<cmd>'` — the recorded
 * command line always carries a prefix this function must tolerate. The residual
 * that buys is honest and worth stating: an agent that starts
 * `sh -c 'echo <pinned cmd>; <something else>'` satisfies this check, and only
 * the port-owner binding then stands between it and a forged surface. Closing
 * that would require the driver to resolve the task's pinned command itself,
 * which it has no access to; the binding is a floor raise, not a proof of
 * execution.
 */
function serveCommandMatches(leaderCommand: string, serveCmd: string, portLever: number | null): boolean {
  if (leaderCommand.includes(serveCmd)) return true;
  if (portLever === null) return false;
  const resolved = serveCmd.replace(/\$\{PORT\}|\$PORT\b/g, String(portLever));
  return resolved !== serveCmd && leaderCommand.includes(resolved);
}

/**
 * BIND THE PROBED SURFACE TO THE PINNED SERVE COMMAND (round-3 finding 3).
 *
 * THE HOLE THIS CLOSES. Moving attestation harness-side (`harnessAttestation.ts`)
 * proved that SOMETHING on the probed port knows this request's nonce. It did not
 * prove that something is the deliverable, and the gap is reachable: the driver's
 * `serve` command runs WHATEVER string the agent passes, and the agent holds
 * `VERIFY_ATTEST_NONCE` in its own environment. One `serve 'python3 -m http.server
 * ... <a page echoing $VERIFY_ATTEST_NONCE>'` produces a surface the harness then
 * attests, honestly, as carrying the nonce — a green verdict about a page the
 * deliverable never rendered. The nonce authenticates a SECRET, and the agent is
 * inside the trust boundary of that secret.
 *
 * WHY KERNEL TRUTH IS THE ONLY WAY OUT. Every artifact the agent could show us —
 * a log, a pid file, an attest record — is writable by the same Bash that would
 * be doing the forging. What the agent cannot author is the OS's own answer to
 * "who holds this socket" and "what is that process running". So the binding
 * spends two `exec`s on exactly those two questions and trusts nothing else:
 *
 *  1. `.driver/serve.pid` — the CLAIM. Read first, believed about nothing. A
 *     forged value can only make step 2 fail (the kernel will name a different
 *     group), which is the safe direction; that asymmetry is why the file may
 *     keep living in agent-writable space at all.
 *  2. PORT-OWNER BINDING. The pid the kernel says is LISTENING on the probed
 *     port must be in the process GROUP the pid file names. The driver spawns
 *     `serve` detached, so the leader's pgid equals its pid and every child it
 *     forks inherits it — which is what makes a group the right unit (a dev
 *     server is a shell wrapping a node wrapping a bundler, and the listener is
 *     usually the grandchild). A fake responder cannot be in that group without
 *     having been started by that command, and it cannot own the port the real
 *     serve holds.
 *  3. COMMAND BINDING. The recorded leader's command line must carry the task's
 *     pinned `serve.cmd` (which `checkRunbookPin` already tied to the proven
 *     runbook upstream). Step 2 alone proves the port belongs to the group the
 *     driver recorded; this proves that group is running the command the task
 *     declared, rather than whatever else the agent asked the driver to start.
 *
 * NEVER THROWS. Every probe rejection folds into a `bound: false` for the same
 * reason `performHarnessAttestation` never throws: an escaping error would land
 * in the runner's outer catch, which returns a fail-open `'skipped'` — the lane
 * ADVANCING on precisely the unproven pass this function exists to block. An
 * unanswerable probe is an unbound surface, not an exception.
 */
export async function checkServeIdentityBinding(args: {
  artifactsDir: string;
  serveCmd: string;
  probedPort: number | null;
  portLever: number | null;
  probes: ServeBindingProbes;
}): Promise<ServeBindingResult> {
  const { artifactsDir, serveCmd, probedPort, portLever, probes } = args;

  const recorded = await safeProbe(() => probes.readServePid(artifactsDir));
  if (recorded === null || !Number.isFinite(recorded) || recorded <= 1) {
    return {
      bound: false,
      failure: 'serve-pid',
      detail:
        'the driver recorded no serve process (.driver/serve.pid is absent or unusable) — the deliverable was not started through `"$VERIFY_DRIVER" serve`, so there is no process group the probed surface can be bound to',
    };
  }

  if (probedPort === null) {
    return {
      bound: false,
      failure: 'port-owner',
      detail:
        'no server port was leased for this request, so the surface the attestation probed cannot be tied to an owner — the task declared a port-mediated channel its own shape cannot support',
    };
  }
  const listener = await safeProbe(() => probes.listeningPidForPort(probedPort));
  if (listener === null) {
    return {
      bound: false,
      failure: 'port-owner',
      detail: `nothing could be resolved as the listener on port ${probedPort} — the surface that answered the attestation has no owner this harness can verify`,
    };
  }
  const listenerInfo = await safeProbe(() => probes.processInfo(listener));
  if (listenerInfo === null) {
    return {
      bound: false,
      failure: 'port-owner',
      detail: `pid ${listener} holds port ${probedPort} but the OS reported nothing about it (already exited?), so it cannot be tied to the recorded serve group ${recorded}`,
    };
  }
  if (listenerInfo.pgid !== recorded) {
    return {
      bound: false,
      failure: 'port-owner',
      detail: `port ${probedPort} is held by pid ${listener} in process group ${listenerInfo.pgid}, but the driver started this task's serve as group ${recorded} — the surface that answered the attestation is NOT the process this task's serve command started`,
    };
  }

  const leader = await safeProbe(() => probes.processInfo(recorded));
  if (leader === null) {
    return {
      bound: false,
      failure: 'command',
      detail: `the recorded serve leader (pid ${recorded}) is gone, so the command it was started with cannot be read back`,
    };
  }
  if (!serveCommandMatches(leader.command, serveCmd, portLever)) {
    return {
      bound: false,
      failure: 'command',
      detail: `the serve group's leader (pid ${recorded}) is running "${truncateDetail(leader.command)}", which does not carry this task's pinned serve command "${truncateDetail(serveCmd)}" — a substitute or a wrapper was started instead of the deliverable`,
    };
  }

  return {
    bound: true,
    detail: `port ${probedPort} is held by process group ${recorded}, whose leader runs this task's pinned serve command`,
  };
}

/** Run one binding probe, folding ANY rejection into `null` (see {@link checkServeIdentityBinding}). */
async function safeProbe<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Apply §7.1's floor to a PASS report, given the effective spec and the result
 * of the HARNESS's own identity probe.
 *
 *  - `file-identity` ⇒ `verified` without probing anything (see
 *    {@link effectiveAttestationSpec}).
 *  - Any other declared spec ⇒ `verified` ONLY when the harness probed that
 *    channel and it came back `verified`. Anything else is `missing` — §7.1's
 *    hard rule, "no attestation ⇒ no `passed`, period". Note that "the channel
 *    disagreed" and "the channel could not be reached" deliberately land in the
 *    SAME bucket: an unproven identity is unproven regardless of why, and
 *    splitting them would only invite a future softening of the second.
 *  - No spec at all ⇒ `uncapped`. This is the one place the proposal's strict
 *    wording is softened deliberately: a task that never declared a channel
 *    has not FAILED an identity check, it simply never had one, and failing it
 *    outright would break every pre-existing bare-`target.url` check. Capping
 *    it at `low_confidence` keeps the invariant that ONLY a proven surface can
 *    reach `passed`, while leaving the result advisory rather than blocking.
 *
 * There is no longer a "wrong channel" branch: the harness picks the channel
 * FROM the declared spec, so the probe's `kind` always echoes it. That mismatch
 * class existed only because the evidence used to be a file the agent chose
 * when to write.
 */
export function evaluateAttestationFloor(
  spec: AttestationSpec | null,
  probe: HarnessAttestationResult | null,
): AttestationFloorOutcome {
  if (spec === null) {
    return {
      kind: 'uncapped',
      detail: 'the composed task declared no attestation channel and is not a degenerate file target',
    };
  }
  if (spec.kind === 'file-identity') {
    return {
      kind: 'verified',
      channel: 'file-identity',
      detail: 'file-identity: the runner owns the opened path, so identity holds by construction',
    };
  }
  if (probe === null) {
    return {
      kind: 'missing',
      detail: `declared channel "${spec.kind}" but the harness performed no identity probe`,
    };
  }
  if (!probe.verified) {
    return { kind: 'missing', detail: `the harness probed "${spec.kind}" and it did NOT verify: ${probe.detail}` };
  }
  return { kind: 'verified', channel: spec.kind, detail: probe.detail };
}

/**
 * §4 fn.² coercion: on `native-screen` — which is observe-only until a native
 * drive API exists — every behavior the TASK marked `requiresDrive` must land
 * as `not_testable`, whatever the agent claimed. The agent is told this in the
 * harness contract, but the harness must not DEPEND on it: a model that
 * "passed" a click-through it could not possibly have performed is exactly the
 * fabricated evidence this whole path exists to prevent, and a driver refusal
 * it papered over is invisible in a screenshot.
 *
 * Deliberately does NOT re-derive `report.outcome`. Coercion only ever removes
 * a claim; letting it turn an agent-reported `fail` back into a `pass` would
 * be the harness upgrading a verdict on the strength of a rule about what the
 * agent COULDN'T do. A coerced report still reaches `low_confidence` through
 * {@link mapReportToResult}'s existing `anyNotTestable && !anyFail` branch,
 * which is the honest ceiling for a run whose drive-required behaviors were
 * never exercised.
 */
export function coerceDriveUnsupportedBehaviors(
  report: VerificationReportV1,
  task: VerificationTaskV1,
  modality: VerificationModality,
): { report: VerificationReportV1; coerced: number } {
  if (modality !== 'native-screen') return { report, coerced: 0 };
  const driveIds = new Set(task.behaviors.filter((b) => b.requiresDrive === true).map((b) => b.id));
  if (driveIds.size === 0) return { report, coerced: 0 };

  let coerced = 0;
  const behaviors = report.behaviors.map((behavior) => {
    if (!driveIds.has(behavior.id) || behavior.result === 'not_testable') return behavior;
    coerced += 1;
    const notes = behavior.evidence.notes.trim();
    return {
      ...behavior,
      result: 'not_testable' as const,
      evidence: {
        ...behavior.evidence,
        notes: notes.length > 0 ? `${notes}\ncoerced: drive-unsupported` : 'coerced: drive-unsupported',
      },
    };
  });
  return coerced > 0 ? { report: { ...report, behaviors }, coerced } : { report, coerced: 0 };
}

/**
 * Fold an `uncapped` floor outcome into an otherwise-passing result: `passed`
 * becomes `low_confidence`, with the reason on both the errorMessage and the
 * verdict feedback (the merge gate reads the status; a human reads the
 * feedback). A result that is ALREADY non-`passed` is returned untouched — it
 * has either failed outright or been demoted for its own reason, and
 * `low_confidence` is the cap this outcome asks for, not a floor to raise it
 * to.
 *
 * `low_confidence` ADVANCES the lane as advisory (mergeGateLaneAdvance), which
 * is the point: a degenerate URL check with no provable identity stays useful
 * without being allowed to assert an identity it cannot prove.
 */
function applyAttestationCap(
  result: VerificationAgentRunResult,
  floor: AttestationFloorOutcome | null,
): VerificationAgentRunResult {
  if (floor === null || floor.kind !== 'uncapped' || result.status !== 'passed') return result;
  const note = `${ATTESTATION_UNCAPPED_MESSAGE} (${floor.detail})`;
  return {
    ...result,
    status: 'low_confidence',
    ...(result.verdict
      ? {
          verdict: {
            ...result.verdict,
            status: 'low_confidence',
            feedback: `${result.verdict.feedback}\n\n${note}`,
          },
        }
      : {}),
    errorMessage: note,
  };
}

/** Compose the agent's user prompt from the task: the JSON payload plus a short framing. */
export function composeVerifyUserPrompt(task: VerificationTaskV1): string {
  return [
    'Verify the following composed task. Build/serve/drive/screenshot/judge it, then',
    'return the structured VerificationReportV1 (see the harness contract).',
    '',
    'TASK (VerificationTaskV1):',
    '```json',
    JSON.stringify(task, null, 2),
    '```',
  ].join('\n');
}

/**
 * Map a validated report + provisioning mode + mutation flag onto the terminal
 * verdict (§5.7 posture table). `normalizeVerificationReportV1` has already coerced
 * a pass-with-failed-behavior to `fail`, so the outcome here is authoritative.
 */
export function mapReportToResult(
  report: VerificationReportV1,
  mode: 'snapshot' | 'fallback',
  mutated: boolean,
  model: string,
): VerificationAgentRunResult {
  const fileNames = report.screenshots.map((s) => s.fileName);
  // Every outcome mapped here came back FROM a deployed session, so it is
  // budget-charged (§3.6) and carries its provisioning mode for the §3.1
  // classifier's `'deliverable'` gate (snapshot-only).
  const provenance = { deployed: true, provisionMode: mode } as const;
  const verdictOf = (status: VerdictV1['status']): VerdictV1 => ({
    status,
    confidence: report.confidence,
    issues: report.issues,
    feedback: report.feedback,
    judgedFileNames: fileNames,
    baselineUsed: false,
    model,
  });

  if (report.outcome === 'build_failed' || report.outcome === 'launch_failed') {
    const excerpt = report.buildLogExcerpt ?? report.outcome;
    if (mode === 'fallback') {
      // Dirty-worktree fallback: attribution is unprovable, so a build/launch
      // failure is fail-OPEN infra (skipped), never the lane's retry budget (§5.7).
      return {
        status: 'skipped',
        errorMessage: `unattributable shared-worktree ${report.outcome}: ${excerpt}`,
        report,
        fileNames,
        ...provenance,
      };
    }
    // In the snapshot, a deliverable that cannot build from its own committed state
    // is a smoke FAIL — verdict-less, error_message carries the build log excerpt.
    return { status: 'failed', errorMessage: excerpt, report, fileNames, ...provenance };
  }

  if (report.outcome === 'fail') {
    return { status: 'failed', verdict: verdictOf('fail'), report, fileNames, ...provenance };
  }

  // outcome === 'pass'
  if (mutated) {
    return {
      status: 'low_confidence',
      verdict: verdictOf('low_confidence'),
      report,
      fileNames,
      errorMessage: 'verifier modified tracked sources in the snapshot',
      ...provenance,
    };
  }
  const anyNotTestable = report.behaviors.some((b) => b.result === 'not_testable');
  const anyFail = report.behaviors.some((b) => b.result === 'fail');
  if (anyNotTestable && !anyFail) {
    return { status: 'low_confidence', verdict: verdictOf('low_confidence'), report, fileNames, ...provenance };
  }
  return { status: 'passed', verdict: verdictOf('pass'), report, fileNames, ...provenance };
}

// ---------------------------------------------------------------------------
// Default seam implementations (node builtins only; never used by tests)
// ---------------------------------------------------------------------------

const defaultCheckSnapshotMutated = async (worktreePath: string): Promise<boolean> => {
  // `git diff --quiet HEAD` exits 1 when tracked files differ from HEAD (the
  // snapshot commit) — untracked build output is ignored, so only a mutation of a
  // TRACKED source trips this.
  try {
    await execFileAsync(resolveGitCommand(), ['diff', '--quiet', 'HEAD'], {
      cwd: worktreePath,
      timeout: 30_000,
      windowsHide: true,
    });
    return false;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 1) return true;
    // A git failure other than "diff found" (spawn error, timeout) is treated as
    // NOT mutated — never turn an infra hiccup into a false low_confidence.
    return false;
  }
};

/**
 * §3.5 default chromium probe — driverCore's OWN resolver, so the preflight
 * verdict and the driver's later launch behavior can never disagree. driverCore
 * is already a static import here (`pidFilePath`) and is itself
 * no-playwright-at-module-scope: it `await import('playwright')` INSIDE the
 * resolver, so a packaged build that pruned the devDependency soft-fails to
 * `null` ("chromium absent") at call time instead of MODULE_NOT_FOUND-crashing
 * this module's import.
 */
const defaultResolveChromium = (): Promise<string | null> => probeChromiumExecutable();

/**
 * The REAL probes behind {@link performHarnessAttestation}, built out of the
 * driver's own machinery rather than re-implemented: `httpGet` and
 * `runPeekaboo` come straight off `createDefaultDriverDeps()` (which is a plain
 * object of function references — no browser, no child process, nothing
 * touched until one is called), and the CDP evaluation goes through driverCore's
 * exported {@link evaluateOverCdp}, the same `connectOverCDP` path the CLI uses.
 *
 * Sharing the implementations is the point: the harness's authoritative probe
 * and the agent's `attest` self-check must be able to disagree about the
 * SURFACE, never about what "GET this path" or "match this title" means. Two
 * spellings would eventually produce a self-check that passes and a harness
 * probe that fails, which is the least debuggable outcome available.
 */
const buildHarnessAttestationDeps = (
  peekabooBin: string,
  logger?: LoggerLike,
): HarnessAttestationDeps => {
  const driver = createDefaultDriverDeps();
  return {
    httpGetBody: async (url, timeoutMs) => {
      const res = await driver.httpGet(url, timeoutMs);
      if (res.status < 200 || res.status >= 300) {
        // A non-2xx is a REJECTION, not an empty body: the probe contract is
        // "resolve only what the surface actually served", so a 404 page that
        // happened to echo the nonce could never be read as a pass.
        throw new Error(`${url} returned HTTP ${res.status}`);
      }
      return res.body;
    },
    cdpEvaluate: (port, expression, timeoutMs) => evaluateOverCdp(port, expression, timeoutMs),
    listNativeWindows: async (app: string) =>
      extractWindowTitles(
        await driver.runPeekaboo(peekabooBin, peekabooListWindowsArgs(app), PEEKABOO_TIMEOUT_MS),
      ),
    ...(logger ? { logger } : {}),
  };
};

/** How long either kernel probe may run before it counts as unanswerable (⇒ an unbound surface). */
const BINDING_PROBE_TIMEOUT_MS = 10_000;

/**
 * Default {@link VerificationAgentRunnerDeps.readServePid} — the CLAIM half of
 * the binding. Async (unlike {@link defaultReapServe}'s sync read) because it
 * runs on the verdict path, where blocking the loop on a filesystem that may be
 * a network mount buys nothing.
 */
const defaultReadServePid = async (artifactsDir: string): Promise<number | null> => {
  try {
    const raw = await readFile(servePidFilePath(artifactsDir), 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};

/**
 * Default {@link VerificationAgentRunnerDeps.listeningPidForPort} — `lsof -ti
 * tcp:<port> -sTCP:LISTEN`, i.e. the kernel's own answer to "who holds this
 * socket".
 *
 * `-t` prints one bare pid per line. A socket with SEVERAL listed pids is a
 * pre-forking server whose workers inherited the listening fd — they share the
 * master's process group, so the FIRST line answers the group question for all
 * of them. Taking the first is also the strict reading: if the lines ever
 * disagreed about the group, the binding fails, which is the safe direction.
 */
const defaultListeningPidForPort = async (port: number): Promise<number | null> => {
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      timeout: BINDING_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const first = stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    if (first === undefined) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    // lsof exits 1 when nothing matches, and may be absent entirely — both are
    // "no owner this harness can verify", which FAILS the binding upstream.
    return null;
  }
};

/**
 * Default {@link VerificationAgentRunnerDeps.processInfo} — `ps -o pgid=,command=
 * -p <pid>`. The `=` suffixes suppress headers, so a live pid yields exactly one
 * line: the group id, whitespace, then the full command line (which may itself
 * contain whitespace — hence the non-greedy leading capture and a `.*` tail
 * rather than a split).
 */
const defaultProcessInfo = async (pid: number): Promise<{ pgid: number; command: string } | null> => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], {
      timeout: BINDING_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    if (line === undefined) return null;
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    const pgid = Number.parseInt(match[1], 10);
    return Number.isFinite(pgid) ? { pgid, command: match[2] } : null;
  } catch {
    // `ps` exits 1 for a pid that no longer exists — "gone", not "broken".
    return null;
  }
};

const defaultFileExists = async (absPath: string): Promise<boolean> => {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
};

const defaultWriteDriverScript = async (
  artifactsDir: string,
  nodePath: string,
  driverCliPath: string,
): Promise<string> => {
  const dir = join(artifactsDir, DRIVER_STATE_DIR);
  await mkdir(dir, { recursive: true });
  const scriptPath = join(dir, DRIVER_SCRIPT_NAME);
  // ELECTRON_RUN_AS_NODE makes the packaged Electron binary (process.execPath, the
  // findNodeExecutable fallback in a packaged app) behave as plain node; harmless
  // for a real node. `exec` so the driver process replaces the shell (clean signals).
  // On Windows there is no /bin/sh — a .cmd wrapper does the same job (set the
  // env var, forward every argument). Node 24 refuses to spawn .cmd files
  // directly (EINVAL), so defaultStopDriver routes through cmd.exe there.
  const body = process.platform === 'win32'
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodePath}" "${driverCliPath}" %*\r\n`
    : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${nodePath}" "${driverCliPath}" "$@"\n`;
  await writeFile(scriptPath, body, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

const defaultStopDriver = async (
  driverScriptPath: string,
  env: Record<string, string>,
): Promise<void> => {
  try {
    // Node on Windows refuses to spawn .cmd/.bat files directly (EINVAL), so
    // the wrapper is executed through cmd.exe there — the same interpreter the
    // agent's own shell uses for $VERIFY_DRIVER.
    const cmd = process.platform === 'win32'
      ? cmdExeInvocation(cmdCommandLine([driverScriptPath, 'stop']))
      : null;
    const [file, args] = cmd ? [cmd.command, cmd.args] : [driverScriptPath, ['stop']];
    await execFileAsync(file, args, {
      env: { ...process.env, ...env },
      timeout: 20_000,
      windowsHide: true,
      windowsVerbatimArguments: cmd?.windowsVerbatimArguments,
    });
  } catch {
    // best-effort — the reaper + port probe are the real backstop.
  }
};

const defaultWriteTranscript = async (
  artifactsDir: string,
  fileName: string,
  content: string,
): Promise<void> => {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, fileName), content, 'utf8');
};

const defaultReapBrowser = (artifactsDir: string): void => {
  try {
    const raw = readFileSync(pidFilePath(artifactsDir), 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return;
    try {
      process.kill(pid, 0); // alive?
    } catch {
      return; // already gone
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best-effort
    }
  } catch {
    // no pid file / unreadable — nothing to reap.
  }
};

/**
 * Kill the process GROUP the driver's `serve` command started (mirrors
 * {@link defaultReapBrowser}, with `-pid` in place of `pid`). The group is the
 * unit that matters: a dev server is a shell wrapping a node wrapping a bundler,
 * and killing only the leader orphans the children that actually hold the port.
 *
 * THE PID FILE IS A CLAIM, NOT A TRUST INPUT — and the distinction is the whole
 * reason serve moved into the driver. `.driver/serve.pid` sits in agent-writable
 * space, so its contents are exactly as forgeable as `attest.json` was. The
 * difference is what a forgery BUYS. Here: a bogus pid makes the harness kill
 * the wrong thing or nothing at all, which harms the agent's own environment and
 * leaks a port the scheduler's probe will quarantine. In
 * {@link checkServeIdentityBinding}, the only other reader: a bogus pid is
 * compared against what the KERNEL says owns the probed port, so it can only
 * make the binding fail. Neither reader can be talked into calling an unproven
 * surface proven, which is why this file may live here and the attestation
 * record may not.
 */
const defaultReapServe = (artifactsDir: string): void => {
  try {
    const raw = readFileSync(servePidFilePath(artifactsDir), 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return;
    try {
      process.kill(pid, 0); // alive?
    } catch {
      return; // already gone
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // best-effort — the scheduler's leased-port probe + quarantine is the backstop.
    }
  } catch {
    // no serve.pid / unreadable — the agent never started one through the driver.
  }
};

// ---------------------------------------------------------------------------
// VerificationAgentRunner
// ---------------------------------------------------------------------------

export class VerificationAgentRunner implements VerificationAgentRunnerLike {
  private readonly deps: VerificationAgentRunnerDeps;

  constructor(deps: VerificationAgentRunnerDeps) {
    this.deps = deps;
  }

  /**
   * The production {@link VerificationAgentRunnerDeps.attest} thunk: the pure
   * evaluator bound to the real probes. Built per call rather than once at
   * construction because the probes are only ever needed on the pass path of a
   * request that declared a non-trivial channel — most runs never build one.
   */
  private defaultAttest(logger: LoggerLike | undefined): NonNullable<VerificationAgentRunnerDeps['attest']> {
    const peekabooBin = this.deps.peekabooBin ?? DEFAULT_PEEKABOO_BIN;
    return (spec, args) =>
      performHarnessAttestation(spec, {
        ...args,
        deps: buildHarnessAttestationDeps(peekabooBin, logger),
      });
  }

  /**
   * §7.1 serve-identity binding for ONE request: resolve whether it applies
   * ({@link serveBindingTarget}) and, when it does, run
   * {@link checkServeIdentityBinding} against the injected probes. Returns
   * `null` when the binding does not apply at all — the degenerate and
   * non-port-mediated shapes, which are untouched by design.
   *
   * A FAILURE IS LOGGED HERE rather than only at the floor, because this is the
   * only place that still knows WHICH binding failed as structured data; by the
   * time it reaches the terminal it is a sentence inside an error message.
   */
  private async bindServeIdentity(
    req: VerificationAgentRequest,
    spec: AttestationSpec,
    logger: LoggerLike | undefined,
  ): Promise<ServeBindingResult | null> {
    const target = serveBindingTarget(req.task, spec, {
      verifyPort: req.verifyPort,
      driverPort: req.verifyDriverPort,
    });
    if (target === null) return null;
    const result = await checkServeIdentityBinding({
      artifactsDir: req.artifactsDir,
      serveCmd: target.serveCmd,
      probedPort: target.probedPort,
      portLever: target.portLever,
      probes: {
        readServePid: this.deps.readServePid ?? defaultReadServePid,
        listeningPidForPort: this.deps.listeningPidForPort ?? defaultListeningPidForPort,
        processInfo: this.deps.processInfo ?? defaultProcessInfo,
      },
    });
    if (!result.bound) {
      logger?.warn('[VerificationAgentRunner] serve-identity binding failed; the surface is unproven', {
        runId: req.runId,
        requestId: req.requestId,
        failure: result.failure,
        probedPort: target.probedPort,
        detail: result.detail,
      });
    }
    return result;
  }

  /**
   * Write the harness-captured transcript to the deterministic filename (§
   * verifyTranscriptFileName), FAIL-SOFT: a write failure is logged at warn and
   * NEVER propagates — it must never change the verdict path. A null/empty
   * transcript is a no-op (nothing accumulated).
   */
  private async writeTranscriptFailSoft(
    req: VerificationAgentRequest,
    transcript: string | null,
    logger: LoggerLike | undefined,
  ): Promise<void> {
    if (!transcript || transcript.length === 0) return;
    const write = this.deps.writeTranscript ?? defaultWriteTranscript;
    try {
      await write(req.artifactsDir, verifyTranscriptFileName(req.requestId), transcript);
    } catch (err) {
      logger?.warn('[VerificationAgentRunner] transcript write failed (fail-soft)', {
        runId: req.runId,
        requestId: req.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * §3.1 EVIDENCE INTEGRITY — every screenshot the report REFERENCES must be a
   * bare basename (no path traversal, mirroring `cyboflow_report_artifact`'s
   * safety rules) AND must actually exist in the artifacts dir. Returns the
   * violation detail for the terminal `errorMessage`, or `null` when every
   * reference resolves.
   *
   * WHY BOTH REFERENCE CHANNELS ARE CHECKED. The top-level `screenshots[]`
   * gallery is what the artifact renders; each behavior's
   * `evidence.screenshots[]` is what a human — or the merge gate's reader —
   * consults to decide whether that behavior was genuinely exercised. Both are
   * model-authored free text. Validating only the gallery (which is all the
   * pre-existing loop did) leaves the actual EVIDENCE claim unchecked: a report
   * can pass every behavior citing `login-success.png`, publish an empty
   * gallery, and sail through with a fabricated audit trail. So both are
   * compared against the one thing a model cannot author — the directory
   * listing.
   *
   * EVERY violation is collected before returning, rather than first-wins,
   * because the terminal message is all a human gets: "these four files do not
   * exist" reads as fabrication, whereas one name at a time reads as a typo.
   * Each distinct name is probed ONCE (the two channels overlap heavily by
   * design — the gallery is normally the union of the evidence lists).
   */
  private async validateReportScreenshots(
    report: VerificationReportV1,
    artifactsDir: string,
  ): Promise<string | null> {
    const fileExists = this.deps.fileExists ?? defaultFileExists;
    const referenced = new Set<string>([
      ...report.screenshots.map((s) => s.fileName),
      ...report.behaviors.flatMap((b) => b.evidence.screenshots),
    ]);
    const notBare: string[] = [];
    const missing: string[] = [];
    for (const fileName of referenced) {
      if (basename(fileName) !== fileName) {
        notBare.push(fileName);
        continue;
      }
      if (!(await fileExists(join(artifactsDir, fileName)))) missing.push(fileName);
    }
    const problems: string[] = [];
    if (notBare.length > 0) {
      problems.push(`must be bare filenames: ${notBare.map((f) => `"${f}"`).join(', ')}`);
    }
    if (missing.length > 0) {
      problems.push(`not found in artifacts dir: ${missing.map((f) => `"${f}"`).join(', ')}`);
    }
    return problems.length > 0 ? `report references screenshots that ${problems.join('; ')}` : null;
  }

  /**
   * The §3.5 PRE-DEPLOY gate (docs/proposals/verification-setup-flow.md). Runs
   * FIRST — before agent resolution, before snapshot provisioning, before the SDK
   * deploy — because everything after it is expensive: a missing chromium today
   * only surfaces at driver-launch time, inside a deployed session, after the
   * scheduler already charged the project's verification budget and built a
   * detached worktree. Every probe is delegated to an injectable dep so this
   * module stays fs/net/playwright-free at module scope.
   *
   * The leased-port argument mirrors what the scheduler leased: `req.verifyPort`
   * when the task implies a server it must BIND, else the slot the driver port
   * was derived from (`verifyDriverPort - 1`) — the scheduler always leases the
   * pair (p, p+1), so that arithmetic recovers the pool slot for a non-serving
   * task without widening {@link VerificationAgentRequest}.
   */
  private async preflight(
    req: VerificationAgentRequest,
    modality: VerificationModality,
  ): Promise<AgentPreflightResult> {
    const nativeCaptureProbe = this.deps.nativeCaptureProbe;
    return runAgentPreflight(
      {
        resolveNode: this.deps.resolveNode,
        resolveChromium: this.deps.resolveChromium ?? defaultResolveChromium,
        fileExists: this.deps.fileExists ?? defaultFileExists,
        portFreeProbe: this.deps.portFreeProbe ?? (async () => true),
        // Passed through only when wired: an ABSENT probe means the
        // 'native-capture' check does not run at all (see the dep's doc), so
        // no default may be substituted here.
        ...(nativeCaptureProbe ? { nativeCaptureProbe } : {}),
      },
      {
        task: req.task,
        driverCliPath: this.deps.driverCliPath,
        leasedPort: req.verifyPort ?? req.verifyDriverPort - 1,
        driverPort: req.verifyDriverPort,
        modality,
      },
    );
  }

  /**
   * Deploy the agent for one request and return the mapped verdict. NEVER throws
   * for an ordinary failure — every INFRA error maps to a fail-open `skipped`
   * (or `timeout` on abort) so a verification problem can never wedge a lane;
   * only a truly unexpected error would escape. Teardown (abort the query, stop
   * the driver, reap the browser, dispose the snapshot) runs on EVERY path.
   *
   * "INFRA" IS NARROWER THAN "AGENT" HERE, and the line matters more than
   * anything else in this method (§3.1). `skipped` ADVANCES the lane at the
   * merge gate, so fail-open is only ever safe for a failure the HARNESS
   * observed: a preflight check, a snapshot that would not provision, a pin that
   * no longer resolves, a transport error from our own SDK layer, an
   * unattributable build failure in the dirty shared worktree. Anything the
   * MODEL authored after a successful deploy — an unparseable report, a
   * screenshot reference with no file behind it, a pass with no attestation —
   * maps to a blocking `failed` instead, because a fail-open there is a lane
   * advancing on a verification that never happened. The scheduler keeps one
   * backstop for the same invariant (`settleAgentTerminal`); this method is
   * where the statuses are meant to be right in the first place.
   */
  async run(req: VerificationAgentRequest): Promise<VerificationAgentRunResult> {
    const logger = this.deps.logger;

    // (a) The §4 roster modality — resolved FIRST because everything below
    // keys on it: which preflight checks apply, which env the agent gets, and
    // whether drive-required behaviors are coerced out of the report.
    const modality = resolveRequestModality(req, logger);

    // (a0) §3.5 preflight — the cheap host check, BEFORE any spend. A failure
    // returns immediately with NO snapshot and NO deploy; `deployed:false` tells
    // the scheduler not to charge the budget, and the carried `preflight` is the
    // harness-derived evidence the §3.1 classifier needs to call the resulting
    // terminal `'env'` (an advancing skip) rather than a lane-blocking FAIL.
    const preflight = await this.preflight(req, modality);
    if (!preflight.ok) {
      const failed = preflight.checks.filter((c) => !c.ok);
      logger?.warn('[VerificationAgentRunner] preflight failed; skipping without deploy', {
        runId: req.runId,
        requestId: req.requestId,
        failedChecks: failed.map((c) => c.id),
      });
      return {
        status: 'skipped',
        deployed: false,
        preflight,
        errorMessage: failed.map((c) => c.detail).join('; '),
        fileNames: [],
      };
    }

    // (a1) §5.2 seam 3 PIN VALIDATION — after the host check, before ANY
    // provisioning or spend. A pin that no longer resolves (or resolves to
    // content this task does not match) means the request would execute a hybrid
    // of two revisions, and the resulting verdict would attest to a tree that
    // never existed. Rejecting is not a failure of the deliverable and must not
    // be charged like one: `deployed:false` keeps the budget untouched,
    // `runbookMismatch:true` makes the scheduler's §3.1 classification `'env'`
    // (harness-derived: a hash lookup plus a structural compare), and an
    // env-class terminal ADVANCES the lane without incrementing its attempt
    // counter. The setup flow's re-proof, not the lane's implement-retry, is the
    // fix for a drifted runbook.
    //
    // The resolved record is HOISTED out of this block on purpose: its `levers`
    // are the runbook's half of the env contract (`resolveLeverEnv`), and the
    // env is not built until after provisioning, ~150 lines down. Only a record
    // that PASSED the pin check is kept — executing a rejected revision's levers
    // would bind values from a runbook this request already refused to run.
    let pinnedLevers: VerifyRunbookV1['levers'];
    const resolveRunbookByHash = this.deps.resolveRunbookByHash;
    if (typeof req.runbookHash === 'string' && req.runbookHash.length > 0 && resolveRunbookByHash) {
      const record = resolveRunbookByHash(req.projectId, modality, req.runbookHash);
      const pinned = checkRunbookPin(record, modality, req.task, req.runbookHash, {
        setupProof: req.setupProof === true,
        localVersion: typeof req.runbookLocalVersion === 'number' ? req.runbookLocalVersion : null,
      });
      if (!pinned.ok) {
        logger?.warn('[VerificationAgentRunner] runbook pin rejected; skipping without deploy', {
          runId: req.runId,
          requestId: req.requestId,
          modality,
          runbookHash: req.runbookHash,
          runbookLocalVersion: req.runbookLocalVersion ?? null,
          detail: pinned.detail,
        });
        return {
          status: 'skipped',
          deployed: false,
          preflight,
          runbookMismatch: true,
          errorMessage: `${RUNBOOK_MISMATCH_PREFIX} — ${pinned.detail}`,
          fileNames: [],
        };
      }
      pinnedLevers = record?.runbook.levers;
    }

    const resolved = this.deps.resolveVerifyAgent(req.runId);
    if (!resolved) {
      return {
        status: 'skipped',
        deployed: false,
        preflight,
        errorMessage: 'visual-verify agent not resolvable for this run',
        fileNames: [],
      };
    }

    // Provider dispatch (§5.4 step 1): the resolved agent's runtime picks the query
    // seam + model rule. A codex request with no wired codexQuery dep fails open.
    const provider = resolveVerifyProvider(resolved);
    let queryFn: VerificationAgentQueryFn;
    let model: string | undefined;
    let verdictModel: string;
    if (provider !== 'claude') {
      // Keyed on "not Claude", not on `=== 'codex'`. Codex is the only non-Claude
      // provider with a verify seam today, but the launchable set is wider than
      // that: an `omp-sdk` pin on `visual-verify` (or an unpinned agent on an
      // OMP-provider run) resolves here, and the `else` branch below would have
      // run it on the CLAUDE query with a Claude model — the silent misroute this
      // dispatch exists to prevent. T3 (juror/verifier) is deliberately a later
      // phase for OMP, so the honest answer is a loud skip, not a fallback.
      const providerQuery = provider === 'codex' ? this.deps.codexQuery : undefined;
      if (!providerQuery) {
        // PRE-deploy: no session was ever opened, so this skip is not budget-charged
        // (§3.6 "unknown ⇒ do not charge" does not even apply — we know it never ran).
        return {
          status: 'skipped',
          deployed: false,
          preflight,
          errorMessage: `${provider} verify runtime not wired`,
          fileNames: [],
        };
      }
      queryFn = providerQuery;
      // May be undefined — the Codex query resolves the account default in that case.
      model = resolveVerifyCodexModel(resolved);
      // The verdict label must stay a string even when the model is account-default.
      verdictModel = model ?? 'codex-default';
    } else {
      queryFn = this.deps.query;
      model = resolveVerifyModel(resolved, this.deps.resolveClaudeAlias, this.deps.claudeDefaultModel);
      verdictModel = model;
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener('abort', onAbort, { once: true });

    let snapshot: SnapshotProvision | null = null;
    let driverScriptPath: string | null = null;
    let env: Record<string, string> | null = null;
    // §7.1: the per-REQUEST identity secret. Minted HERE, before the env is
    // built, because two consumers need the same value: the agent's environment
    // (so its serve step can inject it into the deliverable) and the HARNESS's
    // own post-session probe (which asks the surface to hand it back). The
    // second is what makes it evidence — the agent knowing the nonce proves
    // nothing about the agent, only about whatever surface can echo it.
    const attestNonce = randomUUID();
    // Hoisted out of the try so the outer catch can report the provisioning mode
    // it failed under (the §3.1 classifier's `'deliverable'` gate is
    // snapshot-only, so an unknown mode must stay `undefined`, never guessed).
    let mode: 'snapshot' | 'fallback' | null = null;

    try {
      // (b) Provision — ALWAYS snapshot when a sha is present; the live-worktree
      // fallback is reserved for a failed sha capture (req.snapshotSha === null).
      // A whole-tree dirty check used to gate the snapshot here, but any sibling
      // lane's mid-edit state in the shared sprint worktree tripped it and routed
      // verification into the live worktree — the exact cross-lane contamination
      // snapshots exist to prevent (adversarial-review fix 2026-07-23). The sprint
      // chain commits per task before task-verify fires, so the recorded HEAD
      // contains this lane's deliverable; an uncommitted lane diff fails closed in
      // the snapshot with "not present in build" feedback instead (§5.5 amended).
      let cwd: string;
      if (req.snapshotSha !== null) {
        const provision = this.deps.provision ?? provisionSnapshot;
        try {
          snapshot = await provision({
            runWorktreePath: req.runWorktreePath,
            snapshotSha: req.snapshotSha,
            ...(logger ? { logger } : {}),
          });
        } catch (err) {
          if (err instanceof SnapshotProvisionError) {
            // bad_sha / worktree_add_failed — the fail-open infra bucket (§5.5).
            // Nothing was deployed, so nothing is charged (§3.6).
            return {
              status: 'skipped',
              deployed: false,
              preflight,
              errorMessage: `snapshot provisioning failed (${err.code})`,
              fileNames: [],
            };
          }
          throw err;
        }
        cwd = snapshot.worktreePath;
        mode = 'snapshot';
      } else {
        cwd = req.runWorktreePath;
        mode = 'fallback';
      }

      // (b cont.) Env + the driver wrapper script. VERIFY_PORT rides only when the
      // task implies a server (the scheduler decided that when it leased the port).
      const node = await this.deps.resolveNode();
      const writeScript = this.deps.writeDriverScript ?? defaultWriteDriverScript;
      driverScriptPath = await writeScript(req.artifactsDir, node, this.deps.driverCliPath);
      env = {
        VERIFY_ARTIFACTS_DIR: req.artifactsDir,
        VERIFY_DRIVER_PORT: String(req.verifyDriverPort),
        VERIFY_DRIVER: driverScriptPath,
        // Never reused and never derived from anything the deliverable could
        // guess, so a surface handing it back cannot be a stale server, a warm
        // cache, or the user's own running app — only something this request's
        // serve step injected can carry it.
        VERIFY_ATTEST_NONCE: attestNonce,
        VERIFY_MODALITY: modality,
        // UNCONDITIONAL, deliberately. The harness's own window-identity probe
        // always uses `deps.peekabooBin`, and nothing ties an attestation kind
        // to a modality — so gating this on `native-screen` left the driver's
        // self-check resolving a bare `peekaboo` off PATH while the harness
        // measured the bundled one. On the host bundling exists for (nothing on
        // PATH) the self-check would ENOENT while the authoritative probe
        // passed, which is the least debuggable outcome available.
        VERIFY_PEEKABOO_BIN: this.deps.peekabooBin ?? DEFAULT_PEEKABOO_BIN,
        ...(req.verifyPort !== null ? { VERIFY_PORT: String(req.verifyPort) } : {}),
        // CDP-attach mode (task.serve.attach === 'cdp'): the serve command
        // launches the app under test exposing CDP on VERIFY_DRIVER_PORT, so the
        // driver must ATTACH and never launch its own chromium (a blank chromium
        // there would screenshot the wrong surface). driverCore honors this flag.
        ...(req.task.serve?.attach === 'cdp' ? { VERIFY_DRIVER_ATTACH_ONLY: '1' } : {}),
      };

      // The runbook's declared levers, bound to this request's leased values and
      // layered OVER the harness env (never under it — see `resolveLeverEnv`
      // rule 1). This is what lets a project whose serve command reads `PORT`,
      // or whose build stamps a marker from `APP_BUILD_ID`, satisfy the port
      // lease and the attestation nonce without the verification agent having to
      // infer either from the runbook's prose. Dropped levers are logged rather
      // than raised: a lever that does not take effect shows up downstream as an
      // honest attestation failure, which is the outcome we want over a pass.
      const leverEnv = resolveLeverEnv(env, pinnedLevers, {
        port: req.verifyPort !== null ? String(req.verifyPort) : null,
        nonce: attestNonce,
      });
      if (leverEnv.dropped.length > 0) {
        logger?.warn('[VerificationAgentRunner] runbook lever(s) not exported', {
          runId: req.runId,
          requestId: req.requestId,
          modality,
          dropped: leverEnv.dropped,
        });
      }
      env = { ...env, ...leverEnv.additions };

      if (controller.signal.aborted) {
        return {
          status: 'timeout',
          deployed: false,
          preflight,
          provisionMode: mode,
          errorMessage: 'aborted before deploy',
          fileNames: [],
        };
      }

      // (c) Deploy ONE structured session on the resolved provider's query seam,
      // with the provider-matched harness contract appended to the agent prompt.
      const systemPrompt = `${resolved.agent.systemPrompt}\n\n${verifyHarnessContract(provider)}`;
      // From HERE on the session is deployed and has spent tokens — every exit
      // below is budget-charged (§3.6), including a query that threw.
      const deployedProvenance = { deployed: true, preflight, provisionMode: mode } as const;
      let raw: unknown;
      try {
        const outcome = await queryFn({
          prompt: composeVerifyUserPrompt(req.task),
          systemPrompt,
          cwd,
          model,
          allowedTools: [...VERIFY_AGENT_ALLOWED_TOOLS],
          env,
          ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
          signal: controller.signal,
        });
        // Write the transcript BEFORE report validation, so an invalid-report or
        // skipped outcome still leaves the transcript on disk (fail-soft — never
        // changes the verdict path).
        await this.writeTranscriptFailSoft(req, outcome.transcript, logger);
        raw = outcome.structured;
      } catch (err) {
        // The accumulated transcript is the ONE fact that separates a connect-
        // level failure from a mid-session one; captured before anything else so
        // both the fail-soft write and the classification below read the same
        // value. A non-{@link VerificationAgentQueryError} throw carries none,
        // which reads as "empty" — correct, since only the production query
        // (which always wraps) can have been mid-session at all.
        const transcript = err instanceof VerificationAgentQueryError ? err.transcript : null;
        if (err instanceof VerificationAgentQueryError) {
          await this.writeTranscriptFailSoft(req, transcript, logger);
        }
        if (controller.signal.aborted) {
          return {
            status: 'timeout',
            errorMessage: 'deadline exceeded during deploy',
            fileNames: [],
            ...deployedProvenance,
          };
        }
        // A query-INTERNAL deadline expiry is a real timeout, not an infra skip
        // (adversarial-review fix): report it as the terminal `timeout` status.
        if (err instanceof VerificationAgentQueryError && err.timedOut) {
          return { status: 'timeout', errorMessage: err.message, fileNames: [], ...deployedProvenance };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn('[VerificationAgentRunner] agent query failed', { runId: req.runId, error: message });
        emitSeamError('verify-agent-deploy-failed', err instanceof Error ? err : new Error(message), {
          agentKey: 'visual-verify',
        });
        // THE ONE DEPLOYED SKIP THAT IS NOT A HOLE (§3.1) — AND ONLY WHEN THE
        // SESSION NEVER SPOKE. Everything else the agent can produce after a
        // deploy maps to a blocking status: an unparseable report, a phantom
        // screenshot, an unattested pass. `skipped` ADVANCES the lane, so a model
        // must never be able to author its own advance.
        //
        // "Our SDK layer raised it" was the original argument for exempting this
        // path, and round-3 finding 4 showed it does not hold on its own: the
        // agent has `Bash`, so it can kill its own SDK process — or simply wedge
        // until the deadline — and every one of those arrives here as an
        // exception OUR code threw. Harness-observed is not the same as
        // model-independent once the model can reach the harness.
        //
        // What the model CANNOT fake is a session that produced nothing at all.
        // An EMPTY transcript means the failure happened before the agent got a
        // turn — a genuine connect-level failure — and that is the case worth
        // failing open for: an API outage storm otherwise turns every lane into a
        // blocking FAIL that sends an implement agent to "fix" code the harness
        // never looked at, which is the §3.1 failure mode this classification
        // exists to avoid. A NON-EMPTY transcript means the agent was alive and
        // working when the transport died, so the outage and the self-inflicted
        // kill are indistinguishable — ambiguous, and §3.1 keeps ambiguity
        // blocking (see {@link TRANSPORT_MID_SESSION_MESSAGE} for the accepted
        // cost).
        if (typeof transcript === 'string' && transcript.trim().length > 0) {
          logger?.warn('[VerificationAgentRunner] mid-session transport failure; blocking (§3.1)', {
            runId: req.runId,
            requestId: req.requestId,
            transcriptChars: transcript.length,
          });
          return {
            status: 'failed',
            errorMessage: `${TRANSPORT_MID_SESSION_MESSAGE}: ${message}`,
            fileNames: [],
            ...deployedProvenance,
          };
        }
        return {
          status: 'skipped',
          transportFailure: true,
          errorMessage: `agent deploy error: ${message}`,
          fileNames: [],
          ...deployedProvenance,
        };
      }

      if (controller.signal.aborted) {
        return { status: 'timeout', errorMessage: 'deadline exceeded', fileNames: [], ...deployedProvenance };
      }

      // (d) Validate the report harness-side (never trust the model verbatim).
      //
      // A REJECTION HERE IS BLOCKING, NOT A SKIP (§3.1 gate integrity). This
      // return used to be a fail-open `'skipped'`, which is the most dangerous
      // shape in the whole engine: `skipped` ADVANCES the lane at the merge gate
      // (mergeGateLaneAdvance), so a session that returned prose, a truncated
      // object, a report naming behaviors nobody asked about, or literally
      // nothing at all (`structured === null` after a clean drain — the
      // normalizer's `root: expected an object`) would ship the lane's code with
      // NO verification having happened. And unlike a transport error, this
      // outcome is entirely MODEL-AUTHORED: the one thing an agent must never be
      // able to do is advance its own lane by emitting garbage.
      //
      // The harness contract states the schema verbatim, so a violation is a
      // contract violation with a deployed session behind it — exactly the
      // "cannot attribute this to the environment" case §3.1 sends to
      // `'ambiguous'`, which stays blocking. Attribution stays honest: the
      // classifier sees no report outcome and no harness evidence, so it never
      // charges this to the deliverable either.
      const expectedIds = req.task.behaviors.map((b) => b.id);
      const normalized = normalizeVerificationReportV1(raw, expectedIds);
      if (!normalized.ok) {
        logger?.warn('[VerificationAgentRunner] structured report failed validation; blocking', {
          runId: req.runId,
          requestId: req.requestId,
          error: normalized.error,
        });
        return {
          status: 'failed',
          errorMessage: `invalid structured report: ${normalized.error}`,
          fileNames: [],
          ...deployedProvenance,
        };
      }
      // (d1) §4 fn.² native-screen coercion — applied BEFORE any verdict
      // mapping so every downstream branch (the attestation floor, the
      // mutation demotion, the not_testable→low_confidence rule) sees the same
      // honest behavior set. A claimed pass/fail on a behavior the driver would
      // have REFUSED to drive is not evidence of anything.
      const { report, coerced } = coerceDriveUnsupportedBehaviors(normalized.report, req.task, modality);
      if (coerced > 0) {
        logger?.info('[VerificationAgentRunner] coerced drive-required behaviors to not_testable', {
          runId: req.runId,
          requestId: req.requestId,
          modality,
          coerced,
        });
      }

      // (d0) Every screenshot the report REFERENCES must be a bare basename that
      // really exists in the artifacts dir — BLOCKING when it does not (§3.1
      // gate integrity, same argument as the validation branch above: a
      // model-authored claim must never be able to produce an advancing skip).
      const phantom = await this.validateReportScreenshots(report, req.artifactsDir);
      if (phantom !== null) {
        logger?.warn('[VerificationAgentRunner] report references screenshots that do not exist; blocking', {
          runId: req.runId,
          requestId: req.requestId,
          detail: phantom,
        });
        return {
          status: 'failed',
          errorMessage: phantom,
          report,
          fileNames: [],
          ...deployedProvenance,
        };
      }

      // (d2) §7.1 ATTESTATION FLOOR — evaluated on the PASS path only, and
      // BEFORE the mutation check, because "we cannot prove this was your
      // deliverable" outranks every other demotion: a low_confidence for a
      // mutated snapshot still ADVANCES the lane, so a surface that was never
      // identified must fail first rather than be softened into an advance.
      //
      // THE HARNESS PROBES; IT DOES NOT READ. The evidence is a live probe this
      // process performs — never `report.attestation` (the agent's narrative
      // echo) and never anything under VERIFY_ARTIFACTS_DIR (which the agent can
      // write). This runs HERE, inside the try, so it happens after the session
      // ended but before the `finally` tears the surface down: an attestation is
      // a question you can only ask something that is still alive, which is also
      // why the harness contract forbids the agent from stopping its own serve.
      let floor: AttestationFloorOutcome | null = null;
      if (report.outcome === 'pass') {
        const spec = effectiveAttestationSpec(req.task);
        // Only a channel that needs proving costs a probe: `file-identity` is
        // true by construction and "no spec" has nothing to ask.
        let probe: HarnessAttestationResult | null = null;
        if (spec !== null && spec.kind !== 'file-identity') {
          // (d2a) SERVE-IDENTITY BINDING — a PRECONDITION of the channel probe,
          // not a second opinion on it. The nonce proves a surface knows this
          // request's secret; the agent knows that secret too and chooses what
          // the driver serves, so "the surface answered" and "the surface is the
          // deliverable" are different claims. Binding answers the second one
          // from kernel truth. Run FIRST so a failure short-circuits the probe:
          // there is nothing to learn from interrogating a surface we have
          // already established was not started by this task's serve command.
          const binding = await this.bindServeIdentity(req, spec, logger);
          if (binding !== null && !binding.bound) {
            probe = {
              verified: false,
              kind: spec.kind,
              detail: `${SERVE_BINDING_FAILED_PREFIX} [${binding.failure}]: ${binding.detail}`,
            };
          } else {
            const attest = this.deps.attest ?? this.defaultAttest(logger);
            try {
              probe = await attest(spec, {
                verifyPort: req.verifyPort,
                driverPort: req.verifyDriverPort,
                nonce: attestNonce,
              });
            } catch (err) {
              // performHarnessAttestation never throws by contract; this catch is
              // the one cheap backstop for a mis-wired injection, and it exists
              // because the alternative is catastrophic in the wrong direction —
              // an escaping throw lands in the outer catch, which returns a
              // fail-open `skipped`, i.e. the lane ADVANCES on the exact unproven
              // pass this floor exists to block. Unverified is the safe reading.
              probe = {
                verified: false,
                kind: spec.kind,
                detail: `the harness attestation probe threw: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
        }
        floor = evaluateAttestationFloor(spec, probe);
        if (floor.kind === 'missing') {
          // Terminal FAIL, not a skip. The §3.1 classifier sees a report
          // outcome of 'pass' (not 'fail'), so this lands 'ambiguous' — which
          // REMAINS BLOCKING. That is §7.1's stated posture: without
          // foreign-occupancy evidence a missing attestation is ambiguous and
          // blocks, and calling it 'env' would advance the lane on a
          // verification that proved nothing.
          logger?.warn('[VerificationAgentRunner] attestation floor rejected a pass report', {
            runId: req.runId,
            requestId: req.requestId,
            modality,
            detail: floor.detail,
          });
          return {
            status: 'failed',
            errorMessage: `${ATTESTATION_MISSING_MESSAGE} (${floor.detail})`,
            report,
            fileNames: report.screenshots.map((s) => s.fileName),
            ...deployedProvenance,
          };
        }
      }

      // (e) Post-run mutation check — snapshot mode only (the fallback worktree is
      // expected to be dirty). A tracked-source mutation demotes to low_confidence.
      let mutated = false;
      if (mode === 'snapshot' && snapshot) {
        const checkMutated = this.deps.checkSnapshotMutated ?? defaultCheckSnapshotMutated;
        mutated = await checkMutated(snapshot.worktreePath);
      }

      // mapReportToResult already stamps deployed:true + provisionMode; the
      // preflight rides along so the scheduler persists it on EVERY terminal.
      // The report is persisted AS-IS (including the agent's own attestation
      // echo) — the floor changes the verdict, never the record of what the
      // agent said.
      return {
        ...applyAttestationCap(mapReportToResult(report, mode, mutated, verdictModel), floor),
        preflight,
      };
    } catch (err) {
      // The outer catch can fire before OR after the deploy; `deployedProvenance`
      // is not in scope here, so budget attribution falls back to the honest
      // "unknown ⇒ do not charge" answer (deployed:false). Under-charging by one
      // on a rare unexpected throw is preferable to charging a request that may
      // never have reached the SDK at all (§3.6).
      if (controller.signal.aborted) {
        return {
          status: 'timeout',
          deployed: false,
          preflight,
          ...(mode !== null ? { provisionMode: mode } : {}),
          errorMessage: 'deadline exceeded',
          fileNames: [],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger?.error('[VerificationAgentRunner] unexpected error', { runId: req.runId, error: message });
      emitSeamError('verify-agent-error', err instanceof Error ? err : new Error(message), {
        agentKey: 'visual-verify',
      });
      return {
        status: 'skipped',
        deployed: false,
        preflight,
        ...(mode !== null ? { provisionMode: mode } : {}),
        errorMessage: `agent runner error: ${message}`,
        fileNames: [],
      };
    } finally {
      // (f) Teardown — ALWAYS, abort-safe, best-effort. Stop the browser via the
      // driver, independently reap its pid, kill the serve's process group,
      // dispose the snapshot. The scheduler owns the leased-port probe +
      // quarantine after this returns.
      //
      // ORDERING IS LOAD-BEARING: every teardown below happens AFTER the
      // attestation probe in the try block, because the probe interrogates the
      // LIVE surface. Moving any of it earlier — or letting the agent do its own
      // cleanup, which is why the harness contract forbids that — would make
      // every declared channel unprovable and every honest pass a FAIL.
      req.signal.removeEventListener('abort', onAbort);
      controller.abort();
      if (driverScriptPath && env) {
        const stopDriver = this.deps.stopDriver ?? defaultStopDriver;
        try {
          await stopDriver(driverScriptPath, env);
        } catch (err) {
          logger?.debug('[VerificationAgentRunner] driver stop threw (ignored)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const reapBrowser = this.deps.reapBrowser ?? defaultReapBrowser;
      try {
        reapBrowser(req.artifactsDir);
      } catch {
        // best-effort
      }
      const reapServe = this.deps.reapServe ?? defaultReapServe;
      try {
        reapServe(req.artifactsDir);
      } catch {
        // best-effort
      }
      if (snapshot) {
        await snapshot.dispose();
      }
    }
  }
}
