/**
 * THE §5.4 ACCEPTANCE FAILURE-INJECTION MATRIX
 * (docs/proposals/verification-setup-flow.md §5.4), as scripted scenarios.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT MORE UNIT TESTS. Every module in
 * `verify/` already has a suite proving its own contract in isolation, and v1 of
 * the proposal proposed "3 consecutive green runs" as the acceptance bar. v2
 * threw that out with a one-line argument worth restating: *three warmed
 * happy-path passes prove none of the guarantees this proposal exists for.* The
 * failures this phase was built to stop are all COMPOSITIONAL — a squatted port
 * that becomes a lane-blocking FAIL because the classifier never saw the
 * preflight; a drifted runbook that still executes because the demotion happened
 * in a store nobody re-read; an install command that reaches a snapshot because
 * one of the two enqueue seams forgot the guard. None of those can fail in a
 * module test, because in a module test the collaborator that would have caught
 * them is a stub.
 *
 * So each row below drives the REAL {@link VerificationScheduler}, the REAL
 * {@link VerificationAgentRunner}, the REAL {@link VerifyRunbookStore} /
 * {@link VerifyCapabilityStore}, and the REAL enqueue seam
 * ({@link prepareVerificationEnqueue}) over a migration-backed in-memory DB. Only
 * the OUTSIDE WORLD is faked, and only at the seams the modules already inject
 * for exactly this purpose: the SDK query, the chromium/port/screen probes, the
 * harness's §7.1 identity probe, and (for the two dependency rows) the `cp`
 * that builds a mirror. Nothing between `enqueue()` and the persisted terminal
 * row is a stub — which is the only way a row can be evidence about the SYSTEM
 * rather than about one module's opinion of its neighbours.
 *
 * ONE ROW IS DELIBERATELY NOT AUTOMATED. §5.4 says "every row is a scripted
 * scenario, runnable unattended EXCEPT the consent row" — the native-screen
 * consent gate moves the user's real pointer, and §4's v1 policy is explicit
 * per-run go-ahead. That row is a `it.todo` naming the decision it is waiting
 * on; what IS asserted here is the contract that actually exists today
 * (observe-only: `requiresDrive` behaviors coerced to `not_testable`, and a
 * capability-less host skipped before any lease is taken).
 *
 * READING A FAILURE HERE. A red row is a claim about the composition, so the
 * useful first question is never "which assertion broke" but "which seam stopped
 * agreeing with its neighbour". The row titles are written to make that
 * answerable: each names the injected fault and the observable §5.4 requires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import {
  VerificationScheduler,
  ResourceLeasePool,
  VERIFY_NO_RUNBOOK_REASON,
  type VerificationSchedulerDeps,
} from '../verificationScheduler';
import {
  VerificationAgentRunner,
  VerificationAgentQueryError,
  ATTESTATION_MISSING_MESSAGE,
  ATTESTATION_UNCAPPED_MESSAGE,
  RUNBOOK_MISMATCH_PREFIX,
  TRANSPORT_MID_SESSION_MESSAGE,
  type VerificationAgentRunnerDeps,
  type ResolvedVerifyAgent,
} from '../verificationAgentRunner';
import type { HarnessAttestationResult } from '../harnessAttestation';
import { VerifyCapabilityStore, CAPABILITY_BREAKER_THRESHOLD } from '../capabilityStore';
import { VerifyRunbookStore, type VerifyRunbookStoreDeps } from '../runbookStore';
import { VerifyDepPreparer, defaultDepExec, type DepExec } from '../depPreparer';
import { captureSnapshotSha, provisionSnapshot, type SnapshotProvision } from '../snapshotProvisioner';
import { prepareVerificationEnqueue } from '../enqueueFromTask';
import { decideMergeGate, isMergeGateBlocking } from '../mergeGateLaneAdvance';
import { Mutex } from '../../../utils/mutex';
import { setSeamErrorSink } from '../../telemetrySink';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';
import type {
  ResolvedVisualVerifyConfig,
  VerificationModality,
  VerificationReportV1,
  VerificationTaskV1,
  VerificationType,
  VerdictV1,
  VlmJudge,
} from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// The DB: real migrations, not a hand-rolled schema
// ---------------------------------------------------------------------------

/** The project/run worktree every row probes unless it needs a real git tree. */
const LIVE_WORKTREE = '/live/worktree';

const MIG_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');

/**
 * The minimal REAL migration chain that stands up everything a matrix row
 * touches, in order: the core run/workflow tables (006–016), `workflow_runs
 * .batch_id` (022 — the merge-gate's lane attribution reads it), the
 * verification queue + per-project budget (055/056), the run's agent-provider
 * stamp (062), the agent-engine request columns `task_json`/`report_json`/
 * `delivery_state`/`snapshot_sha`/`enqueue_key` (078), the phase-0 failure-class
 * + modality + `setup_proof` columns (095), and the phase-2 runbook record +
 * request PIN (096).
 *
 * Hand-rolling this schema (as the older scheduler suites do) is fine for a
 * module test and WRONG here: half of what this file asserts is that a column
 * added by a migration is actually read by the code that claims to read it, and
 * a hand-rolled table is a place where that can silently be true in the test and
 * false in production. The chain is also the cheapest available proof that 095
 * and 096 apply cleanly on top of the real 078 shape.
 */
const MIGRATION_CHAIN = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '022_sprint_batches.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
  '062_workflow_run_agent_provider.sql',
  '078_verification_agent_requests.sql',
  '095_verify_failure_classes.sql',
  '096_verify_runbook_local.sql',
] as const;

/**
 * `projects` is created by hand because it predates the file-based migrations
 * (the same reason capabilityStore.test.ts / runbookStore.test.ts do it) —
 * WITHOUT `visual_verify_budget_calls`, which migration 056 in the chain adds
 * itself. Pre-creating that column would make 056 fail on a duplicate name and
 * silently abandon the REST of that file, which is where `judge_calls_used`
 * lives — i.e. the budget assertions would pass against a table that never got
 * the column they are about.
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const file of MIGRATION_CHAIN) db.exec(readFileSync(path.join(MIG_DIR, file), 'utf-8'));
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Matrix', LIVE_WORKTREE);
  return db;
}

/**
 * Seed the `workflows` parent row (a real FK, unlike the hand-rolled schemas)
 * plus one AGENT-STAMPED run. `verify_chain = ['agent']` is what routes the
 * request to the runner rather than the capture-backend waterfall, and
 * `verify_enabled = 1` is what the enqueue seam reads.
 */
function seedRun(dbX: Database.Database, runId: string, worktreePath: string = LIVE_WORKTREE): void {
  dbX
    .prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode)
       VALUES ('wf-matrix', 1, 'sprint', '{}', 'default')`,
    )
    .run();
  dbX
    .prepare(
      `INSERT INTO workflow_runs
         (id, workflow_id, project_id, status, worktree_path, verify_enabled, verify_type, verify_chain, agent_provider)
       VALUES (?, 'wf-matrix', 1, 'running', ?, 1, 'interactive-web-behavior', ?, 'claude')`,
    )
    .run(runId, worktreePath, JSON.stringify(['agent']));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'interactive-web-behavior',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [29260, 29262],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
  agentSlots: 2,
  autoBootstrapRunbook: false,
};

/** The leased pair every row's request gets: the pool's first slot and its driver sidecar. */
const LEASED_PORT = 29260;
const DRIVER_PORT = LEASED_PORT + 1;

/** How long a row waits on `awaitTerminal` before calling the scheduler wedged. */
const TERMINAL_DEADLINE_MS = 20_000;
const TERMINAL_POLL_MS = 5;

const fakeJudge: VlmJudge = {
  judge: async (): Promise<VerdictV1> => {
    throw new Error('the agent engine never calls the VLM judge — a call here is a routing bug');
  },
};

/**
 * The portable runbook the matrix's project "committed". Declares the two
 * modalities the roster supports on this host plus their §7.1 attestation
 * channels — `attestation` is REQUIRED per modality by the portable contract,
 * which is what makes "no attestation ⇒ no passed" enforceable at all.
 */
function baseRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: {
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}', readyWhen: { urlPath: '/' } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      },
      'cdp-app': {
        serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1' },
      },
      'native-screen': {
        serve: { cmd: 'electron .' },
        attestation: { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
      },
    },
  };
}

/**
 * What task-verify actually composes for a lane: behaviors PLUS its own guessed
 * `build`/`serve`. The guess is deliberately present rather than left blank —
 * §1's diagnosis is that the composer guesses build/serve and has been wrong
 * every time, and §5.2's merge exists to REPLACE that guess with the proven
 * runbook's commands. A fixture with no guess would quietly change what the
 * degrade gate sees when an injection is declined (a task with neither build nor
 * serve derives no environment and is exempt), which would make the drift rows
 * assert nothing.
 */
function composedTask(overrides: Partial<VerificationTaskV1> = {}): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'the settings panel shows the new toggle',
    taskRef: 'TASK-1',
    build: ['pnpm run build'],
    serve: { cmd: 'pnpm dev --port ${PORT}' },
    behaviors: [{ id: 'b1', description: 'the toggle renders', expected: 'visible, default off' }],
    ...overrides,
  };
}

/**
 * The DEGENERATE pre-live shape: a bare target, nothing to build, nothing to
 * serve. Built as its own factory rather than as an override of
 * {@link composedTask} because the point is the ABSENCE of `build`/`serve`, and
 * an object spread cannot remove keys — a "degenerate" task that still carried
 * them would be routed through the degrade gate it is supposed to be exempt from.
 */
function degenerateTask(
  target: { url?: string; htmlPath?: string },
  overrides: Partial<VerificationTaskV1> = {},
): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'the prerendered page renders',
    taskRef: 'TASK-1',
    target,
    behaviors: [{ id: 'b1', description: 'the toggle renders', expected: 'visible, default off' }],
    ...overrides,
  };
}

function passReport(overrides: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'the toggle' }],
    outcome: 'pass',
    confidence: 0.92,
    feedback: 'the toggle renders, default off',
    issues: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The runbook store, with mutable fake IO
// ---------------------------------------------------------------------------

/**
 * The three environment facts `VerifyRunbookStore.status()` re-checks on every
 * read, made mutable so a row can inject exactly one drift at a time. That
 * granularity is the point: §5.3 says "ANY component changing demotes", and a
 * matrix row that changed two at once could not tell which one the store
 * actually noticed.
 */
interface RunbookIo {
  /** dirPath → portable runbook text. An absent key is the "this tree lacks the file" case (never a demotion). */
  files: Map<string, string>;
  inputHash: string | null;
  fingerprint: string;
}

function makeRunbookIo(probePath: string = LIVE_WORKTREE): RunbookIo {
  return {
    files: new Map([[probePath, JSON.stringify(baseRunbook())]]),
    inputHash: 'inputs-v1',
    fingerprint: 'host-v1',
  };
}

function makeRunbookStore(dbX: Database.Database, io: RunbookIo): VerifyRunbookStore {
  const deps: VerifyRunbookStoreDeps = {
    readPortableFile: async (dirPath) => io.files.get(dirPath) ?? null,
    computeInputHash: async () => io.inputHash,
    hostFingerprint: async () => io.fingerprint,
  };
  return new VerifyRunbookStore(dbAdapter(dbX), deps);
}

/**
 * Drive one modality to `'proven'` the short way (register the derived draft,
 * then flip it). The ENGINE-enforced flip — a `setup_proof` request that
 * actually passed — is covered by verificationSchedulerAgent.test.ts's §5.3
 * suite; here proving is a PRECONDITION of the row under test, not its subject,
 * and going through a full proof run for every row would make each one assert
 * two things at once.
 */
async function proveModality(
  store: VerifyRunbookStore,
  modality: VerificationModality,
  probePath: string = LIVE_WORKTREE,
): Promise<{ hash: string; version: number }> {
  const registered = await store.registerDraft(1, probePath, modality);
  if ('error' in registered) throw new Error(`registerDraft failed: ${registered.error}`);
  const proven = store.markProven(1, modality, registered.hash, registered.version, '{"fixture":true}');
  expect(proven).toEqual({ ok: true });
  return registered;
}

// ---------------------------------------------------------------------------
// The runner, with every outside-world seam injected
// ---------------------------------------------------------------------------

/**
 * The injected environment ONE scenario runs against. Mutable (rather than
 * passed per call) so a row can change the world between requests — which is
 * precisely what the breaker row and the drift rows are about.
 */
interface RunnerWorld {
  /** `resolveChromium`: a path, or `null` for the "chromium removed" env fault. */
  chromium: string | null;
  /** Ports a FOREIGN process holds. `portFreeProbe` answers false for these. */
  occupiedPorts: Set<number>;
  /** What the (faked) SDK session returns as its structured report. */
  report: VerificationReportV1;
  /**
   * A RAW structured-output override, boxed so `null` is expressible: the
   * gate-integrity rows need the session to return something that is NOT a
   * valid report (prose, a truncated object, nothing at all), which
   * {@link RunnerWorld.report}'s type cannot say. Absent ⇒ `report` is returned.
   */
  structuredOverride: { value: unknown } | null;
  /**
   * When set, the SDK seam THROWS this instead of returning — a transport-level
   * failure of the deployed session (a reset, a 5xx, a closed stream). Distinct
   * from a bad report on purpose: the exception comes from the harness's own SDK
   * layer, so model content cannot manufacture it.
   */
  queryError: Error | null;
  /**
   * The runner's `fileExists` probe; `null` = everything exists. A row that
   * makes a specific basename absent is injecting the PHANTOM-SCREENSHOT fault
   * — a report citing evidence no driver ever wrote.
   */
  fileExists: ((absPath: string) => Promise<boolean>) | null;
  /**
   * What the HARNESS's own §7.1 identity probe concludes about the live
   * surface. This is a probe RESULT, not a file the agent could have written:
   * the runner performs the attestation itself, post-session and pre-teardown,
   * so nothing under VERIFY_ARTIFACTS_DIR can influence it.
   */
  attest: HarnessAttestationResult;
  /** `nativeCaptureProbe` for the runner's preflight; `null` = not wired (check omitted). */
  nativeCapture: (() => Promise<boolean>) | null;
  /** Provisioning seam; `null` = the fake in-memory snapshot below. */
  provision: VerificationAgentRunnerDeps['provision'] | null;
  /** §5.2 seam-3 pin resolution; `null` = unwired (the runner's pin check does not run). */
  resolveRunbookByHash: VerificationAgentRunnerDeps['resolveRunbookByHash'] | null;
  /**
   * One entry per SDK session actually deployed, holding that session's composed
   * user prompt. Length is what the budget / "never deployed" assertions read —
   * `judge_calls_used` alone cannot distinguish "no session" from "a session the
   * scheduler declined to charge", and §3.6 is a claim about both.
   */
  deploys: string[];
  /**
   * §7.1 SERVE-IDENTITY BINDING: how the deployed session's serve step behaves,
   * as the KERNEL would report it. `'none'` is an honest serve of the composed
   * task's own command; the other three are the forgeries the binding exists to
   * catch. Injected as a fault knob rather than as three probe overrides so a row
   * names the SCENARIO ("the agent served a decoy") instead of restating the
   * fake's plumbing.
   */
  serveFault: 'none' | 'no-pid-file' | 'foreign-listener' | 'substituted-command';
  /**
   * What the fake session actually started, filled in BY the fake session from
   * the task it was handed (see {@link recordFakeServe}) — which is the honest
   * shape, since in production the agent is the one who runs the serve command
   * and the harness only ever learns about it afterwards, from the OS. `null`
   * when the composed task has no serve at all (the degenerate rows), which is
   * exactly when the runner must not consult the probes.
   */
  serve: { leaderPid: number; listenerPid: number; port: number; leaderCommand: string } | null;
}

/** The detached process-GROUP leader the driver's `serve` records, in the fake kernel below. */
const SERVE_LEADER_PID = 7100;
/** A child of that leader (the node the shell forked) — what actually holds the port. */
const SERVE_LISTENER_PID = 7101;
/** A listener belonging to something else entirely: its own group, its own command. */
const FOREIGN_LISTENER_PID = 9001;

/**
 * Recover the composed task from the prompt the runner handed the session —
 * `composeVerifyUserPrompt` embeds it as a ```json fence. Parsing it back is how
 * the fake session learns which serve command it is supposed to have started,
 * and it matters that the source is the PROMPT rather than the row's input: the
 * enqueue seam MERGES the proven runbook's commands over task-verify's guess, so
 * the command the agent runs is knowable only from what it was actually given.
 */
function taskFromPrompt(prompt: string): VerificationTaskV1 | null {
  const fence = /```json\n([\s\S]*?)\n```/.exec(prompt);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1]) as VerificationTaskV1;
  } catch {
    return null;
  }
}

/** The fake session "starts the serve", recording what the kernel would then report. */
function recordFakeServe(world: RunnerWorld, prompt: string): void {
  const serve = taskFromPrompt(prompt)?.serve;
  const cmd = serve?.cmd;
  const attach = serve?.attach === 'cdp';
  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    world.serve = null;
    return;
  }
  world.serve = {
    leaderPid: SERVE_LEADER_PID,
    listenerPid: world.serveFault === 'foreign-listener' ? FOREIGN_LISTENER_PID : SERVE_LISTENER_PID,
    // In attach mode the app IS the CDP endpoint on the driver port; otherwise
    // the deliverable is served on the leased one.
    port: attach ? DRIVER_PORT : LEASED_PORT,
    leaderCommand:
      world.serveFault === 'substituted-command'
        ? 'sh -c python3 -m http.server 29260 --directory /tmp/decoy'
        : `sh -c ${cmd}`,
  };
}

function makeWorld(overrides: Partial<RunnerWorld> = {}): RunnerWorld {
  return {
    chromium: '/opt/chromium',
    occupiedPorts: new Set<number>(),
    report: passReport(),
    structuredOverride: null,
    queryError: null,
    fileExists: null,
    attest: { verified: true, kind: 'http-endpoint', detail: 'endpoint echoed this request nonce' },
    nativeCapture: null,
    provision: null,
    resolveRunbookByHash: null,
    deploys: [],
    serveFault: 'none',
    serve: null,
    ...overrides,
  };
}

function makeAgent(): EffectiveAgent {
  return {
    agentKey: 'visual-verify',
    name: 'cyboflow-visual-verify',
    role: 'verify',
    description: 'drives and judges the deliverable',
    systemPrompt: 'SYSTEM PROMPT BODY',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
  };
}

/**
 * The REAL runner, with only the outside world faked. Everything the matrix is
 * actually about — preflight ordering, the pin check, the attestation floor, the
 * drive-unsupported coercion, the outcome→status mapping — is the module's own
 * code running unmodified.
 *
 * The fake `provision` is an in-memory stand-in for `git worktree add`: it still
 * reports `mode: 'snapshot'` (which the §3.1 classifier's `'deliverable'` gate
 * requires) without costing a real repo. The two DEPENDENCY rows override it
 * with the real provisioner, because for them the worktree IS the subject.
 */
function makeRunner(world: RunnerWorld): VerificationAgentRunner {
  const resolvedAgent: ResolvedVerifyAgent = {
    agent: makeAgent(),
    runProvider: 'claude',
    runModel: 'claude-sonnet-5',
  };
  const fakeProvision = async (): Promise<SnapshotProvision> => ({
    worktreePath: '/snap',
    sha: 'sha-matrix',
    dispose: async () => {},
  });
  const deps: VerificationAgentRunnerDeps = {
    query: async (args) => {
      // Recorded BEFORE the throw: a session that then failed in transport was
      // still deployed, and §3.6's budget claim is about deployment, not success.
      world.deploys.push(args.prompt);
      // …and the session brings the deliverable up, which is what the §7.1
      // binding will later interrogate the kernel about.
      recordFakeServe(world, args.prompt);
      if (world.queryError !== null) throw world.queryError;
      return {
        structured: world.structuredOverride !== null ? world.structuredOverride.value : world.report,
        transcript: null,
      };
    },
    resolveVerifyAgent: () => resolvedAgent,
    resolveClaudeAlias: (alias) => `claude-${alias}-resolved`,
    claudeDefaultModel: 'claude-opus-4-8',
    resolveNode: async () => '/usr/bin/node',
    driverCliPath: '/app/driverCli.js',
    provision: world.provision ?? fakeProvision,
    checkSnapshotMutated: async () => false,
    fileExists: world.fileExists ?? (async () => true),
    resolveChromium: async () => world.chromium,
    portFreeProbe: async (port) => !world.occupiedPorts.has(port),
    attest: async () => world.attest,
    // §7.1 serve-identity binding — the FAKE KERNEL. These three answer the only
    // questions the binding trusts (who owns the socket, what is that process),
    // and they are faked here because they are the outside world, not because the
    // binding is: every decision it makes runs unmodified above them.
    readServePid: async () =>
      world.serve !== null && world.serveFault !== 'no-pid-file' ? world.serve.leaderPid : null,
    listeningPidForPort: async (port) =>
      world.serve !== null && port === world.serve.port ? world.serve.listenerPid : null,
    processInfo: async (pid) => {
      const serve = world.serve;
      if (serve === null) return null;
      if (pid === serve.leaderPid) return { pgid: serve.leaderPid, command: serve.leaderCommand };
      if (pid === SERVE_LISTENER_PID) return { pgid: serve.leaderPid, command: 'node .bin/vite' };
      if (pid === FOREIGN_LISTENER_PID) return { pgid: FOREIGN_LISTENER_PID, command: 'node /elsewhere/vite' };
      return null;
    },
    writeDriverScript: async () => '/artifacts/.driver/verify-driver.sh',
    stopDriver: async () => {},
    reapBrowser: () => {},
    reapServe: () => {},
    writeTranscript: async () => {},
    ...(world.nativeCapture ? { nativeCaptureProbe: world.nativeCapture } : {}),
    ...(world.resolveRunbookByHash ? { resolveRunbookByHash: world.resolveRunbookByHash } : {}),
  };
  return new VerificationAgentRunner(deps);
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * The REAL scheduler singleton, wired the way index.ts wires it: the runbook
 * store answers BOTH the §3.2 degrade gate and the enqueue-side pin resolution,
 * and the capability ledger takes the classified outcome of every terminal.
 *
 * The scheduler's OWN `portFreeProbe` is deliberately left at its always-free
 * default even in the two squatter rows. That probe answers a different
 * question — "did this deployment leak the port at teardown", which decides
 * release-vs-QUARANTINE — and a quarantined slot would silently change how many
 * ports later requests in the same scenario can lease. The squatter is injected
 * where the row's claim lives: the RUNNER's pre-deploy preflight.
 */
function initScheduler(
  dbX: Database.Database,
  opts: {
    world: RunnerWorld;
    runbookStore?: VerifyRunbookStore;
    capabilityStore?: VerifyCapabilityStore;
    capabilityFinding?: VerificationSchedulerDeps['capabilityFinding'];
    nativeCaptureProbe?: () => Promise<boolean>;
    probePath?: string;
    /** A REAL artifacts dir, for the one row that writes a file into it and proves the harness ignores it. */
    artifactsDir?: string;
  },
): VerificationScheduler {
  const runbookStore = opts.runbookStore;
  const probePath = opts.probePath ?? LIVE_WORKTREE;
  const artifactsDir = opts.artifactsDir ?? '/artifacts';
  return VerificationScheduler.initialize({
    db: dbAdapter(dbX),
    backends: {},
    judge: fakeJudge,
    artifactsDirResolver: () => artifactsDir,
    config: CONFIG,
    leasePool: new ResourceLeasePool(new Mutex()),
    agentRunner: makeRunner(opts.world),
    capabilityStore: opts.capabilityStore ?? new VerifyCapabilityStore(dbAdapter(dbX)),
    ...(runbookStore
      ? {
          runbookStore,
          // Honors the CALLER's probe path (the gate now passes the run's
          // worktree) and falls back to the harness's — which is the same
          // ladder production runs, just with the fallback stubbed.
          runbookStatus: async (projectId, modality, callerProbePath) =>
            runbookStore.statusDetail(projectId, callerProbePath ?? probePath, modality),
        }
      : {}),
    ...(opts.capabilityFinding ? { capabilityFinding: opts.capabilityFinding } : {}),
    ...(opts.nativeCaptureProbe ? { nativeCaptureProbe: opts.nativeCaptureProbe } : {}),
  });
}

/**
 * Enqueue through the SHARED enqueue seam (`prepareVerificationEnqueue`) rather
 * than calling `scheduler.enqueue` directly, so every row exercises the §7.2
 * dependency guard and the §5.2 seam-3 proven-runbook injection + pin stamping
 * that a production enqueue would. A row that wants the UNPINNED, un-merged path
 * simply runs against a project with no proven runbook — which is the same thing
 * production does.
 */
async function enqueueThroughSeam(
  scheduler: VerificationScheduler,
  args: {
    runId: string;
    type?: VerificationType;
    task: VerificationTaskV1;
    /** An EXPLICIT `null` means "the sha capture failed" (⇒ the dirty-worktree fallback); omitted means the default sha. */
    snapshotSha?: string | null;
    setupProof?: boolean;
    probePath?: string;
    /**
     * A CALLER-SUPPLIED pin, stamped verbatim (the setup flow pinning the draft
     * it is proving, §5.2). Bypasses the proven-runbook resolution + merge, so a
     * row using it must compose a task that already matches the runbook entry.
     */
    pin?: { hash: string; localVersion: number };
  },
): Promise<string> {
  const type: VerificationType = args.type ?? 'interactive-web-behavior';
  const prepared = await prepareVerificationEnqueue({
    projectId: 1,
    runId: args.runId,
    type,
    task: args.task,
    ...(args.pin !== undefined ? { pin: args.pin } : {}),
    ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
  });
  if (!prepared.ok) throw new Error(`enqueue preparation rejected the task: ${prepared.error}`);
  const task = prepared.task ?? args.task;
  return scheduler.enqueue({
    runId: args.runId,
    projectId: 1,
    type,
    input: { intent: task.summary, taskRef: task.taskRef ?? 'TASK-1' },
    chain: [],
    task,
    // `?? ` would swallow an EXPLICIT null (the fallback-mode rows), so the two
    // absent-ish cases are distinguished here rather than collapsed.
    snapshotSha: args.snapshotSha === undefined ? 'sha-matrix' : args.snapshotSha,
    ...(args.setupProof === true ? { setupProof: true } : {}),
    ...(prepared.pin
      ? { runbookHash: prepared.pin.hash, runbookLocalVersion: prepared.pin.localVersion }
      : {}),
  });
}

/** The persisted row shape every row's assertions read. */
interface TerminalRow {
  status: string;
  error_message: string | null;
  failure_class: string | null;
  failure_evidence_json: string | null;
  preflight_json: string | null;
  modality: string | null;
  judge_calls_used: number;
  runbook_hash: string | null;
}

function readRow(dbX: Database.Database, requestId: string): TerminalRow {
  return dbX
    .prepare(
      `SELECT status, error_message, failure_class, failure_evidence_json, preflight_json,
              modality, judge_calls_used, runbook_hash
         FROM verification_requests WHERE id = ?`,
    )
    .get(requestId) as TerminalRow;
}

function evidenceOf(row: TerminalRow): Array<{ source: string; check: string; detail: string }> {
  return JSON.parse(row.failure_evidence_json ?? '[]') as Array<{
    source: string;
    check: string;
    detail: string;
  }>;
}

function preflightOf(row: TerminalRow): { ok: boolean; checks: Array<{ id: string; ok: boolean }> } | null {
  return row.preflight_json === null
    ? null
    : (JSON.parse(row.preflight_json) as { ok: boolean; checks: Array<{ id: string; ok: boolean }> });
}

/** Runbook record state, read straight from migration 096's table. */
function runbookRecord(dbX: Database.Database, modality = 'web'): { status: string; version: number } | undefined {
  return dbX
    .prepare('SELECT status, version FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
    .get(modality) as { status: string; version: number } | undefined;
}

// ---------------------------------------------------------------------------
// Real-git fixture (the two dependency rows only)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A throwaway repo with one commit, a lockfile + manifest (the preparer's key inputs), and a node_modules. */
async function initDepFixtureRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@cyboflow.dev']);
  git(dir, ['config', 'user.name', 'Cyboflow Test']);
  await fsPromises.writeFile(path.join(dir, 'README.md'), 'v1\n');
  await fsPromises.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fsPromises.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'matrix-fixture' }));
  await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'live-tree\n');
  git(dir, ['add', 'README.md', 'pnpm-lock.yaml', 'package.json']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

/**
 * A `DepExec` that shells out to the REAL `cp` on POSIX (so the preparer's own
 * existence checks run against real directories, and the published mirror is a
 * real tree the snapshot can clone from) and records every invocation. The
 * Electron ABI rebuild is a recorded no-op — §7.2 puts it here on purpose, and
 * the two rows below assert WHERE it happens, never that it works.
 *
 * Real `cp` rather than `fsPromises.cp`: the latter REWRITES a relative symlink
 * into an absolute path back into the source tree, which is the §7.2 finding-6
 * breakage in miniature. A mirror built that way would make these rows assert
 * against a fixture the production path never produces.
 *
 * On win32 the preparer clones with robocopy (see cloneDir) — the fixture arm
 * performs the copy via fsPromises.cp, which is safe HERE: the fixture tree
 * carries no symlinks, so the rewriting caveat does not apply.
 */
const CLONE_CMD = process.platform === 'win32' ? 'robocopy' : 'cp';

function recordingDepExec(calls: Array<{ cmd: string; args: string[] }>): DepExec {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === 'cp') return defaultDepExec(cmd, args, opts);
    if (cmd === 'robocopy') {
      await fsPromises.cp(args[0], args[1], { recursive: true });
      return { code: 0, out: '' };
    }
    return { code: 0, out: '' };
  };
}

// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  setSeamErrorSink(() => {});
  // HERMETICITY: with no explicit preparer, `provisionSnapshot` resolves the
  // DEFAULT one, whose cache lives under `CYBOFLOW_DIR|~/.cyboflow`. No test may
  // build a prepared set in the user's real data dir; the two rows that DO
  // exercise the preparer inject their own (an explicit preparer bypasses this
  // switch). Same posture as snapshotProvisioner.test.ts.
  process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER = '1';
  db = buildDb();
  VerificationScheduler._resetForTesting();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
  delete process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER;
});

// ===========================================================================
// Rows 1 + 2 — cold deps / warm deps
//
// §5.4: "cold deps (fresh prepared-set build) → green within deadline" and
// "warm deps → green". The observable that matters is not merely 'passed': it
// is WHAT the snapshot's node_modules IS. Until the §7.2 review it was a
// SYMLINK, so anything the verification wrote landed in whatever the link
// pointed at — the live worktree every sibling lane builds against, or (after
// the preparer landed) the shared cache. It is now a CLONE into the snapshot,
// and these rows assert that end state the only way that means anything: write
// into it and prove the write reached neither the worktree nor the cache. A
// green run over an aliased tree would satisfy a naive assertion and prove
// nothing.
// ===========================================================================

describe('§5.4 matrix — dependency preparation', () => {
  /** What one provisioned snapshot looked like, read BEFORE the runner disposed it. */
  interface SnapshotDepProbe {
    /** Whether the snapshot's node_modules was an alias of something else (must be false). */
    isSymlink: boolean;
    /** The mirror-sourced marker the clone carried in. */
    marker: string;
    /** Absolute path of the file this probe wrote INTO the snapshot's dep dir. */
    writtenPath: string;
  }

  /** The file name a probe writes into the snapshot, standing in for anything a build step does. */
  const SNAPSHOT_WRITE = 'written-by-verification.txt';

  /**
   * Runs one full verification against a REAL git repo + a REAL prepared-set
   * cache, with only the ABI rebuild faked (the `cp` is real — see
   * {@link recordingDepExec}). Returns the terminal status, one probe per
   * snapshot provisioned, and every exec the preparer performed.
   */
  async function runAgainstRealRepo(ctx: {
    repo: string;
    cacheDir: string;
    execCalls: Array<{ cmd: string; args: string[] }>;
    runId: string;
  }): Promise<{ status: string; probes: SnapshotDepProbe[] }> {
    const io = makeRunbookIo(ctx.repo);
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web', ctx.repo);

    const preparer = new VerifyDepPreparer({
      baseDir: ctx.cacheDir,
      exec: recordingDepExec(ctx.execCalls),
    });
    const probes: SnapshotDepProbe[] = [];
    const world = makeWorld({
      // The REAL provisioner: a real detached worktree, real dependency-dir
      // discovery, real cloning — wrapped only to inspect and write into the
      // snapshot BEFORE `dispose()` removes the tree in the runner's finally
      // block. The write is the point: it is what a `pnpm install`, a
      // hand-edited module, or a build artifact would do from inside the agent's
      // Bash session, performed here where the assertions can see where it lands.
      provision: async (opts) => {
        const provision = await provisionSnapshot({ ...opts, depPreparer: preparer });
        const depDir = path.join(provision.worktreePath, 'node_modules');
        const writtenPath = path.join(depDir, SNAPSHOT_WRITE);
        await fsPromises.writeFile(writtenPath, 'from inside the verification\n');
        probes.push({
          isSymlink: (await fsPromises.lstat(depDir)).isSymbolicLink(),
          marker: await fsPromises.readFile(path.join(depDir, 'marker.txt'), 'utf8'),
          writtenPath,
        });
        return provision;
      },
      resolveRunbookByHash: (projectId, modality, hash) => store.getByHash(projectId, modality, hash),
    });

    seedRun(db, ctx.runId, ctx.repo);
    const scheduler = initScheduler(db, { world, runbookStore: store, probePath: ctx.repo });
    const sha = await captureSnapshotSha(ctx.repo);
    const requestId = await enqueueThroughSeam(scheduler, {
      runId: ctx.runId,
      task: composedTask(),
      snapshotSha: sha,
      probePath: ctx.repo,
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    return { status: outcome.status, probes };
  }

  /** Every published prepared set under the cache root (the fixtures build exactly one). */
  async function publishedSets(cacheDir: string): Promise<string[]> {
    const entries = await fsPromises.readdir(cacheDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(cacheDir, e.name));
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fsPromises.lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  it('COLD: the preparer builds a fresh mirror, the snapshot gets its OWN clone of it, and the run is green', async () => {
    await withTempDir('matrix-cold-deps-', async (root) => {
      const repo = path.join(root, 'repo');
      await fsPromises.mkdir(repo, { recursive: true });
      await initDepFixtureRepo(repo);
      const cacheDir = path.join(root, 'verify-deps');
      const execCalls: Array<{ cmd: string; args: string[] }> = [];

      const { status, probes } = await runAgainstRealRepo({
        repo,
        cacheDir,
        execCalls,
        runId: 'run-cold',
      });

      expect(status).toBe('passed');

      // A mirror was BUILT (cold): the preparer's clone ran at least once.
      expect(execCalls.filter((c) => c.cmd === CLONE_CMD).length).toBeGreaterThan(0);
      const sets = await publishedSets(cacheDir);
      expect(sets).toHaveLength(1);
      expect(await exists(path.join(sets[0], 'node_modules', 'marker.txt'))).toBe(true);

      // The snapshot's node_modules is the mirror's CONTENT in the snapshot's
      // OWN directory — carrying the prepared tree in, aliasing nothing out.
      expect(probes).toHaveLength(1);
      expect(probes[0].isSymlink).toBe(false);
      expect(probes[0].marker).toBe('live-tree\n');

      // …so the write taken from inside the snapshot reached neither the shared
      // worktree nor the shared cache. This is the §7.2 hazard, closed — and
      // closed on the path a regex over build commands could never have covered,
      // because this write never was a command.
      expect(await exists(probes[0].writtenPath)).toBe(false); // gone with the snapshot
      expect(await exists(path.join(repo, 'node_modules', SNAPSHOT_WRITE))).toBe(false);
      expect(await exists(path.join(sets[0], 'node_modules', SNAPSHOT_WRITE))).toBe(false);
    });
  }, 60_000);

  it('WARM: a second verification reuses the published set — no re-clone by the preparer, a fresh snapshot copy, still green', async () => {
    await withTempDir('matrix-warm-deps-', async (root) => {
      const repo = path.join(root, 'repo');
      await fsPromises.mkdir(repo, { recursive: true });
      await initDepFixtureRepo(repo);
      const cacheDir = path.join(root, 'verify-deps');
      const execCalls: Array<{ cmd: string; args: string[] }> = [];

      const first = await runAgainstRealRepo({ repo, cacheDir, execCalls, runId: 'run-warm-1' });
      expect(first.status).toBe('passed');
      const clonesAfterCold = execCalls.filter((c) => c.cmd === CLONE_CMD).length;
      expect(clonesAfterCold).toBeGreaterThan(0);

      // A fresh scheduler singleton for the second request — the cache is on
      // DISK, so reuse must not depend on any in-process memo surviving.
      VerificationScheduler._resetForTesting();
      const second = await runAgainstRealRepo({ repo, cacheDir, execCalls, runId: 'run-warm-2' });

      expect(second.status).toBe('passed');
      // The whole point of the cache: the published set was ADOPTED, not rebuilt.
      expect(execCalls.filter((c) => c.cmd === CLONE_CMD).length).toBe(clonesAfterCold);

      // And the warm path is no less isolated than the cold one: the second
      // snapshot got its own clone of the SAME mirror, and the first run's write
      // is nowhere in it — a shared set stays pristine across reuses precisely
      // because nothing ever writes into it through a snapshot.
      expect(second.probes).toHaveLength(1);
      expect(second.probes[0].isSymlink).toBe(false);
      expect(second.probes[0].marker).toBe('live-tree\n');
      const sets = await publishedSets(cacheDir);
      expect(sets).toHaveLength(1);
      expect(await exists(path.join(sets[0], 'node_modules', SNAPSHOT_WRITE))).toBe(false);
      expect(await exists(path.join(repo, 'node_modules', SNAPSHOT_WRITE))).toBe(false);
    });
  }, 60_000);
});

// ===========================================================================
// Rows 3 + 4 — a foreign process holds the port the harness leased
// ===========================================================================

describe('§5.4 matrix — leased port pre-occupied by a foreign process', () => {
  it("ROW 3: env-skip via preflight, failure_class 'env', budget uncharged, and the merge gate ADVANCES with zero attempt increment", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The §1(e) false-ready incident, reproduced: the pool handed out a logical
    // slot while a stale server from an unrelated worktree still owned the OS
    // socket. The connect probe is the only thing that can see that.
    const world = makeWorld({ occupiedPorts: new Set([LEASED_PORT]) });
    seedRun(db, 'run-squatted');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-squatted', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('skipped');
    const row = readRow(db, requestId);
    expect(row.failure_class).toBe('env');

    // HARNESS-derived provenance, never model prose — the conservative rule
    // that makes an advancing skip safe at all (§3.1).
    const evidence = evidenceOf(row);
    expect(evidence).toContainEqual(
      expect.objectContaining({ source: 'port-probe', check: 'port-free' }),
    );
    expect(evidence[0].detail).toContain('squatter');

    // Nothing was deployed and nothing was charged (§3.6): a misconfigured host
    // must not spend a project's lifetime budget discovering it is misconfigured.
    expect(world.deploys).toHaveLength(0);
    expect(row.judge_calls_used).toBe(0);
    expect(preflightOf(row)?.ok).toBe(false);

    // §5.4's actual requirement — "ZERO lane-attempt increment". The merge gate
    // ADVANCES a skip (R4), and an advance carries no attempt at all; a
    // `loopback-implement` here would be the bug this row exists to catch.
    const action = decideMergeGate({ status: 'skipped', currentAttempts: 1 });
    expect(action).toEqual({ kind: 'advance-integrated' });
    expect(isMergeGateBlocking(action)).toBe(false);
  });

  it("ROW 4: the user's OWN app already holds the CDP endpoint — attach-mode env-skip on the driver port, chromium never probed", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'cdp-app');

    // Attach mode drives the app's own CDP endpoint on the DRIVER port, so that
    // is the port a running instance of the user's app squats.
    const world = makeWorld({ occupiedPorts: new Set([DRIVER_PORT]) });
    seedRun(db, 'run-own-instance');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    // The COMPOSER declares the attach shape (that is the modality-aware
    // task-verify contract) — which is what makes the enqueue seam resolve the
    // `cdp-app` runbook at all — and the proven entry then replaces its guessed
    // command with the one the proof actually validated.
    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-own-instance',
      task: composedTask({
        summary: 'the app window renders the new panel',
        serve: { cmd: 'electron .', attach: 'cdp' },
      }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(row.modality).toBe('cdp-app'); // the runbook merge really did produce an attach task
    expect(outcome.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(evidenceOf(row)).toContainEqual(
      expect.objectContaining({ source: 'port-probe', check: 'driver-port-free' }),
    );
    expect(world.deploys).toHaveLength(0);
    expect(row.judge_calls_used).toBe(0);

    // Attach mode never launches a browser, so the chromium probe is INAPPLICABLE
    // — recorded as absent, not as a passing check (preflight.ts's applicability
    // rule). A chromium entry here would mean the modality axis was ignored.
    const checkIds = preflightOf(row)?.checks.map((c) => c.id) ?? [];
    expect(checkIds).not.toContain('chromium');
    expect(checkIds).not.toContain('port-free'); // attach mode binds nothing itself
    expect(checkIds).toContain('driver-port-free');
  });
});

// ===========================================================================
// Row 5 — app restart mid-queue
// ===========================================================================

describe('§5.4 matrix — app restart mid-queue', () => {
  it('every in-flight row terminalizes or re-drains through recovery; none is left wedged', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    seedRun(db, 'run-restart');

    /** Seed a row in a state a crash could leave behind (no in-process worker owns it). */
    function seedRequest(id: string, status: 'queued' | 'leased' | 'running'): void {
      db.prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt,
            task_json, snapshot_sha, modality, setup_proof, enqueued_at)
         VALUES (?, 'run-restart', 1, ?, 'static-render-snapshot', ?, '[]', 0, ?, 'sha-matrix', 'web', 0, CURRENT_TIMESTAMP)`,
      ).run(
        id,
        status,
        JSON.stringify({ intent: 'verify the widget', taskRef: 'TASK-1' }),
        // A DEGENERATE pre-live task: it derives no environment, so the §3.2
        // gate exempts it and the queued row can actually drain to a verdict
        // rather than skipping for an unrelated reason.
        JSON.stringify(degenerateTask({ htmlPath: '/out/index.html' })),
      );
    }

    seedRequest('vr_restart_queued', 'queued');
    seedRequest('vr_restart_leased', 'leased');
    seedRequest('vr_restart_running', 'running');

    const world = makeWorld();
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const recovered = await scheduler.runRecovery();
    // The two ORPHANS (leased/running) are force-terminalized; the fresh queued
    // row is not stale, so recovery leaves it queued and NUDGES the drain.
    expect(recovered).toBe(2);

    const outcomes = await Promise.all(
      ['vr_restart_queued', 'vr_restart_leased', 'vr_restart_running'].map((id) =>
        scheduler.awaitTerminal(id, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS),
      ),
    );

    // NOTHING is wedged: every seeded row reached a terminal status.
    const statuses = db
      .prepare('SELECT id, status FROM verification_requests ORDER BY id')
      .all() as Array<{ id: string; status: string }>;
    expect(statuses.every((r) => !['queued', 'leased', 'running'].includes(r.status))).toBe(true);

    // The orphans are honest about WHY they died…
    const leased = readRow(db, 'vr_restart_leased');
    expect(leased.status).toBe('timeout');
    expect(leased.error_message).toBe('orphaned by process restart');
    expect(readRow(db, 'vr_restart_running').status).toBe('timeout');

    // …and the survivor actually RAN post-restart rather than being swept.
    expect(outcomes[0].status).toBe('passed');
    expect(world.deploys).toHaveLength(1);

    // Every terminal drives a parked lane OFF awaiting-verify (R4) — a wedged
    // sprint is exactly what recovery exists to prevent.
    for (const outcome of outcomes) {
      expect(decideMergeGate({ status: outcome.status, currentAttempts: 1 }).kind).toBe(
        'advance-integrated',
      );
    }
  });
});

// ===========================================================================
// Row 6 — injected deliverable regression
// ===========================================================================

describe('§5.4 matrix — injected deliverable regression', () => {
  it("a JUDGED snapshot-mode fail stays FAILED, is attributed 'deliverable', and loops the lane back", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    const proven = await proveModality(store, 'web');

    // The broken-renderer commit: the environment is fine (preflight all green,
    // real snapshot mode) and the agent DROVE the behavior and judged it failed.
    const world = makeWorld({
      report: passReport({
        behaviors: [
          { id: 'b1', result: 'fail', evidence: { screenshots: ['s.png'], notes: 'the toggle never rendered' } },
        ],
        outcome: 'fail',
        feedback: 'the toggle never rendered',
      }),
    });
    const capability = new VerifyCapabilityStore(dbAdapter(db));
    const healthy = vi.spyOn(capability, 'recordHealthyOutcome');
    seedRun(db, 'run-regression');
    const scheduler = initScheduler(db, { world, runbookStore: store, capabilityStore: capability });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-regression',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('failed'); // NOT converted to a skip — the deliverable is what broke
    expect(row.failure_class).toBe('deliverable');
    expect(evidenceOf(row)).toContainEqual(
      expect.objectContaining({ source: 'report', check: 'report-outcome' }),
    );

    // The environment demonstrably worked (it built, served, drove and judged),
    // so this RESETS the breaker rather than counting toward it (§3.4).
    // …under THIS runbook revision's ledger key, not a shared '' bucket: an
    // obsolete revision's env failures must not suppress a newly proven one
    // (Codex finding 7).
    expect(healthy).toHaveBeenCalledWith(1, 'web', proven.hash);

    // §5.4: "lane loops back" — and it is BLOCKING, unlike every env skip above.
    const action = decideMergeGate({ status: 'failed', currentAttempts: 1 });
    expect(action).toEqual({ kind: 'loopback-implement', nextAttempt: 2 });
    expect(isMergeGateBlocking(action)).toBe(true);
  });
});

// ===========================================================================
// Row 7 — injected env fault (chromium removed)
// ===========================================================================

describe('§5.4 matrix — injected env fault (chromium removed)', () => {
  it('K consecutive preflight skips trip the breaker ONCE; the K+1th short-circuits on the suppression, and nothing is ever charged', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    const world = makeWorld({ chromium: null }); // the injected fault: no chromium on this host
    const capability = new VerifyCapabilityStore(dbAdapter(db));
    const capabilityFinding = vi.fn();
    seedRun(db, 'run-no-chromium');
    const scheduler = initScheduler(db, {
      world,
      runbookStore: store,
      capabilityStore: capability,
      capabilityFinding,
    });

    const requestIds: string[] = [];
    for (let i = 0; i < CAPABILITY_BREAKER_THRESHOLD; i++) {
      const id = await enqueueThroughSeam(scheduler, { runId: 'run-no-chromium', task: composedTask() });
      requestIds.push(id);
      await scheduler.awaitTerminal(id, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    }

    // Each one is an honest, evidence-backed env skip taken BEFORE any deploy.
    for (const id of requestIds) {
      const row = readRow(db, id);
      expect(row.status).toBe('skipped');
      expect(row.failure_class).toBe('env');
      expect(row.error_message).toContain('chromium not resolved');
      expect(evidenceOf(row)).toContainEqual(
        expect.objectContaining({ source: 'preflight', check: 'chromium' }),
      );
      expect(row.judge_calls_used).toBe(0);
    }
    expect(world.deploys).toHaveLength(0);

    // The breaker tripped exactly once — a modality going quiet is worth ONE
    // notice, not one per request.
    expect(capabilityFinding).toHaveBeenCalledTimes(1);
    expect(capabilityFinding).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, modality: 'web' }),
    );

    // The K+1th never reaches preflight at all: the ledger gates it pre-lease.
    const suppressedId = await enqueueThroughSeam(scheduler, {
      runId: 'run-no-chromium',
      task: composedTask(),
    });
    await scheduler.awaitTerminal(suppressedId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    const suppressed = readRow(db, suppressedId);
    expect(suppressed.status).toBe('skipped');
    expect(suppressed.error_message).toContain('verification suppressed for web');
    expect(suppressed.preflight_json).toBeNull(); // it did not even get that far
    expect(suppressed.judge_calls_used).toBe(0);
    expect(capabilityFinding).toHaveBeenCalledTimes(1); // still one
    expect(world.deploys).toHaveLength(0);
  });
});

// ===========================================================================
// Rows 8 + 9 — runbook drift
// ===========================================================================

describe('§5.4 matrix — runbook drift demotes a proven record', () => {
  it("ROW 8: an edited dev script (project input-hash drift) demotes to 'unproven-draft' and the request skips with the setup CTA", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');
    expect(runbookRecord(db)?.status).toBe('proven');

    // The drift: the project's dev/build scripts (or lockfile, or electron
    // version) moved under a proof that was taken against the old ones.
    io.inputHash = 'inputs-v2';

    const world = makeWorld();
    seedRun(db, 'run-input-drift');
    const scheduler = initScheduler(db, { world, runbookStore: store });
    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-input-drift',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    // The demotion is a WRITE-THROUGH on read: whoever asked next corrected the
    // record, rather than leaving a green badge lying for a human to find.
    expect(runbookRecord(db)?.status).toBe('unproven-draft');

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('skipped');
    expect(row.error_message).toBe(VERIFY_NO_RUNBOOK_REASON); // the setup CTA
    expect(row.failure_class).toBe('env');
    // Unpinned, because the enqueue-side resolver asked the same demoted store.
    expect(row.runbook_hash).toBeNull();
    expect(world.deploys).toHaveLength(0);
  });

  it('ROW 9: host-fingerprint drift demotes; a fresh derive + proof restores it and the build/serve task deploys again', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    const firstProof = await proveModality(store, 'web');

    // The drift: a different chromium, a flipped TCC grant, a node major bump —
    // anything the proof's host fingerprint covered.
    io.fingerprint = 'host-v2';

    const world = makeWorld();
    seedRun(db, 'run-host-drift');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const demotedId = await enqueueThroughSeam(scheduler, {
      runId: 'run-host-drift',
      task: composedTask(),
    });
    await scheduler.awaitTerminal(demotedId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    expect(readRow(db, demotedId).error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
    expect(runbookRecord(db)?.status).toBe('unproven-draft');
    expect(world.deploys).toHaveLength(0);

    // RE-PROOF on the new host: a fresh draft (bumping the CAS version so any
    // in-flight pin against the old revision fails) plus a fresh proof.
    const reProof = await proveModality(store, 'web');
    expect(reProof.version).toBeGreaterThan(firstProof.version);
    expect(runbookRecord(db)?.status).toBe('proven');

    // …and the SAME task now deploys, pinned to the new revision.
    const recoveredId = await enqueueThroughSeam(scheduler, {
      runId: 'run-host-drift',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(recoveredId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    expect(outcome.status).toBe('passed');
    expect(world.deploys).toHaveLength(1);
    expect(readRow(db, recoveredId).runbook_hash).toBe(reProof.hash);
  });
});

// ===========================================================================
// Row 10 — attestation: the HARNESS probes, and nothing else counts
//
// §5.4's row is "attestation channel absent ⇒ no `passed`". Phase 2 originally
// satisfied it by READING `<artifactsDir>/.driver/attest.json`, which the
// adversarial review then holed: the agent has Bash and owns
// VERIFY_ARTIFACTS_DIR, so one redirect forged a perfect record for a channel
// that never ran, and the nonce could not help because the nonce is exported
// into the agent's own environment. The contract these rows now pin is the
// corrected one — the runner performs the probe itself against the live surface
// after the session ends — so the observable is the same and the reason it
// holds is different.
// ===========================================================================

describe('§5.4 matrix — attestation (§7.1: no attestation ⇒ no passed)', () => {
  it('a DECLARED channel the harness could not verify downgrades the pass to a BLOCKING failure', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The agent reports a clean pass; the harness asks the live surface for this
    // request's nonce and does not get it, so it cannot prove the thing that was
    // driven is this deliverable.
    const world = makeWorld({
      attest: { verified: false, kind: 'http-endpoint', detail: 'endpoint body carried no nonce' },
    });
    seedRun(db, 'run-no-attest');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-no-attest', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1); // it really did run — this is not a skip
    expect(outcome.status).toBe('failed');
    expect(readRow(db, requestId).error_message).toContain(ATTESTATION_MISSING_MESSAGE);

    // §7.1's posture: without foreign-occupancy evidence a missing attestation
    // is AMBIGUOUS, and ambiguous BLOCKS. Calling it 'env' would advance the
    // lane on a verification that proved nothing.
    expect(readRow(db, requestId).failure_class).toBe('ambiguous');
    expect(isMergeGateBlocking(decideMergeGate({ status: 'failed', currentAttempts: 1 }))).toBe(true);
  });

  it('a PERFECT forged attest.json sitting in the real artifacts dir buys the agent NOTHING', async () => {
    await withTempDir('matrix-forged-attest-', async (artifactsDir) => {
      const io = makeRunbookIo();
      const store = makeRunbookStore(db, io);
      await proveModality(store, 'web');

      // Exactly what one Bash redirect inside the deployed session produces —
      // written for real, in the real artifacts dir, in the exact shape the
      // phase-2 runner used to accept as proof.
      await fsPromises.mkdir(path.join(artifactsDir, '.driver'), { recursive: true });
      await fsPromises.writeFile(
        path.join(artifactsDir, '.driver', 'attest.json'),
        JSON.stringify({
          ok: true,
          kind: 'http-endpoint',
          detail: 'endpoint returned this request nonce',
          at: new Date().toISOString(),
        }),
        'utf8',
      );

      const world = makeWorld({
        attest: { verified: false, kind: 'http-endpoint', detail: 'endpoint body carried no nonce' },
      });
      seedRun(db, 'run-forged-attest');
      const scheduler = initScheduler(db, { world, runbookStore: store, artifactsDir });

      const requestId = await enqueueThroughSeam(scheduler, {
        runId: 'run-forged-attest',
        task: composedTask(),
      });
      const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

      // The file is still there and still perfect — and the terminal is a
      // blocking failure anyway, because no code path reads it.
      expect(
        JSON.parse(await fsPromises.readFile(path.join(artifactsDir, '.driver', 'attest.json'), 'utf8')),
      ).toMatchObject({ ok: true });
      expect(outcome.status).toBe('failed');
      expect(readRow(db, requestId).error_message).toContain(ATTESTATION_MISSING_MESSAGE);
      expect(isMergeGateBlocking(decideMergeGate({ status: 'failed', currentAttempts: 1 }))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Round-3 finding 3: a VERIFIED channel is not enough on its own.
  //
  // The three rows above all turn on whether the harness's probe came back
  // verified. These three hold the probe at VERIFIED and vary only what the
  // KERNEL says about the surface that answered it — which is the gap the
  // nonce could never close, because the agent holds the nonce and chooses what
  // the driver serves.
  // -------------------------------------------------------------------------

  it('a DECOY served through the driver fails even though the harness read the nonce back', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // `attest` VERIFIES: the harness genuinely GET'd the port and got this
    // request's nonce. The agent simply served something else that knew it —
    // which it does, because the nonce is exported into its own environment.
    const world = makeWorld({ serveFault: 'substituted-command' });
    seedRun(db, 'run-decoy-serve');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-decoy-serve',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1);
    expect(outcome.status).toBe('failed');
    const row = readRow(db, requestId);
    expect(row.error_message).toContain(ATTESTATION_MISSING_MESSAGE);
    expect(row.error_message).toContain('[command]');
    expect(isMergeGateBlocking(decideMergeGate({ status: 'failed', currentAttempts: 1 }))).toBe(true);
  });

  it("a FOREIGN process holding the port fails the binding — the §1(e) false-ready incident, caught", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The pinned serve really did start; something else (a stale vite from an
    // unrelated worktree — §1(e), observed live) is what answers on the port.
    const world = makeWorld({ serveFault: 'foreign-listener' });
    seedRun(db, 'run-foreign-listener');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-foreign-listener',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('failed');
    expect(readRow(db, requestId).error_message).toContain('[port-owner]');
  });

  it('a serve the driver never recorded fails the binding (started outside "$VERIFY_DRIVER serve")', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    const world = makeWorld({ serveFault: 'no-pid-file' });
    seedRun(db, 'run-unrecorded-serve');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-unrecorded-serve',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('failed');
    expect(readRow(db, requestId).error_message).toContain('[serve-pid]');
  });

  it('a task that never DECLARED a channel is capped at low_confidence — advisory, never passed', async () => {
    // No proven runbook in this DB, so nothing injects an attestation: the bare
    // pre-live `target.url` shape, which is exactly the case §7.1 softens rather
    // than breaking (it never had an identity check to fail).
    const world = makeWorld();
    seedRun(db, 'run-uncapped');
    const scheduler = initScheduler(db, { world });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-uncapped',
      task: degenerateTask({ url: 'https://example.test/page' }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('low_confidence');
    expect(readRow(db, requestId).error_message).toContain(ATTESTATION_UNCAPPED_MESSAGE);
    // Advisory: it advances the lane without asserting an identity it cannot prove.
    expect(decideMergeGate({ status: 'low_confidence', currentAttempts: 1 })).toEqual({
      kind: 'advance-integrated',
    });
  });

  it('the DEGENERATE htmlPath target passes on implicit file-identity (the runner owns the path it opened)', async () => {
    const world = makeWorld();
    seedRun(db, 'run-file-identity');
    const scheduler = initScheduler(db, { world });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-file-identity',
      type: 'static-render-snapshot',
      task: degenerateTask({ htmlPath: '/artifacts/prototype/index.html' }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    // No live process, no port, nothing for a stale server or the user's own app
    // to race — so identity holds by construction and `passed` is available.
    expect(outcome.status).toBe('passed');
    expect(readRow(db, requestId).error_message).toBeNull();
  });
});

// ===========================================================================
// Row 11 — native-screen
//
// §5.4's row is "native-screen (IF DRIVE LANDS) — explicit-consent gate honored;
// abort-on-input verified". Drive has NOT landed (§4 fn.²: no executable native
// drive path exists; the modality is declared observe-only). Asserting the
// consent gate here would be asserting a behavior nothing implements. What IS
// assertable — and what the consent gate will eventually sit on top of — is the
// observe-only contract, so that is what these rows pin.
// ===========================================================================

describe('§5.4 matrix — native-screen (observe-only contract)', () => {
  it('a drive-required behavior the agent claimed to PASS is coerced to not_testable and capped at low_confidence', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'native-screen');

    // The agent claims it clicked through a behavior the driver would have
    // refused. A screenshot cannot show a refusal, so the harness must not take
    // the model's word for it.
    const world = makeWorld({
      nativeCapture: async () => true,
      attest: { verified: true, kind: 'window-identity', detail: 'window title matched "Cyboflow"' },
      report: passReport({
        behaviors: [
          { id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'clicked the menu' } },
        ],
      }),
    });
    seedRun(db, 'run-native');
    const scheduler = initScheduler(db, {
      world,
      runbookStore: store,
      nativeCaptureProbe: async () => true,
    });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-native',
      type: 'native-desktop',
      task: composedTask({
        summary: 'the tray menu opens',
        behaviors: [
          { id: 'b1', description: 'the tray menu opens on click', expected: 'menu visible', requiresDrive: true },
        ],
      }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(row.modality).toBe('native-screen');
    expect(world.deploys).toHaveLength(1);

    // The claim was REMOVED (never silently dropped, never upgraded): the report
    // records not_testable, and an all-not_testable pass is the honest ceiling.
    const report = db
      .prepare('SELECT report_json AS r FROM verification_requests WHERE id = ?')
      .get(requestId) as { r: string | null };
    const behaviors = (JSON.parse(report.r ?? '{}') as VerificationReportV1).behaviors;
    expect(behaviors[0].result).toBe('not_testable');
    expect(behaviors[0].evidence.notes).toContain('drive-unsupported');
    expect(outcome.status).toBe('low_confidence');
  });

  it('a host that cannot capture the screen is skipped BEFORE any lease, with the actionable grant detail', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'native-screen');

    const world = makeWorld();
    seedRun(db, 'run-native-ungranted');
    const scheduler = initScheduler(db, {
      world,
      runbookStore: store,
      // The retired peekaboo both-grants probe, answering honestly.
      nativeCaptureProbe: async () => false,
    });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-native-ungranted',
      type: 'native-desktop',
      task: composedTask({ summary: 'the tray menu opens' }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toContain("unsupported modality 'native-screen'");
    expect(row.error_message).toContain('cannot capture the screen');
    expect(row.preflight_json).toBeNull(); // pre-lease: no deploy, no snapshot, no screen lease
    expect(world.deploys).toHaveLength(0);
  });

  /**
   * §5.4 marks this row "(if drive lands)" and explicitly exempts it from
   * "runnable unattended". It is blocked on TWO decisions that are open in the
   * proposal, not on test effort:
   *
   *  - §4 fn.² — native DRIVING has no executable path at all today
   *    (`DriverCommand` is CDP-selector-only; the verify agent runs Bash-only
   *    with an empty MCP map). There is nothing to gate.
   *  - §4 "Screen exclusivity is a product policy" — v1's decision is EXPLICIT
   *    PER-RUN GO-AHEAD (idle-queueing deferred, §8). A per-run human go-ahead
   *    is by definition not scriptable unattended, and "abort on any user input
   *    or focus change" is a claim about the real display that a fake probe
   *    cannot make.
   *
   * When drive lands, this becomes: hold the screen lease, assert no input is
   * emitted before the go-ahead resolves, then inject a focus change mid-action
   * and assert the run aborts rather than typing into the user's window.
   */
  it.todo(
    'explicit per-run consent gate is honored and any user input aborts the drive (§4 — blocked: native drive is a designed prerequisite, not yet implemented)',
  );
});

// ===========================================================================
// Rows 12-14 — GATE INTEGRITY (Codex adversarial review, finding 1)
//
// Every row above injects a fault in the WORLD. These inject it in the AGENT,
// which is the one adversary the harness cannot probe: the model is the only
// participant that can author a claim about work it did not do. §3.1's rule is
// that `skipped` ADVANCES the lane, so a status the model can talk its way into
// is a status the model can use to ship its own unverified code.
//
// The pre-existing "ambiguous stays blocking" test asserted this against a
// runner result that was ALREADY marked `'failed'` — i.e. it tested the
// scheduler's handling of a status the runner had to produce for the test to
// mean anything. These rows drive the REAL runner (a fake SDK session, real
// validation, real mapping) into the REAL scheduler, so the runner→scheduler
// MAPPING is what is under test rather than assumed.
// ===========================================================================

describe('§3.1 gate integrity — a deployed session cannot advance a lane on garbage', () => {
  it('a structurally INVALID report is a BLOCKING failure, never an advancing skip', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The session drains cleanly and returns prose instead of the schema it was
    // handed verbatim in the harness contract. Historically this mapped to
    // `skipped` — the lane advanced, integrated, and nothing was ever verified.
    const world = makeWorld({
      structuredOverride: { value: 'I ran the build and it all looked fine to me.' },
    });
    seedRun(db, 'run-garbage');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-garbage', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1); // the session really ran — this is not a skip-before-deploy
    expect(outcome.status).toBe('failed');
    const row = readRow(db, requestId);
    expect(row.error_message).toContain('invalid structured report');

    // Attribution stays honest: no harness evidence and no judged report means
    // 'ambiguous', which is BLOCKING — never 'deliverable' (nothing was judged)
    // and never 'env' (nothing corroborated an environment fault).
    expect(row.failure_class).toBe('ambiguous');
    const action = decideMergeGate({ status: outcome.status, currentAttempts: 1 });
    expect(action).toEqual({ kind: 'loopback-implement', nextAttempt: 2 });
    expect(isMergeGateBlocking(action)).toBe(true);
  });

  it('a session that drained with NO structured output at all is the same blocking failure', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    const world = makeWorld({ structuredOverride: { value: null } });
    seedRun(db, 'run-silent');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-silent', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('failed');
    expect(readRow(db, requestId).error_message).toContain('invalid structured report');
    expect(isMergeGateBlocking(decideMergeGate({ status: outcome.status, currentAttempts: 1 }))).toBe(true);
  });

  it('a PASS whose evidence cites a screenshot no driver ever wrote is a BLOCKING failure', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The fabricated-evidence attack: a clean gallery (every file real) plus a
    // behavior citing proof that does not exist. Validating only the gallery
    // leaves the actual EVIDENCE claim standing and advances the lane on it.
    const world = makeWorld({
      report: passReport({
        behaviors: [
          {
            id: 'b1',
            result: 'pass',
            evidence: { screenshots: ['s.png', 'login-success.png'], notes: 'the toggle rendered' },
          },
        ],
      }),
      fileExists: async (absPath) => !absPath.endsWith('login-success.png'),
    });
    seedRun(db, 'run-phantom');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-phantom', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1);
    expect(outcome.status).toBe('failed');
    const row = readRow(db, requestId);
    expect(row.error_message).toContain('login-success.png');
    expect(row.failure_class).toBe('ambiguous');
    expect(isMergeGateBlocking(decideMergeGate({ status: outcome.status, currentAttempts: 1 }))).toBe(true);
  });

  it('a CONNECT-LEVEL transport failure STAYS an advancing skip (the empty-session carve-out)', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The SDK layer threw before the session produced a single message: our code
    // raised, no structured output ever existed, and nothing was claimed about
    // the deliverable either way. Blocking here would turn every API outage into
    // a lane-blocking FAIL that loops implement agents against code the harness
    // never examined.
    const world = makeWorld({ queryError: new Error('stream closed: ECONNRESET') });
    seedRun(db, 'run-transport');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-transport', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1);
    expect(outcome.status).toBe('skipped');
    const row = readRow(db, requestId);
    expect(row.error_message).toContain('agent deploy error');
    // NOTE: this is the one advancing skip that is NOT env-classified. The §3.1
    // classifier keys 'env' on harness EVIDENCE (a failed check, a squatter
    // probe), and a transport error produces none; the runner instead flags the
    // result so the gate-integrity guard exempts it explicitly rather than the
    // scheduler guessing from an error string.
    expect(row.failure_class).toBe('ambiguous');
    // The lane advances with ZERO attempt increment…
    expect(decideMergeGate({ status: outcome.status, currentAttempts: 1 })).toEqual({
      kind: 'advance-integrated',
    });
    // …but the project's verification BUDGET is charged, because that session
    // was deployed and did spend tokens (§3.6 — the budget counts deployments,
    // not verdicts).
    expect(row.judge_calls_used).toBe(1);
  });

  it('a MID-SESSION transport failure BLOCKS — the agent was alive and could have induced it', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // Same exception class, one difference: the session had already accumulated
    // a transcript, so the agent was working when the transport died. An agent
    // holding Bash can kill its own SDK process, and from out here that is
    // indistinguishable from an upstream reset — §3.1 keeps ambiguity blocking
    // (round-3 finding 4).
    const world = makeWorld({
      queryError: new VerificationAgentQueryError(
        'stream closed: ECONNRESET',
        '## Bash\n$ pnpm run build\n(exit 0)\n',
      ),
    });
    seedRun(db, 'run-transport-mid');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-transport-mid',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1);
    expect(outcome.status).toBe('failed');
    expect(readRow(db, requestId).error_message).toContain(TRANSPORT_MID_SESSION_MESSAGE);
    expect(isMergeGateBlocking(decideMergeGate({ status: 'failed', currentAttempts: 1 }))).toBe(true);
  });

  it('an UNATTRIBUTABLE build failure in the dirty shared worktree STAYS an advancing skip (§5.7)', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // No sha was captured at enqueue ⇒ the runner falls back to the LIVE
    // worktree, which carries every sibling lane's half-finished edits. A build
    // failure there genuinely cannot be charged to this lane's deliverable.
    const world = makeWorld({
      report: passReport({
        behaviors: [],
        screenshots: [],
        outcome: 'build_failed',
        buildLogExcerpt: 'ERR_MODULE_NOT_FOUND: ../sibling-lane/half-written.ts',
      }),
    });
    seedRun(db, 'run-fallback-build');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-fallback-build',
      task: composedTask(),
      snapshotSha: null,
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1);
    expect(outcome.status).toBe('skipped');
    expect(readRow(db, requestId).error_message).toContain('unattributable shared-worktree build_failed');
    expect(decideMergeGate({ status: outcome.status, currentAttempts: 1 })).toEqual({
      kind: 'advance-integrated',
    });
  });

  it('the SAME build failure in a SNAPSHOT is blocking — the carve-out is about provenance, not the outcome', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    const world = makeWorld({
      report: passReport({
        behaviors: [],
        screenshots: [],
        outcome: 'build_failed',
        buildLogExcerpt: 'tsc: 3 errors',
      }),
    });
    seedRun(db, 'run-snapshot-build');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-snapshot-build',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('failed');
    expect(isMergeGateBlocking(decideMergeGate({ status: outcome.status, currentAttempts: 1 }))).toBe(true);
  });
});

// ===========================================================================
// Rows 15-16 — the PIN validates the RECORD, not just its content
// (Codex adversarial review, finding 3)
//
// A content hash answers "are these the same commands". It cannot answer "is
// this revision still the one this request is entitled to run" — that is the
// record's STATUS (ordinary traffic) and its VERSION (a setup proof), and both
// can move between an enqueue and the deployment it triggers.
// ===========================================================================

describe('§5.2 seam 3 — the pin checks the record, not only its content', () => {
  it('an ORDINARY request refuses a revision that was DEMOTED between enqueue and deploy', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The demotion lands mid-flight: the request pinned a PROVEN revision at
    // enqueue, and by the time the runner resolves the hash the store has
    // write-through-demoted it (ROW 8 covers the store side; what this pins is
    // that the RUNNER refuses to execute what it resolves as no-longer-proven —
    // a content-only compare cannot see it, because a demotion changes the row's
    // status and never its content address).
    const world = makeWorld({
      resolveRunbookByHash: (projectId, modality, hash) => {
        const record = store.getByHash(projectId, modality, hash);
        return record === null ? null : { ...record, status: 'unproven-draft' };
      },
    });
    seedRun(db, 'run-demoted-pin');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-demoted-pin',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('skipped');
    expect(row.error_message).toContain(RUNBOOK_MISMATCH_PREFIX);
    expect(row.error_message).toContain('not proven');

    // Env-class and FREE: host/state drift is not a defect the lane could fix by
    // retrying, so nothing deploys, nothing is charged, and the lane advances.
    expect(row.failure_class).toBe('env');
    expect(world.deploys).toHaveLength(0);
    expect(row.judge_calls_used).toBe(0);
    expect(decideMergeGate({ status: outcome.status, currentAttempts: 1 })).toEqual({
      kind: 'advance-integrated',
    });
  });

  it('a SETUP-PROOF request refuses a record that was RE-REGISTERED after it was pinned', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);

    // The setup flow derives a draft (v1) and enqueues a proof pinned to it —
    // then something re-derives (v2). The CONTENT is byte-identical, so the hash
    // still resolves and the fingerprint compare passes: version equality is the
    // ONLY thing standing between this run and a proof recorded against a
    // revision it never actually attested to.
    const first = await store.registerDraft(1, LIVE_WORKTREE, 'web');
    if ('error' in first) throw new Error(`registerDraft failed: ${first.error}`);
    const second = await store.registerDraft(1, LIVE_WORKTREE, 'web');
    if ('error' in second) throw new Error(`registerDraft failed: ${second.error}`);
    expect(second.hash).toBe(first.hash);
    expect(second.version).toBeGreaterThan(first.version);

    const world = makeWorld({
      resolveRunbookByHash: (projectId, modality, hash) => store.getByHash(projectId, modality, hash),
    });
    seedRun(db, 'run-stale-proof');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-stale-proof',
      // A caller-supplied pin is stamped verbatim WITHOUT the runbook merge, so
      // the composed task must already carry the entry's own commands — else the
      // content compare would reject first and this row would prove nothing.
      task: composedTask({
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}', readyWhen: { urlPath: '/' } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      }),
      setupProof: true,
      pin: { hash: first.hash, localVersion: first.version },
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('skipped');
    expect(row.error_message).toContain(RUNBOOK_MISMATCH_PREFIX);
    expect(row.error_message).toContain('setup-proof request pinned');
    expect(row.failure_class).toBe('env');
    expect(world.deploys).toHaveLength(0);

    // And nothing was promoted: a proof that never ran cannot make a record proven.
    expect(runbookRecord(db)?.status).toBe('unproven-draft');
  });

  it('a SETUP-PROOF request against its OWN current draft deploys and proves it (the bootstrap still works)', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    const draft = await store.registerDraft(1, LIVE_WORKTREE, 'web');
    if ('error' in draft) throw new Error(`registerDraft failed: ${draft.error}`);

    // The proven-status requirement added for ordinary traffic must NOT reach
    // here: an 'unproven-draft' record is exactly what a proof run exists to
    // execute, and requiring 'proven' would deadlock phase 2's bootstrap.
    const world = makeWorld({
      resolveRunbookByHash: (projectId, modality, hash) => store.getByHash(projectId, modality, hash),
    });
    seedRun(db, 'run-good-proof');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-good-proof',
      task: composedTask({
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}', readyWhen: { urlPath: '/' } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      }),
      setupProof: true,
      pin: { hash: draft.hash, localVersion: draft.version },
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('passed');
    expect(world.deploys).toHaveLength(1);
    expect(runbookRecord(db)?.status).toBe('proven');
  });
});

// ===========================================================================
// Row 17 — the capability ledger is keyed by RUNBOOK REVISION
// (Codex adversarial review, finding 7)
//
// The ledger's claim is "standing this deliverable up FAILS on this host", and
// what "standing it up" means is the runbook's commands. Pooling every revision
// into one bucket makes a dead revision's failures suppress its own fix for the
// rest of the 24h TTL — i.e. the setup flow's derive→prove→persist loop would be
// unable to clear a suppression it just fixed.
// ===========================================================================

describe('§3.4 capability ledger — suppression is keyed by runbook revision', () => {
  it("an obsolete revision's env failures never suppress the revision that FIXED them", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    const revA = await proveModality(store, 'web');

    // Revision A trips the breaker on this host (K consecutive env failures).
    const world = makeWorld({ chromium: null });
    const capability = new VerifyCapabilityStore(dbAdapter(db));
    seedRun(db, 'run-ledger');
    const scheduler = initScheduler(db, { world, runbookStore: store, capabilityStore: capability });

    for (let i = 0; i < CAPABILITY_BREAKER_THRESHOLD; i++) {
      const id = await enqueueThroughSeam(scheduler, { runId: 'run-ledger', task: composedTask() });
      await scheduler.awaitTerminal(id, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
      expect(readRow(db, id).runbook_hash).toBe(revA.hash);
    }
    expect(capability.getActiveSuppression(1, 'web', revA.hash)).not.toBeNull();

    // THE FIX: a new revision (different serve command), re-derived and re-proven
    // — and a host that now has a chromium.
    const fixed = baseRunbook();
    fixed.modalities.web = {
      build: ['pnpm run build:web'],
      serve: { cmd: 'pnpm run preview -- --port ${PORT} --host 127.0.0.1', readyWhen: { urlPath: '/' } },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    io.files.set(LIVE_WORKTREE, JSON.stringify(fixed));
    const revB = await proveModality(store, 'web');
    expect(revB.hash).not.toBe(revA.hash);
    world.chromium = '/opt/chromium';

    const fixedId = await enqueueThroughSeam(scheduler, { runId: 'run-ledger', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(fixedId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    // Revision B is NOT suppressed by revision A's history: it deploys and passes.
    expect(readRow(db, fixedId).runbook_hash).toBe(revB.hash);
    expect(outcome.status).toBe('passed');
    expect(world.deploys).toHaveLength(1);
    expect(capability.getActiveSuppression(1, 'web', revB.hash)).toBeNull();

    // …and B's healthy outcome did not reach into A's bucket either: the
    // suppression on the revision that actually failed still stands, so a
    // request that somehow re-pins A is still short-circuited.
    expect(capability.getActiveSuppression(1, 'web', revA.hash)).not.toBeNull();
    const buckets = db
      .prepare(
        `SELECT runbook_hash, status, consecutive_env_failures AS fails
           FROM verify_capability_state WHERE project_id = 1 AND modality = 'web'`,
      )
      .all() as Array<{ runbook_hash: string; status: string; fails: number }>;
    const bucketA = buckets.find((b) => b.runbook_hash === revA.hash);
    expect(bucketA?.status).toBe('suppressed');
    expect(bucketA?.fails).toBeGreaterThanOrEqual(CAPABILITY_BREAKER_THRESHOLD);
    // B either has no row at all (nothing to reset) or a clean one — never A's counter.
    expect(buckets.find((b) => b.runbook_hash === revB.hash)?.fails ?? 0).toBe(0);
  });
});
