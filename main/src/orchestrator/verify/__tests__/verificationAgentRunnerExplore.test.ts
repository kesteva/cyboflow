/**
 * VerificationAgentRunner — the runbook-optional RUNNER half
 * (docs/proposals/runbook-optional-verification.md §A1.1–§A1.4, §A3's result
 * channel, §A4, "Report-contract widening (F6)").
 *
 * Split from verificationAgentRunner.test.ts so the pre-explore suite stays the
 * readable record of the PINNED contract. Every behaviour pinned here is one the
 * execution mode changes: the mapping table (outcome × mode × corroboration ×
 * floor), the mode-aware attestation floor, the harness corroboration facts, A4
 * re-applied after drive coercion, the mode-conditional contract text and
 * EXPLORE HINTS, the explore lever source, the host data-dir strip, the
 * wrapper's literal driver port, the explore-only guards, the PATH shim, and the
 * harness-owned provenance. Same fake-seam posture as the sibling suite: no SDK,
 * no process spawned, no socket dialled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { delimiter, join } from 'node:path';
import {
  ATTESTATION_EXPLORE_CAP_MESSAGE,
  ATTESTATION_FOREIGN_MESSAGE,
  ATTESTATION_MISSING_MESSAGE,
  ATTESTATION_UNCAPPED_MESSAGE,
  CODEX_EXPLORE_NO_GUARD_MESSAGE,
  SERVE_BINDING_FAILED_PREFIX,
  UNVERIFIABLE_UNCORROBORATED_MESSAGE,
  VERIFY_HARNESS_CONTRACT,
  VERIFY_HARNESS_CONTRACT_CODEX,
  VerificationAgentRunner,
  composeVerifyUserPrompt,
  driverScriptBody,
  evaluateAttestationFloor,
  evaluateAttestationFloorForMode,
  mapReportToResult,
  reapplyUnverifiableAfterDriveCoercion,
  resolveExecutionMode,
  stripHostDataDirEnv,
  unverifiableCorroboration,
  verifyHarnessContract,
  type AttestationFloorOutcome,
  type ExploreRunbookRecord,
  type ReportMappingContext,
  type ServeBindingResult,
  type VerificationAgentQueryArgs,
  type VerificationAgentQueryOutcome,
  type VerificationAgentRequest,
  type VerificationAgentRunnerDeps,
  type VerificationAgentRunnerMobileDeps,
} from '../verificationAgentRunner';
import { describeBoundLevers } from '../verifyHarnessContract';
import type { HarnessAttestationResult } from '../harnessAttestation';
import type { MobileSimulatorHandle } from '../mobileSimulatorSession';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import {
  UNVERIFIABLE_COERCION_NOTE,
  VERIFICATION_REPORT_OUTCOMES,
  type AttestationSpec,
  type VerificationExecutionMode,
  type VerificationReportV1,
  type VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_SHELL_PATH = ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter);
const SERVE_CMD = 'pnpm run preview --port ${PORT}';
const HTTP_SPEC: AttestationSpec = { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' };
const SERVE_LEADER_PID = 4242;
const SERVE_CHILD_PID = 4243;
const FOREIGN_PID = 9001;

function makeAgent(): EffectiveAgent {
  return {
    agentKey: 'visual-verify',
    name: 'cyboflow-visual-verify',
    role: 'verify',
    description: 'd',
    systemPrompt: 'SYSTEM PROMPT BODY',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
  };
}

/** An ATTESTED web task, like the sibling suite's default. */
function makeTask(overrides: Partial<VerificationTaskV1> = {}): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'verify the widget',
    attestation: HTTP_SPEC,
    behaviors: [{ id: 'b1', description: 'renders', expected: 'the widget is visible' }],
    ...overrides,
  };
}

function validReport(overrides: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'the widget' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'looks right',
    issues: [],
    ...overrides,
  };
}

const failedB1 = { id: 'b1', result: 'fail' as const, evidence: { screenshots: ['s.png'], notes: 'wrong colour' } };
const untestableB1 = { id: 'b1', result: 'not_testable' as const, evidence: { screenshots: [], notes: 'n/a' } };

function makeReq(overrides: Partial<VerificationAgentRequest> = {}): VerificationAgentRequest {
  return {
    runId: 'run-1',
    requestId: 'vr-explore-1',
    projectId: 1,
    task: makeTask(),
    runWorktreePath: '/live/worktree',
    snapshotSha: 'abc123',
    artifactsDir: '/artifacts',
    verifyPort: 29260,
    verifyDriverPort: 29261,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const RECORD_HASH = 'd'.repeat(64);

/** The §A1.3 explore record: an unproven LEARNED draft with levers, hints and notes. */
function makeExploreRecord(overrides: Partial<ExploreRunbookRecord> = {}): ExploreRunbookRecord {
  return {
    hash: RECORD_HASH,
    status: 'unproven-draft',
    origin: 'learned',
    runbook: {
      version: 1,
      modalities: {
        web: {
          build: ['pnpm run build:web'],
          serve: { cmd: 'pnpm run preview --port ${PORT}' },
          attestation: HTTP_SPEC,
          notes: 'the preview script serves the built bundle',
        },
      },
      levers: { portEnv: 'PORT', dataDirEnv: 'CYBOFLOW_DIR', notes: 'vite reads PORT' },
    },
    ...overrides,
  };
}

function outcome(structured: unknown): VerificationAgentQueryOutcome {
  return { structured, transcript: null };
}

/** The three binding probes for a HEALTHY serve of `serveCmd` (a child of the recorded leader holds the port). */
function servedBy(serveCmd: string): Partial<VerificationAgentRunnerDeps> {
  return {
    readServePid: async () => SERVE_LEADER_PID,
    listeningPidForPort: async () => SERVE_CHILD_PID,
    processInfo: async (pid) =>
      pid === SERVE_CHILD_PID
        ? { pgid: SERVE_LEADER_PID, command: 'node /snap/node_modules/.bin/vite' }
        : { pgid: SERVE_LEADER_PID, command: `sh -c ${serveCmd}` },
  };
}

/** The driver recorded a serve group, but the port is held by a process in ANOTHER group. */
const foreignListener: Partial<VerificationAgentRunnerDeps> = {
  readServePid: async () => SERVE_LEADER_PID,
  listeningPidForPort: async () => FOREIGN_PID,
  processInfo: async (pid) =>
    pid === FOREIGN_PID
      ? { pgid: FOREIGN_PID, command: 'node /Users/dev/their-own/vite' }
      : { pgid: SERVE_LEADER_PID, command: `sh -c ${SERVE_CMD}` },
};

function makeRunner(overrides: Partial<VerificationAgentRunnerDeps> = {}) {
  const query = vi.fn(async (args: VerificationAgentQueryArgs) => {
    void args;
    return outcome(validReport());
  });
  const codexQuery = vi.fn(async (args: VerificationAgentQueryArgs) => {
    void args;
    return outcome(validReport());
  });
  const attest = vi.fn(
    async (): Promise<HarnessAttestationResult> => ({
      verified: true,
      kind: 'http-endpoint',
      detail: 'endpoint returned this request nonce',
    }),
  );
  const writeDriverScript = vi.fn(
    async (...args: Parameters<NonNullable<VerificationAgentRunnerDeps['writeDriverScript']>>) => {
      void args;
      return '/artifacts/.driver/verify-driver.sh';
    },
  );
  const materializeDependencyGuardShim = vi.fn(async (): Promise<{ binDir: string | null }> => ({ binDir: null }));
  const warn = vi.fn();
  const deps: VerificationAgentRunnerDeps = {
    query,
    codexQuery,
    resolveVerifyAgent: () => ({ agent: makeAgent(), runProvider: 'claude', runModel: 'claude-sonnet-5' }),
    resolveClaudeAlias: (alias) => `claude-${alias}-resolved`,
    claudeDefaultModel: 'claude-opus-4-8',
    resolveNode: async () => '/usr/bin/node',
    driverCliPath: '/app/driverCli.js',
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    provision: async () => ({ worktreePath: '/snap', sha: 'abc123', dispose: async () => {} }),
    checkSnapshotMutated: async () => false,
    fileExists: async () => true,
    resolveChromium: async () => '/opt/chromium',
    portFreeProbe: async () => true,
    writeDriverScript,
    stopDriver: async () => {},
    reapBrowser: () => {},
    reapServe: () => {},
    writeTranscript: async () => {},
    attest,
    // Nothing was served through the driver unless a test opts in.
    readServePid: async () => null,
    listeningPidForPort: async () => null,
    processInfo: async () => null,
    resolveShellPath: async () => FAKE_SHELL_PATH,
    resolveNodeModulesRoot: async () => null,
    prepareDataDir: async () => {},
    materializeDependencyGuardShim,
    ...overrides,
  };
  return { runner: new VerificationAgentRunner(deps), query, codexQuery, attest, writeDriverScript, materializeDependencyGuardShim, warn };
}

const SIM_UDID = 'B1C0FFEE-0000-4000-8000-0123456789AB';
const APP = { platform: 'ios-simulator' as const, bundleId: 'com.acme.ios', scheme: 'Acme' };

function mobileDeps(opts: { maestro: boolean }): VerificationAgentRunnerMobileDeps {
  const handle: MobileSimulatorHandle = {
    udid: SIM_UDID,
    name: 'cyboflow-verify-vr-1',
    runtimeName: 'iOS 26.2',
    runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    derivedDataDir: '/data/verify-mobile/vr-1/DerivedData',
    requestDir: '/data/verify-mobile/vr-1',
    dispose: async () => {},
  };
  return {
    session: { acquire: async () => handle, sweepStaleSimulators: async () => ({ deleted: [], skipped: [] }) },
    toolchain: {
      resolveMaestroBin: async () => (opts.maestro ? '/Users/dev/.maestro/bin/maestro' : null),
      resolvePinFlag: async () => '--udid',
      healthCheck: async () => true,
    },
    dataDir: '/data',
  };
}

function makeMobileReq(overrides: Partial<VerificationAgentRequest> = {}): VerificationAgentRequest {
  return makeReq({
    task: makeTask({ app: APP, attestation: { kind: 'bundle-identity', bundleId: APP.bundleId } }),
    modality: 'mobile',
    verifyPort: null,
    verifyDriverPort: null,
    ...overrides,
  });
}

const bundleVerified = async (): Promise<HarnessAttestationResult> => ({
  verified: true,
  kind: 'bundle-identity',
  detail: 'bundle-identity: the installed app is this request staged product',
});

/** Collapse whitespace so a phrase check survives the contract's line wrapping. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// resolveExecutionMode — the fallback for callers that predate the mode
// ---------------------------------------------------------------------------

describe('resolveExecutionMode', () => {
  it('honours an explicit mode, else derives pinned from a pin or a proof, else legacy', () => {
    expect(resolveExecutionMode({ executionMode: 'explore' })).toBe('explore');
    expect(resolveExecutionMode({ runbookHash: 'h' })).toBe('pinned');
    expect(resolveExecutionMode({ setupProof: true })).toBe('pinned');
    expect(resolveExecutionMode({})).toBe('legacy');
  });
});

// ---------------------------------------------------------------------------
// mapReportToResult — the widened, exhaustive table
// ---------------------------------------------------------------------------

describe('mapReportToResult — outcome × mode × corroboration × floor', () => {
  const ctx = (overrides: Partial<ReportMappingContext> = {}): ReportMappingContext => ({
    provisionMode: 'snapshot',
    mutated: false,
    model: 'claude-x',
    executionMode: 'pinned',
    modality: 'web',
    floor: null,
    corroboration: [],
    ...overrides,
  });
  const MODES: VerificationExecutionMode[] = ['pinned', 'legacy', 'explore'];
  const verified: AttestationFloorOutcome = { kind: 'verified', channel: 'http-endpoint', detail: 'nonce echoed' };
  const missing: AttestationFloorOutcome = { kind: 'missing', detail: 'body had no nonce' };
  const capped: AttestationFloorOutcome = { kind: 'capped', channel: 'http-endpoint', detail: 'no serve.cmd' };
  const foreign: AttestationFloorOutcome = { kind: 'foreign', detail: 'listener in group 9001' };
  const uncapped: AttestationFloorOutcome = { kind: 'uncapped', detail: 'no channel' };

  describe('build_failed / launch_failed — unchanged in every mode', () => {
    it.each(MODES)('%s: failed in the snapshot, skipped in the dirty fallback', (executionMode) => {
      const report = validReport({ outcome: 'build_failed', buildLogExcerpt: 'TS1005' });
      expect(mapReportToResult(report, ctx({ executionMode }))).toMatchObject({ status: 'failed', errorMessage: 'TS1005' });
      expect(mapReportToResult(report, ctx({ executionMode })).verdict).toBeUndefined();
      expect(mapReportToResult(report, ctx({ executionMode, provisionMode: 'fallback' })).status).toBe('skipped');
    });
  });

  describe('wrong_environment — the §A3 re-dispatch channel', () => {
    it.each(['legacy', 'explore'] as const)('%s: low_confidence carrying redispatch{modality, app, diagnosis}, never passed', (executionMode) => {
      const report = validReport({
        outcome: 'wrong_environment',
        neededModality: 'mobile',
        app: APP,
        diagnosis: 'this is an iOS app, not a web page',
      });
      const r = mapReportToResult(report, ctx({ executionMode }));
      expect(r.status).toBe('low_confidence');
      expect(r.redispatch).toEqual({ modality: 'mobile', app: APP, diagnosis: 'this is an iOS app, not a web page' });
      expect(r.errorMessage).toBe('wrong environment (needs mobile): this is an iOS app, not a web page');
    });

    it('omits app when the agent inferred none, and never re-dispatches without a target modality', () => {
      const withTarget = mapReportToResult(
        validReport({ outcome: 'wrong_environment', neededModality: 'cdp-app', diagnosis: 'an Electron app' }),
        ctx({ executionMode: 'explore' }),
      );
      expect(withTarget.redispatch).toEqual({ modality: 'cdp-app', diagnosis: 'an Electron app' });
      const noTarget = mapReportToResult(validReport({ outcome: 'wrong_environment', diagnosis: 'x' }), ctx({ executionMode: 'explore' }));
      expect(noTarget.redispatch).toBeUndefined();
      expect(noTarget.status).toBe('low_confidence');
    });

    // Engine finding 1, runner side: a re-dispatch the engine can only decline
    // must not buy an advancing low_confidence past A4's corroboration rule.
    const toMobile = validReport({
      outcome: 'wrong_environment',
      neededModality: 'mobile',
      app: APP,
      diagnosis: 'this is an iOS app, not a web page',
      behaviors: [untestableB1],
    });

    it('pinned + uncorroborated: read as unverifiable — a verdict-less blocking failed, no redispatch', () => {
      const r = mapReportToResult(toMobile, ctx({ executionMode: 'pinned' }));
      expect(r.status).toBe('failed');
      expect(r.verdict).toBeUndefined();
      expect(r.redispatch).toBeUndefined();
      expect(r.errorMessage).toContain(UNVERIFIABLE_UNCORROBORATED_MESSAGE);
      expect(r.errorMessage).toContain('wrong environment: needs mobile; not re-dispatchable: the request ran a pinned (proven) runbook');
      // Persisted as the agent said it.
      expect(r.report?.outcome).toBe('wrong_environment');
    });

    it('pinned + corroborated: advisory low_confidence naming the facts, still no redispatch', () => {
      const r = mapReportToResult(toMobile, ctx({ executionMode: 'pinned', corroboration: ['the task declared modality "mobile"'] }));
      expect(r.status).toBe('low_confidence');
      expect(r.redispatch).toBeUndefined();
      expect(r.errorMessage).toContain('harness-corroborated: the task declared modality "mobile"');
    });

    it('pinned + uncorroborated in the dirty fallback: unattributable skip, like unverifiable', () => {
      const r = mapReportToResult(toMobile, ctx({ executionMode: 'pinned', provisionMode: 'fallback' }));
      expect(r.status).toBe('skipped');
      expect(r.errorMessage).toMatch(/^unattributable shared-worktree unverifiable \(wrong environment/);
    });

    it.each(MODES)('%s: needing the modality it already ran under reads as unverifiable, never a redispatch', (executionMode) => {
      const r = mapReportToResult(toMobile, ctx({ executionMode, modality: 'mobile' }));
      expect(r.redispatch).toBeUndefined();
      expect(r.errorMessage).toContain('not re-dispatchable');
      // Pinned + uncorroborated blocks; legacy/explore land advisory, exactly as unverifiable does.
      expect(r.status).toBe(executionMode === 'pinned' ? 'failed' : 'low_confidence');
    });

    it('a pass-shaped report never carries a redispatch', () => {
      expect(mapReportToResult(validReport(), ctx({ floor: verified })).redispatch).toBeUndefined();
    });
  });

  describe('unverifiable — §A4', () => {
    const report = validReport({ outcome: 'unverifiable', diagnosis: 'FamilyControls needs a device', behaviors: [untestableB1] });

    it.each(['explore', 'legacy'] as const)('%s: low_confidence whether corroborated or not', (executionMode) => {
      for (const corroboration of [[], ['the mobile drive rung is none']]) {
        const r = mapReportToResult(report, ctx({ executionMode, corroboration }));
        expect(r.status).toBe('low_confidence');
        expect(r.verdict?.status).toBe('low_confidence');
        expect(r.errorMessage).toMatch(/^unverifiable: FamilyControls needs a device/);
      }
    });

    it('pinned + corroborated: low_confidence, naming the harness facts', () => {
      const r = mapReportToResult(report, ctx({ corroboration: ['drive coercion forced 1 drive-required behavior(s) to not_testable'] }));
      expect(r.status).toBe('low_confidence');
      expect(r.errorMessage).toContain('harness-corroborated: drive coercion forced 1');
    });

    it('pinned + UNcorroborated: a verdict-less, blocking failed (a proven recipe that could not be exercised)', () => {
      const r = mapReportToResult(report, ctx({ corroboration: [] }));
      expect(r.status).toBe('failed');
      expect(r.verdict).toBeUndefined();
      expect(r.errorMessage).toContain(UNVERIFIABLE_UNCORROBORATED_MESSAGE);
      expect(r.errorMessage).toContain('FamilyControls needs a device');
      // The report is persisted as the agent said it, so the §3.1 classifier
      // reads reportOutcome 'unverifiable' — 'ambiguous', never 'deliverable'.
      expect(r.report?.outcome).toBe('unverifiable');
    });

    it('pinned + uncorroborated in the dirty fallback: unattributable, exactly like build_failed', () => {
      const r = mapReportToResult(report, ctx({ provisionMode: 'fallback' }));
      expect(r.status).toBe('skipped');
      expect(r.errorMessage).toContain('unattributable shared-worktree unverifiable');
    });

    it('never passes, whatever its behavior rows say', () => {
      const allPass = validReport({ outcome: 'unverifiable', diagnosis: 'x' });
      for (const executionMode of MODES) {
        expect(mapReportToResult(allPass, ctx({ executionMode, corroboration: ['c'] })).status).not.toBe('passed');
      }
    });
  });

  describe('fail', () => {
    const report = validReport({ outcome: 'fail', behaviors: [failedB1] });

    it.each(['pinned', 'legacy'] as const)('%s: a judged fail stays failed, whatever the floor', (executionMode) => {
      for (const floor of [null, verified, missing]) {
        const r = mapReportToResult(report, ctx({ executionMode, floor }));
        expect(r.status).toBe('failed');
        expect(r.verdict?.status).toBe('fail');
      }
    });

    it('explore + an UNATTESTED surface: low_confidence — its failure is not evidence against the change', () => {
      const r = mapReportToResult(report, ctx({ executionMode: 'explore', floor: missing }));
      expect(r.status).toBe('low_confidence');
      expect(r.verdict?.status).toBe('low_confidence');
      expect(r.errorMessage).toContain(ATTESTATION_EXPLORE_CAP_MESSAGE);
      expect(r.errorMessage).toContain('body had no nonce');
    });

    it('explore + a verified (or capped-but-verified) surface keeps the judged fail', () => {
      for (const floor of [verified, capped, null]) {
        const r = mapReportToResult(report, ctx({ executionMode: 'explore', floor }));
        expect(r.status).toBe('failed');
        expect(r.verdict?.status).toBe('fail');
        expect(r.foreignSurface).toBeUndefined();
      }
    });

    it('explore + a FOREIGN surface: failed, flagged foreignSurface so it is never charged to the deliverable', () => {
      const r = mapReportToResult(report, ctx({ executionMode: 'explore', floor: foreign }));
      expect(r.status).toBe('failed');
      expect(r.foreignSurface).toBe(true);
      expect(r.errorMessage).toContain(ATTESTATION_FOREIGN_MESSAGE);
    });
  });

  describe('pass', () => {
    it.each(MODES)('%s: a verified surface passes', (executionMode) => {
      expect(mapReportToResult(validReport(), ctx({ executionMode, floor: verified })).status).toBe('passed');
    });

    it.each(['pinned', 'legacy'] as const)('%s: a missing attestation FAILS, outranking the mutation demotion', (executionMode) => {
      const r = mapReportToResult(validReport(), ctx({ executionMode, floor: missing, mutated: true }));
      expect(r.status).toBe('failed');
      expect(r.errorMessage).toContain(ATTESTATION_MISSING_MESSAGE);
    });

    it('explore: a missing or capped attestation caps at low_confidence instead of failing', () => {
      for (const floor of [missing, capped]) {
        const r = mapReportToResult(validReport(), ctx({ executionMode: 'explore', floor }));
        expect(r.status).toBe('low_confidence');
        expect(r.verdict?.status).toBe('low_confidence');
        expect(r.errorMessage).toContain(ATTESTATION_EXPLORE_CAP_MESSAGE);
        expect(r.verdict?.feedback).toContain(floor.detail);
      }
    });

    it('explore: a FOREIGN surface fails, outranking the mutation demotion', () => {
      const r = mapReportToResult(validReport(), ctx({ executionMode: 'explore', floor: foreign, mutated: true }));
      expect(r.status).toBe('failed');
      expect(r.foreignSurface).toBe(true);
      expect(r.verdict).toBeUndefined();
    });

    it.each(MODES)('%s: no declared channel caps at low_confidence (unchanged)', (executionMode) => {
      const r = mapReportToResult(validReport(), ctx({ executionMode, floor: uncapped }));
      expect(r.status).toBe('low_confidence');
      expect(r.errorMessage).toContain(ATTESTATION_UNCAPPED_MESSAGE);
    });

    it('the mutation and not_testable demotions still apply under a verified floor', () => {
      expect(mapReportToResult(validReport(), ctx({ floor: verified, mutated: true })).status).toBe('low_confidence');
      expect(
        mapReportToResult(validReport({ behaviors: [untestableB1] }), ctx({ floor: verified })).status,
      ).toBe('low_confidence');
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateAttestationFloorForMode — §A1.2
// ---------------------------------------------------------------------------

describe('evaluateAttestationFloorForMode', () => {
  const served = makeTask({ serve: { cmd: SERVE_CMD } });
  const unserved = makeTask();
  const ok = (kind: AttestationSpec['kind']): HarnessAttestationResult => ({ verified: true, kind, detail: 'ok' });
  const bound: ServeBindingResult = { bound: true, detail: 'bound' };
  const foreign: ServeBindingResult = {
    bound: false,
    failure: 'port-owner',
    detail: 'port 29260 is held by pid 9001 in process group 9001',
    foreignListener: { pid: 9001, pgid: 9001, recordedGroup: 4242 },
  };
  const noPid: ServeBindingResult = { bound: false, failure: 'serve-pid', detail: 'no serve.pid' };
  const unbound = (b: Extract<ServeBindingResult, { bound: false }>): HarnessAttestationResult => ({
    verified: false,
    kind: 'http-endpoint',
    detail: `${SERVE_BINDING_FAILED_PREFIX} [${b.failure}]: ${b.detail}`,
  });

  it.each(['pinned', 'legacy'] as const)('%s is the pinned floor, unchanged — even a foreign listener is just "missing"', (mode) => {
    expect(evaluateAttestationFloorForMode(mode, served, HTTP_SPEC, unbound(foreign), foreign)).toEqual(
      evaluateAttestationFloor(HTTP_SPEC, unbound(foreign)),
    );
    expect(evaluateAttestationFloorForMode(mode, unserved, HTTP_SPEC, ok('http-endpoint'), null).kind).toBe('verified');
    expect(evaluateAttestationFloorForMode(mode, unserved, null, null, null).kind).toBe('uncapped');
  });

  it('explore: a listener OUTSIDE the recorded group is foreign — positive evidence, the one explore failure', () => {
    const floor = evaluateAttestationFloorForMode('explore', served, HTTP_SPEC, unbound(foreign), foreign);
    expect(floor.kind).toBe('foreign');
    expect(floor.detail).toContain('process group 9001');
  });

  it('explore: every other binding failure, and an unverified probe, is merely missing', () => {
    expect(evaluateAttestationFloorForMode('explore', served, HTTP_SPEC, unbound(noPid), noPid).kind).toBe('missing');
    const unverified: HarnessAttestationResult = { verified: false, kind: 'http-endpoint', detail: 'no nonce' };
    expect(evaluateAttestationFloorForMode('explore', served, HTTP_SPEC, unverified, bound).kind).toBe('missing');
  });

  it('explore: a port-mediated channel passes ONLY with a composed serve.cmd AND the full binding', () => {
    for (const kind of ['http-endpoint', 'dom-marker', 'cdp-token'] as const) {
      const spec = { kind, urlPath: '/v', selector: '#v', expression: 'x', expected: 'y' } as AttestationSpec;
      expect(evaluateAttestationFloorForMode('explore', served, spec, ok(kind), bound).kind).toBe('verified');
      // No composed serve: the binding cannot apply, so the verified nonce is capped.
      expect(evaluateAttestationFloorForMode('explore', unserved, spec, ok(kind), null).kind).toBe('capped');
      // A composed serve whose binding never ran (e.g. a portless attach) is capped too.
      expect(evaluateAttestationFloorForMode('explore', served, spec, ok(kind), null).kind).toBe('capped');
    }
  });

  it('explore: file-identity and a verified bundle-identity reach passed; window-identity is capped', () => {
    const bareFile = makeTask({ attestation: undefined, target: { htmlPath: 'dist/index.html' } });
    expect(evaluateAttestationFloorForMode('explore', bareFile, { kind: 'file-identity' }, null, null).kind).toBe('verified');
    const bundle: AttestationSpec = { kind: 'bundle-identity', bundleId: 'com.acme.ios' };
    expect(evaluateAttestationFloorForMode('explore', unserved, bundle, ok('bundle-identity'), null).kind).toBe('verified');
    const window: AttestationSpec = { kind: 'window-identity', titlePattern: 'Acme', app: 'Acme' };
    expect(evaluateAttestationFloorForMode('explore', unserved, window, ok('window-identity'), null).kind).toBe('capped');
  });

  it('explore: a DECLARED file-identity on a task that builds or serves is missing — by construction only for a bare htmlPath', () => {
    const fileSpec: AttestationSpec = { kind: 'file-identity' };
    const bareFile = makeTask({ attestation: fileSpec, target: { htmlPath: 'dist/index.html' } });
    expect(evaluateAttestationFloorForMode('explore', bareFile, fileSpec, null, null).kind).toBe('verified');
    // The verify-setup prompt's named loophole ("file-identity is NOT the escape
    // hatch for static files") — in explore no proven record stands behind the
    // declaration, so the composer's claim alone must not reach passed.
    const servedFile = makeTask({ attestation: fileSpec, serve: { cmd: SERVE_CMD } });
    const builtFile = makeTask({ attestation: fileSpec, build: ['pnpm build'], target: { htmlPath: 'dist/index.html' } });
    for (const task of [servedFile, builtFile]) {
      const floor = evaluateAttestationFloorForMode('explore', task, fileSpec, null, null);
      // Nothing was verified, so not even `capped` (which would keep a judged fail).
      expect(floor.kind).toBe('missing');
      expect(floor.detail).toContain('bare target.htmlPath');
    }
    // Pinned keeps its proven record's word for it (unchanged).
    expect(evaluateAttestationFloorForMode('pinned', servedFile, fileSpec, null, null).kind).toBe('verified');
  });

  it('explore: no declared channel stays uncapped', () => {
    expect(evaluateAttestationFloorForMode('explore', unserved, null, null, null).kind).toBe('uncapped');
  });
});

// ---------------------------------------------------------------------------
// unverifiableCorroboration — §A4 (a)–(d)
// ---------------------------------------------------------------------------

describe('unverifiableCorroboration', () => {
  const base = {
    floor: null,
    probe: null,
    task: makeTask(),
    modality: 'web' as const,
    mobileDrive: null,
    driveUnsupported: false,
    driveCoerced: 0,
  };

  it('nothing observed ⇒ uncorroborated', () => {
    expect(unverifiableCorroboration(base)).toEqual([]);
  });

  it('(a) a harness-VERIFIED surface corroborates; an unverified one does not', () => {
    expect(
      unverifiableCorroboration({ ...base, floor: { kind: 'verified', channel: 'http-endpoint', detail: 'ok' } }),
    ).toHaveLength(1);
    expect(unverifiableCorroboration({ ...base, floor: { kind: 'missing', detail: 'no' } })).toEqual([]);
  });

  it('(b) a mobile drive rung of none, or an undrivable surface with drive-required behaviors, corroborates', () => {
    expect(unverifiableCorroboration({ ...base, modality: 'mobile', mobileDrive: 'none' })[0]).toContain('drive rung is none');
    expect(unverifiableCorroboration({ ...base, modality: 'mobile', mobileDrive: 'maestro' })).toEqual([]);
    const driveTask = makeTask({ behaviors: [{ id: 'b1', description: 'click', expected: 'x', requiresDrive: true }] });
    const nativeScreen = { ...base, modality: 'native-screen' as const, driveUnsupported: true, task: driveTask };
    // The coercion count is reason text only.
    expect(unverifiableCorroboration({ ...nativeScreen, driveCoerced: 2 })[0]).toContain('drive coercion forced 2');
  });

  it('(b) keys on the HARNESS facts, not the coercion count: the honest agent that coerced nothing is corroborated too', () => {
    const driveTask = makeTask({ behaviors: [{ id: 'b1', description: 'click', expected: 'x', requiresDrive: true }] });
    const honest = unverifiableCorroboration({ ...base, modality: 'native-screen', driveUnsupported: true, task: driveTask });
    expect(honest).toHaveLength(1);
    expect(honest[0]).toContain('"native-screen" surface cannot be driven and the task has 1 drive-required behavior(s)');
    // No drive-required behavior ⇒ undrivability explains nothing.
    expect(unverifiableCorroboration({ ...base, modality: 'native-screen', driveUnsupported: true })).toEqual([]);
    // A drivable surface is not corroborated by having drive behaviors.
    expect(unverifiableCorroboration({ ...base, task: driveTask })).toEqual([]);
  });

  it('(c) a declared modality the request did not run under, or an app block with no simulator, corroborates', () => {
    const stampedWeb = unverifiableCorroboration({ ...base, task: makeTask({ modality: 'native-screen' }) });
    expect(stampedWeb[0]).toContain('declared modality "native-screen" but the request ran as "web"');
    expect(unverifiableCorroboration({ ...base, task: makeTask({ app: APP }) })[0]).toContain('no simulator was leased');
    // Agreeing declarations are not a mismatch.
    expect(unverifiableCorroboration({ ...base, task: makeTask({ modality: 'web' }) })).toEqual([]);
    expect(unverifiableCorroboration({ ...base, task: makeTask({ app: APP }), modality: 'mobile', mobileDrive: 'maestro' })).toEqual(
      [],
    );
  });

  it("(d) peekaboo's ambiguous-identifier refusal corroborates — read only off an UNVERIFIED probe", () => {
    const ambiguous: HarnessAttestationResult = {
      verified: false,
      kind: 'window-identity',
      detail: 'window-identity: probe failed — Error: Ambiguous application identifier "Acme"',
    };
    expect(unverifiableCorroboration({ ...base, probe: ambiguous })[0]).toContain('ambiguous application identifier');
    // A VERIFIED probe's detail echoes a window title the app chose — not evidence.
    expect(unverifiableCorroboration({ ...base, probe: { ...ambiguous, verified: true } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reapplyUnverifiableAfterDriveCoercion — §A4 over the coerced set
// ---------------------------------------------------------------------------

describe('reapplyUnverifiableAfterDriveCoercion', () => {
  const coercedFail = validReport({ outcome: 'fail', behaviors: [untestableB1], feedback: 'could not tap the button' });

  it('turns a fail left with nothing failing and everything not_testable into unverifiable', () => {
    const { report, reapplied } = reapplyUnverifiableAfterDriveCoercion(coercedFail, 1, 1);
    expect(reapplied).toBe(true);
    expect(report.outcome).toBe('unverifiable');
    expect(report.diagnosis).toContain(UNVERIFIABLE_COERCION_NOTE);
    expect(report.diagnosis).toContain('after the harness coerced 1 drive-required behavior(s)');
    expect(report.diagnosis).toContain('Agent: could not tap the button');
  });

  it('leaves the report alone when coercion removed nothing, a behavior still passed, or the task has none', () => {
    expect(reapplyUnverifiableAfterDriveCoercion(coercedFail, 1, 0).reapplied).toBe(false);
    const partial = validReport({
      outcome: 'fail',
      behaviors: [untestableB1, { id: 'b2', result: 'pass', evidence: { screenshots: [], notes: '' } }],
    });
    expect(reapplyUnverifiableAfterDriveCoercion(partial, 2, 1).reapplied).toBe(false);
    expect(reapplyUnverifiableAfterDriveCoercion(validReport({ outcome: 'fail', behaviors: [] }), 0, 1).reapplied).toBe(false);
    expect(reapplyUnverifiableAfterDriveCoercion(validReport({ behaviors: [untestableB1] }), 1, 1).reapplied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The mode-conditional harness contract — §A1.1
// ---------------------------------------------------------------------------

describe('verifyHarnessContract(provider, mode)', () => {
  /** The pinned passages §A1.1 says explore must REPLACE, not contradict. */
  const PINNED_PASSAGES = [
    "THE SERVE COMMAND MUST BE THE TASK'S, EXACTLY",
    'an unbound surface FAILS the task',
    "Run the task's build steps first",
    'When absent, the task points at an already-live target',
    'cannot be attested and the task will FAIL',
    'is rejected as unproven',
  ];

  it('pinned and legacy read the pinned constant, on both runtimes (the phrase-pin tests keep holding)', () => {
    expect(verifyHarnessContract('claude', 'pinned')).toBe(VERIFY_HARNESS_CONTRACT);
    expect(verifyHarnessContract('claude', 'legacy')).toBe(VERIFY_HARNESS_CONTRACT);
    expect(verifyHarnessContract('claude')).toBe(VERIFY_HARNESS_CONTRACT);
    expect(verifyHarnessContract('codex', 'legacy')).toBe(VERIFY_HARNESS_CONTRACT_CODEX);
    for (const passage of PINNED_PASSAGES) {
      expect(flat(VERIFY_HARNESS_CONTRACT)).toContain(passage);
      expect(flat(VERIFY_HARNESS_CONTRACT_CODEX)).toContain(passage);
    }
    expect(VERIFY_HARNESS_CONTRACT).not.toContain('EXPLORE MODE —');
  });

  it.each(['claude', 'codex'] as const)('%s explore REPLACES every pinned passage rather than contradicting it', (provider) => {
    const explore = flat(verifyHarnessContract(provider, 'explore'));
    for (const passage of PINNED_PASSAGES) expect(explore).not.toContain(passage);
    expect(explore).toContain("THE TASK'S BUILD AND SERVE ARE HINTS HERE, NOT A PROVEN RECIPE");
    expect(explore).toContain('is the ONLY way a web or cdp-app run can reach "passed"');
    expect(explore).toContain('its verdict is capped at low_confidence however good it looks');
    expect(explore).toContain("The task's build steps are HINTS");
    expect(explore).toContain('VERIFY_PORT — the dev/preview server port leased to THIS request');
    expect(explore.match(/EXPLORE MODE — /g)).toHaveLength(1);
  });

  it('the explore text carries the §A1.4 prompt guardrails; the pinned text carries none of them', () => {
    const explore = flat(verifyHarnessContract('claude', 'explore'));
    const guardrails = [
      'Serve on $VERIFY_PORT and attach on $VERIFY_DRIVER_PORT',
      'NEVER stop, kill or signal a process you did not start yourself',
      'Use ONLY the simulator leased to you (VERIFY_SIM_UDID)',
      'Never edit tracked sources',
      'confine BOTH to $VERIFY_DATA_DIR',
      'report "unverifiable" rather than launch it',
      'build the snapshot AS-IS',
      'no PlistBuddy, plutil, cp or ditto into the product',
      'never build from a copy of the sources, or from outside the snapshot',
      '-clonedSourcePackagesDirPath',
      'CODE_SIGNING_ALLOWED=NO',
      'never stage the fixed product',
      'it does NOT make a build sound however it was produced',
    ];
    for (const rule of guardrails) {
      expect(explore).toContain(rule);
      expect(flat(VERIFY_HARNESS_CONTRACT)).not.toContain(rule);
    }
  });

  it.each(['pinned', 'legacy', 'explore'] as const)('%s: the outcome enumeration is the shared constant, and the A4 rules ride along', (mode) => {
    for (const provider of ['claude', 'codex'] as const) {
      const text = flat(verifyHarnessContract(provider, mode));
      expect(text).toContain(`"outcome": ${VERIFICATION_REPORT_OUTCOMES.map((o) => `"${o}"`).join(' | ')},`);
      expect(text).toContain('"fail" must name an OBSERVED defect');
      expect(text).toContain('Anything you could not exercise is "unverifiable", never "fail"');
      expect(text).toContain('"neededModality" and "diagnosis" are required');
      expect(text).toContain('"recipeJson" is optional');
    }
  });

  it('only explore asks for recipeJson content', () => {
    expect(flat(verifyHarnessContract('claude', 'explore'))).toContain('ONE portable-runbook entry for VERIFY_MODALITY');
    expect(flat(VERIFY_HARNESS_CONTRACT)).not.toContain('ONE portable-runbook entry');
  });
});

// ---------------------------------------------------------------------------
// The EXPLORE HINTS block — §A1.3
// ---------------------------------------------------------------------------

describe('composeVerifyUserPrompt — EXPLORE HINTS', () => {
  const record = makeExploreRecord();
  const web = record.runbook.modalities.web;

  it('adds nothing without hints, and keeps the task as the prompt\'s FIRST json fence with them', () => {
    const task = makeTask({ build: ['pnpm build'], serve: { cmd: SERVE_CMD } });
    expect(composeVerifyUserPrompt(task)).not.toContain('EXPLORE HINTS');
    const prompt = composeVerifyUserPrompt(task, {
      modality: 'web',
      composed: { build: task.build, serve: task.serve },
      record: { hash: record.hash, status: record.status, origin: record.origin, entry: web ?? null, leverNotes: 'vite reads PORT' },
      boundLevers: ['PORT (= $VERIFY_PORT)'],
    });
    const fence = /```json\n([\s\S]*?)\n```/.exec(prompt);
    expect(JSON.parse(fence?.[1] ?? 'null')).toEqual(task);
    expect(prompt.match(/```json/g)).toHaveLength(1);
    const hints = prompt.slice(prompt.indexOf('EXPLORE HINTS'));
    expect(hints).toContain('NOT a proven recipe');
    expect(hints).toContain('- Composed build: ["pnpm build"]');
    expect(hints).toContain(`- Composed serve: ${JSON.stringify(SERVE_CMD)}`);
    expect(hints).toContain(`record ${RECORD_HASH.slice(0, 12)} (status "unproven-draft", origin "learned")`);
    expect(hints).toContain('treat its commands as hints too');
    expect(hints).toContain('- build: ["pnpm run build:web"]');
    expect(hints).toContain('- notes: the preview script serves the built bundle');
    expect(hints).toContain('- lever notes: vite reads PORT');
    expect(hints).toContain('PORT (= $VERIFY_PORT)');
  });

  it('says so when no record exists', () => {
    const prompt = composeVerifyUserPrompt(makeTask(), { modality: 'cdp-app', composed: {}, record: null, boundLevers: [] });
    expect(prompt).toContain('No verification runbook is registered for this project\'s "cdp-app" modality.');
    expect(prompt).toContain('- Composed serve: none');
    expect(prompt).toContain('No runbook lever was bound');
  });

  it('describeBoundLevers lists only the names the env actually carries', () => {
    const levers = { portEnv: 'PORT', dataDirEnv: 'CYBOFLOW_DIR', nonceEnv: 'PATH' };
    expect(describeBoundLevers(levers, { PORT: '29260', CYBOFLOW_DIR: '/d' })).toEqual([
      'PORT (= $VERIFY_PORT)',
      'CYBOFLOW_DIR (= $VERIFY_DATA_DIR)',
    ]);
    expect(describeBoundLevers(undefined, { PORT: '1' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Env hygiene — the host data dir and the wrapper's literal port
// ---------------------------------------------------------------------------

describe('stripHostDataDirEnv', () => {
  it("blanks the host's CYBOFLOW_DIR unless a lever re-bound it, and emits nothing when there is nothing to strip", () => {
    expect(stripHostDataDirEnv({}, { CYBOFLOW_DIR: '/Users/dev/.cyboflow_test' })).toEqual({ CYBOFLOW_DIR: '' });
    expect(stripHostDataDirEnv({ CYBOFLOW_DIR: '/artifacts/data/x' }, { CYBOFLOW_DIR: '/Users/dev/.cyboflow_test' })).toEqual({});
    expect(stripHostDataDirEnv({}, {})).toEqual({});
    expect(stripHostDataDirEnv({}, { CYBOFLOW_DIR: '' })).toEqual({});
  });
});

describe('driverScriptBody — the leased driver port as a literal (§A1.4)', () => {
  it('exports it on POSIX, after NODE_PATH and before exec', () => {
    expect(driverScriptBody('/usr/bin/node', '/app/driverCli.js', '/repo/node_modules', 'darwin', { driverPort: 29261 })).toBe(
      '#!/bin/sh\n'
        + 'export ELECTRON_RUN_AS_NODE=1\n'
        + 'export NODE_PATH="/repo/node_modules"\n'
        + 'export VERIFY_DRIVER_PORT="29261"\n'
        + 'exec "/usr/bin/node" "/app/driverCli.js" "$@"\n',
    );
  });

  it('sets it on Windows, and emits no port line for a portless request', () => {
    expect(driverScriptBody('C:\\node.exe', 'C:\\d.js', null, 'win32', { driverPort: 29261 })).toContain(
      'set VERIFY_DRIVER_PORT=29261\r\n',
    );
    for (const platform of ['darwin', 'win32'] as const) {
      expect(driverScriptBody('/n', '/d', null, platform, { driverPort: null })).not.toContain('VERIFY_DRIVER_PORT');
      expect(driverScriptBody('/n', '/d', null, platform)).not.toContain('VERIFY_DRIVER_PORT');
    }
  });
});

// ---------------------------------------------------------------------------
// run() — provenance, contract, hints, levers, env, guards, shim
// ---------------------------------------------------------------------------

describe('VerificationAgentRunner.run — harness-owned provenance (§A1.1)', () => {
  it('stamps explore + the lever source on every report', async () => {
    const { runner } = makeRunner();
    const result = await runner.run(makeReq({ executionMode: 'explore', exploreRecord: makeExploreRecord() }));
    expect(result.report?.provenance).toEqual({
      executionMode: 'explore',
      leverSource: { hash: RECORD_HASH, status: 'unproven-draft', origin: 'learned' },
    });
  });

  it('stamps legacy / pinned with no lever source', async () => {
    const legacy = await makeRunner().runner.run(makeReq());
    expect(legacy.report?.provenance).toEqual({ executionMode: 'legacy' });
    // Pinned WITHOUT a hash (an explicit mode): the pin check has nothing to run against.
    const pinned = await makeRunner().runner.run(makeReq({ executionMode: 'pinned' }));
    expect(pinned.report?.provenance).toEqual({ executionMode: 'pinned' });
  });

  it('an agent-supplied provenance never survives — not its mode, not its lever source', async () => {
    const forged = {
      ...validReport(),
      provenance: { executionMode: 'pinned', leverSource: { hash: 'forged', status: 'proven', origin: 'setup-flow' } },
    };
    const { runner } = makeRunner({ query: async () => outcome(forged) });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(result.report?.provenance).toEqual({ executionMode: 'explore' });
  });

  it('rides a report the phantom-screenshot check blocks, too', async () => {
    // Only the cited screenshot is missing — preflight's own driver-CLI check must still pass.
    const { runner } = makeRunner({ fileExists: async (absPath) => !absPath.endsWith('s.png') });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(result.status).toBe('failed');
    expect(result.report?.provenance?.executionMode).toBe('explore');
  });
});

describe('VerificationAgentRunner.run — the mode picks the contract and the hints', () => {
  it('explore deploys the explore contract plus EXPLORE HINTS naming the record', async () => {
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode: 'explore', exploreRecord: makeExploreRecord() }));
    const args = query.mock.calls[0][0];
    expect(args.systemPrompt).toContain('SYSTEM PROMPT BODY');
    expect(args.systemPrompt).toContain(verifyHarnessContract('claude', 'explore'));
    expect(args.prompt).toContain('EXPLORE HINTS');
    expect(args.prompt).toContain('- serve: "pnpm run preview --port ${PORT}"');
    expect(args.prompt).toContain('PORT (= $VERIFY_PORT)');
  });

  it('legacy and pinned deploy the pinned contract and no hints', async () => {
    for (const executionMode of ['legacy', 'pinned'] as const) {
      const { runner, query } = makeRunner();
      await runner.run(makeReq({ executionMode, exploreRecord: makeExploreRecord() }));
      const args = query.mock.calls[0][0];
      expect(args.systemPrompt).toContain(VERIFY_HARNESS_CONTRACT);
      expect(args.prompt).not.toContain('EXPLORE HINTS');
    }
  });

  it('a Codex-routed explore request gets the Codex explore contract', async () => {
    const { runner, codexQuery } = makeRunner({
      materializeDependencyGuardShim: async () => ({ binDir: '/artifacts/.driver/dep-guard/vr-explore-1/bin' }),
      resolveVerifyAgent: () => ({ agent: { ...makeAgent(), runtime: 'codex-sdk' }, runProvider: 'claude', runModel: null }),
    });
    await runner.run(makeReq({ executionMode: 'explore' }));
    expect(codexQuery.mock.calls[0][0].systemPrompt).toContain(verifyHarnessContract('codex', 'explore'));
  });
});

describe('VerificationAgentRunner.run — explore binds ONLY the record\'s levers (§A1.3)', () => {
  const HARNESS_KEYS = new Set([
    'VERIFY_ARTIFACTS_DIR',
    'PATH',
    'VERIFY_DATA_DIR',
    'VERIFY_DRIVER_PORT',
    'VERIFY_DRIVER',
    'VERIFY_ATTEST_NONCE',
    'VERIFY_MODALITY',
    'VERIFY_PEEKABOO_BIN',
    'VERIFY_PORT',
  ]);

  it('binds portEnv / dataDirEnv to the leased values, and nothing of the record\'s build/serve', async () => {
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode: 'explore', exploreRecord: makeExploreRecord() }));
    const env = query.mock.calls[0][0].env;
    expect(env.PORT).toBe('29260');
    expect(env.CYBOFLOW_DIR).toBe(env.VERIFY_DATA_DIR);
    expect(Object.keys(env).filter((k) => !HARNESS_KEYS.has(k)).sort()).toEqual(['CYBOFLOW_DIR', 'PORT']);
    expect(Object.values(env).some((v) => v.includes('pnpm run'))).toBe(false);
  });

  it('keeps the lever rules: a lever may never shadow a harness variable', async () => {
    const { runner, query } = makeRunner();
    const record = makeExploreRecord();
    await runner.run(
      makeReq({
        executionMode: 'explore',
        exploreRecord: { ...record, runbook: { ...record.runbook, levers: { nonceEnv: 'VERIFY_PORT', portEnv: 'PATH' } } },
      }),
    );
    const env = query.mock.calls[0][0].env;
    expect(env.VERIFY_PORT).toBe('29260');
    expect(env.PATH).toBe(FAKE_SHELL_PATH);
  });

  it('a non-explore request never binds an explore record\'s levers', async () => {
    for (const executionMode of ['legacy', 'pinned'] as const) {
      const { runner, query } = makeRunner();
      await runner.run(makeReq({ executionMode, exploreRecord: makeExploreRecord() }));
      expect(query.mock.calls[0][0].env.PORT).toBeUndefined();
    }
  });

  it('exports VERIFY_PORT on an explore request the engine leased a port for', async () => {
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode: 'explore', task: makeTask({ attestation: undefined }) }));
    expect(query.mock.calls[0][0].env.VERIFY_PORT).toBe('29260');
  });
});

describe("VerificationAgentRunner.run — the host's CYBOFLOW_DIR (§A1.3)", () => {
  it.each(['legacy', 'pinned', 'explore'] as const)('%s: blanked in the agent env the serve children inherit', async (executionMode) => {
    vi.stubEnv('CYBOFLOW_DIR', '/Users/dev/.cyboflow_test');
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode }));
    expect(query.mock.calls[0][0].env.CYBOFLOW_DIR).toBe('');
  });

  it('a lever re-binding it wins: the request data dir, never the blank', async () => {
    vi.stubEnv('CYBOFLOW_DIR', '/Users/dev/.cyboflow_test');
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode: 'explore', exploreRecord: makeExploreRecord() }));
    const env = query.mock.calls[0][0].env;
    expect(env.CYBOFLOW_DIR).toBe(env.VERIFY_DATA_DIR);
    expect(env.CYBOFLOW_DIR).toBe(join('/artifacts', 'data', 'xplore-1'));
  });

  it('adds nothing when the host carries no value', async () => {
    vi.stubEnv('CYBOFLOW_DIR', '');
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode: 'explore' }));
    expect(query.mock.calls[0][0].env.CYBOFLOW_DIR).toBeUndefined();
  });
});

describe('VerificationAgentRunner.run — the wrapper pins the leased driver port', () => {
  it('hands the writer the driver port, and null on a portless mobile request', async () => {
    const web = makeRunner();
    await web.runner.run(makeReq({ executionMode: 'explore' }));
    expect(web.writeDriverScript.mock.calls[0]).toEqual(['/artifacts', '/usr/bin/node', '/app/driverCli.js', null, { driverPort: 29261 }]);
    const mobile = makeRunner({ mobile: mobileDeps({ maestro: true }), attest: bundleVerified });
    await mobile.runner.run(makeMobileReq({ executionMode: 'explore' }));
    expect(mobile.writeDriverScript.mock.calls[0][4]).toEqual({ driverPort: null });
  });
});

describe('VerificationAgentRunner.run — explore-only structural guards (§A1.4)', () => {
  it('explore web: no process kills; the simulator guard stays off', async () => {
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ executionMode: 'explore' }));
    expect(query.mock.calls[0][0].guards).toEqual({ executionMode: 'explore', denyProcessKill: true, denySimctlLifecycle: false });
  });

  it('explore mobile: no process kills and no simulator lifecycle', async () => {
    const { runner, query } = makeRunner({ mobile: mobileDeps({ maestro: true }), attest: bundleVerified });
    await runner.run(makeMobileReq({ executionMode: 'explore' }));
    expect(query.mock.calls[0][0].guards).toEqual({ executionMode: 'explore', denyProcessKill: true, denySimctlLifecycle: true });
  });

  it('pinned and legacy carry no structural guards — only the mode the dependency deny message keys on', async () => {
    for (const executionMode of ['pinned', 'legacy'] as const) {
      const { runner, query } = makeRunner();
      await runner.run(makeReq({ executionMode }));
      expect(query.mock.calls[0][0].guards).toEqual({ executionMode });
    }
  });

  it('the Codex seam receives the identical guards (it ignores them; the PATH shim is its guard)', async () => {
    const { runner, codexQuery } = makeRunner({
      materializeDependencyGuardShim: async () => ({ binDir: '/artifacts/.driver/dep-guard/vr-explore-1/bin' }),
      resolveVerifyAgent: () => ({ agent: { ...makeAgent(), runtime: 'codex-sdk' }, runProvider: 'claude', runModel: null }),
    });
    await runner.run(makeReq({ executionMode: 'explore' }));
    expect(codexQuery.mock.calls[0][0].guards).toEqual({ executionMode: 'explore', denyProcessKill: true, denySimctlLifecycle: false });
  });
});

describe('VerificationAgentRunner.run — the dependency-guard PATH shim (§A1.4, F8)', () => {
  it.each(['legacy', 'pinned', 'explore'] as const)('%s: prepended in front of the harness PATH', async (executionMode) => {
    const shim = vi.fn(async () => ({ binDir: '/artifacts/.driver/dep-guard/vr-explore-1/bin' }));
    const { runner, query } = makeRunner({ materializeDependencyGuardShim: shim });
    await runner.run(makeReq({ executionMode }));
    expect(query.mock.calls[0][0].env.PATH).toBe(['/artifacts/.driver/dep-guard/vr-explore-1/bin', FAKE_SHELL_PATH].join(delimiter));
  });

  it('is materialized per request with the driver wrapper\'s own interpreter, and never NODE_PATH', async () => {
    const shim = vi.fn(async () => ({ binDir: null }));
    const { runner } = makeRunner({ materializeDependencyGuardShim: shim, resolveNodeModulesRoot: async () => '/app/node_modules' });
    await runner.run(makeReq({ executionMode: 'explore' }));
    expect(shim).toHaveBeenCalledWith({
      dir: join('/artifacts', '.driver', 'dep-guard', 'vr-explore-1'),
      nodePath: '/usr/bin/node',
      nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
      executionMode: 'explore',
    });
  });

  it.each(['legacy', 'pinned'] as const)('%s: the shim is told the request mode for its deny message', async (executionMode) => {
    const shim = vi.fn(async () => ({ binDir: null }));
    const { runner } = makeRunner({ materializeDependencyGuardShim: shim });
    await runner.run(makeReq({ executionMode }));
    expect(shim).toHaveBeenCalledWith(expect.objectContaining({ executionMode }));
  });

  describe('Codex explore needs the shim: it is the ONLY dependency guard there (§A1.4)', () => {
    const codexAgent = (): Partial<VerificationAgentRunnerDeps> => ({
      resolveVerifyAgent: () => ({ agent: { ...makeAgent(), runtime: 'codex-sdk' }, runProvider: 'claude', runModel: null }),
    });

    it('a null bin dir: skipped WITHOUT deploy, env-classed via a synthetic preflight row', async () => {
      const { runner, codexQuery } = makeRunner({ ...codexAgent(), materializeDependencyGuardShim: async () => ({ binDir: null }) });
      const result = await runner.run(makeReq({ executionMode: 'explore' }));
      expect(codexQuery).not.toHaveBeenCalled();
      expect(result.status).toBe('skipped');
      expect(result.deployed).toBe(false);
      expect(result.errorMessage).toBe(CODEX_EXPLORE_NO_GUARD_MESSAGE);
      expect(result.preflight?.ok).toBe(false);
      expect(result.preflight?.checks.filter((c) => !c.ok)).toEqual([
        { id: 'driver-cli', ok: false, detail: CODEX_EXPLORE_NO_GUARD_MESSAGE },
      ]);
    });

    it('a THROWING shim is the same refusal', async () => {
      const { runner, codexQuery } = makeRunner({
        ...codexAgent(),
        materializeDependencyGuardShim: async () => {
          throw new Error('ENOSPC');
        },
      });
      const result = await runner.run(makeReq({ executionMode: 'explore' }));
      expect(codexQuery).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'skipped', deployed: false, errorMessage: CODEX_EXPLORE_NO_GUARD_MESSAGE });
    });

    it('Codex pinned/legacy and Claude explore keep the fail-soft and deploy', async () => {
      for (const executionMode of ['pinned', 'legacy'] as const) {
        const { runner, codexQuery } = makeRunner({ ...codexAgent(), materializeDependencyGuardShim: async () => ({ binDir: null }) });
        await runner.run(makeReq({ executionMode }));
        expect(codexQuery).toHaveBeenCalledTimes(1);
      }
      const claude = makeRunner({ materializeDependencyGuardShim: async () => ({ binDir: null }) });
      await claude.runner.run(makeReq({ executionMode: 'explore' }));
      expect(claude.query).toHaveBeenCalledTimes(1);
    });
  });

  it('a null bin dir (win32, or a write failure) leaves the harness PATH exactly as it was', async () => {
    const { runner, query } = makeRunner({ materializeDependencyGuardShim: async () => ({ binDir: null }) });
    await runner.run(makeReq());
    expect(query.mock.calls[0][0].env.PATH).toBe(FAKE_SHELL_PATH);
  });

  it('a THROWING shim is fail-soft: logged, and the request still deploys and passes', async () => {
    const { runner, query, warn } = makeRunner({
      materializeDependencyGuardShim: async () => {
        throw new Error('EACCES');
      },
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed');
    expect(query.mock.calls[0][0].env.PATH).toBe(FAKE_SHELL_PATH);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dependency-guard PATH shim threw'),
      expect.objectContaining({ error: 'EACCES' }),
    );
  });
});

// ---------------------------------------------------------------------------
// run() — the mode-aware floor end to end (§A1.2)
// ---------------------------------------------------------------------------

describe('VerificationAgentRunner.run — the explore attestation floor', () => {
  const served = makeTask({ serve: { cmd: SERVE_CMD } });

  it('an unattested pass caps at low_confidence instead of failing', async () => {
    const { runner } = makeRunner({
      attest: async () => ({ verified: false, kind: 'http-endpoint', detail: 'connect ECONNREFUSED' }),
    });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain(ATTESTATION_EXPLORE_CAP_MESSAGE);
    expect(result.errorMessage).toContain('ECONNREFUSED');
  });

  it('the SAME unattested pass still FAILS when pinned (the pinned floor is untouched)', async () => {
    const { runner } = makeRunner({
      attest: async () => ({ verified: false, kind: 'http-endpoint', detail: 'connect ECONNREFUSED' }),
    });
    const result = await runner.run(makeReq({ executionMode: 'pinned' }));
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain(ATTESTATION_MISSING_MESSAGE);
  });

  it('a composed serve, started verbatim and bound, verified: passed', async () => {
    const { runner, attest } = makeRunner(servedBy(SERVE_CMD));
    const result = await runner.run(makeReq({ executionMode: 'explore', task: served }));
    expect(result.status).toBe('passed');
    expect(attest).toHaveBeenCalledTimes(1);
  });

  it('a stand-up OTHER than the composed serve: low_confidence, the channel never asked', async () => {
    const { runner, attest } = makeRunner({
      readServePid: async () => SERVE_LEADER_PID,
      listeningPidForPort: async () => SERVE_LEADER_PID,
      processInfo: async () => ({ pgid: SERVE_LEADER_PID, command: 'sh -c npm run dev -- --port 29260' }),
    });
    const result = await runner.run(makeReq({ executionMode: 'explore', task: served }));
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('[command]');
    expect(attest).not.toHaveBeenCalled();
  });

  it('no composed serve at all: the verified nonce is capped at low_confidence', async () => {
    const { runner, attest } = makeRunner();
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(attest).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('the task composed no serve.cmd');
  });

  describe('no composed serve.cmd: the serve-pid + port-owner half still runs (§A1.2)', () => {
    it('a FOREIGN listener still fails the pass, flagged foreignSurface, the channel never asked', async () => {
      const { runner, attest } = makeRunner(foreignListener);
      const result = await runner.run(makeReq({ executionMode: 'explore' }));
      expect(result.status).toBe('failed');
      expect(result.foreignSurface).toBe(true);
      expect(result.errorMessage).toContain(ATTESTATION_FOREIGN_MESSAGE);
      expect(result.errorMessage).toContain('process group 9001');
      expect(attest).not.toHaveBeenCalled();
    });

    it('a FOREIGN listener turns a judged explore fail into the foreign failure, too', async () => {
      const { runner } = makeRunner({
        ...foreignListener,
        query: async () => outcome(validReport({ outcome: 'fail', behaviors: [failedB1] })),
      });
      const result = await runner.run(makeReq({ executionMode: 'explore' }));
      expect(result.status).toBe('failed');
      expect(result.foreignSurface).toBe(true);
    });

    it('a listener INSIDE the recorded group binds but never reaches passed — capped, with no command step', async () => {
      const { runner, attest } = makeRunner(servedBy('whatever the agent ran'));
      const result = await runner.run(makeReq({ executionMode: 'explore' }));
      expect(attest).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('low_confidence');
      expect(result.errorMessage).toContain('the task composed no serve.cmd');
    });

    it('an absence of evidence (no serve.pid) records the failure but still asks the channel', async () => {
      const { runner, attest } = makeRunner({ readServePid: async () => null });
      const result = await runner.run(makeReq({ executionMode: 'explore' }));
      expect(attest).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('low_confidence');
      expect(result.foreignSurface).toBeUndefined();
    });

    it('pinned with no serve.cmd is untouched: no binding at all, so a foreign-looking listener is never consulted', async () => {
      const listeningPidForPort = vi.fn(async () => FOREIGN_PID);
      const { runner } = makeRunner({ ...foreignListener, listeningPidForPort });
      const result = await runner.run(makeReq({ executionMode: 'pinned' }));
      expect(listeningPidForPort).not.toHaveBeenCalled();
      expect(result.status).toBe('passed');
    });
  });

  it('a FOREIGN listener on the leased port fails the pass, flagged foreignSurface', async () => {
    const { runner, attest } = makeRunner(foreignListener);
    const result = await runner.run(makeReq({ executionMode: 'explore', task: served }));
    expect(result.status).toBe('failed');
    expect(result.foreignSurface).toBe(true);
    expect(result.errorMessage).toContain(ATTESTATION_FOREIGN_MESSAGE);
    expect(attest).not.toHaveBeenCalled();
  });

  it('a served task that DECLARES file-identity cannot pass in explore — low_confidence, never probed', async () => {
    const { runner, attest } = makeRunner(servedBy(SERVE_CMD));
    const result = await runner.run(
      makeReq({ executionMode: 'explore', task: makeTask({ attestation: { kind: 'file-identity' }, serve: { cmd: SERVE_CMD } }) }),
    );
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain(ATTESTATION_EXPLORE_CAP_MESSAGE);
    // The same task pinned is the proven record's claim, and passes as before.
    const pinned = await makeRunner(servedBy(SERVE_CMD)).runner.run(
      makeReq({ executionMode: 'pinned', task: makeTask({ attestation: { kind: 'file-identity' }, serve: { cmd: SERVE_CMD } }) }),
    );
    expect(pinned.status).toBe('passed');
  });

  it('an explore FAIL on a served task that DECLARES file-identity is unattested — low_confidence, not a judged fail', async () => {
    const { runner } = makeRunner({ query: async () => outcome(validReport({ outcome: 'fail', behaviors: [failedB1] })) });
    const result = await runner.run(
      makeReq({ executionMode: 'explore', task: makeTask({ attestation: { kind: 'file-identity' }, serve: { cmd: SERVE_CMD } }) }),
    );
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('not evidence against the change');
  });

  it('a verified mobile bundle-identity passes in explore', async () => {
    const { runner } = makeRunner({ mobile: mobileDeps({ maestro: true }), attest: bundleVerified });
    const result = await runner.run(makeMobileReq({ executionMode: 'explore' }));
    expect(result.status).toBe('passed');
  });

  it('explore mobile with NO declared channel probes an implicit bundle-identity and passes (an inferred app)', async () => {
    const attest = vi.fn(bundleVerified);
    const { runner } = makeRunner({ mobile: mobileDeps({ maestro: true }), attest });
    const result = await runner.run(
      makeMobileReq({ executionMode: 'explore', task: makeTask({ app: APP, attestation: undefined }) }),
    );
    expect(attest).toHaveBeenCalledTimes(1);
    expect((attest.mock.calls[0] as unknown[])[0]).toEqual({ kind: 'bundle-identity', bundleId: APP.bundleId });
    expect(result.status).toBe('passed');
  });

  it('pinned mobile with no declared channel is NOT given the implicit spec — still capped', async () => {
    const attest = vi.fn(bundleVerified);
    const { runner } = makeRunner({ mobile: mobileDeps({ maestro: true }), attest });
    const result = await runner.run(
      makeMobileReq({ executionMode: 'pinned', task: makeTask({ app: APP, attestation: undefined }) }),
    );
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('low_confidence');
  });

  it('an explore FAIL on an unattested surface: low_confidence — and the probe DID run for it', async () => {
    const attest = vi.fn(async (): Promise<HarnessAttestationResult> => ({ verified: false, kind: 'http-endpoint', detail: 'no nonce' }));
    const { runner } = makeRunner({ attest, query: async () => outcome(validReport({ outcome: 'fail', behaviors: [failedB1] })) });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(attest).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('not evidence against the change');
  });

  it('an explore FAIL on a verified surface stays a judged fail', async () => {
    const { runner } = makeRunner({ query: async () => outcome(validReport({ outcome: 'fail', behaviors: [failedB1] })) });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(result.status).toBe('failed');
    expect(result.verdict?.status).toBe('fail');
  });

  it('an explore FAIL with no declared channel is never probed and stays failed', async () => {
    const { runner, attest } = makeRunner({
      query: async () => outcome(validReport({ outcome: 'fail', behaviors: [failedB1] })),
    });
    const result = await runner.run(makeReq({ executionMode: 'explore', task: makeTask({ attestation: undefined }) }));
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });
});

describe('VerificationAgentRunner.run — unverifiable and wrong_environment end to end', () => {
  const unverifiable = validReport({ outcome: 'unverifiable', diagnosis: 'needs a paired Apple Watch', behaviors: [untestableB1] });

  it('pinned + a declared channel the harness VERIFIED: corroborated (a) — low_confidence', async () => {
    const { runner, attest } = makeRunner({ query: async () => outcome(unverifiable) });
    const result = await runner.run(makeReq({ executionMode: 'pinned' }));
    expect(attest).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('harness attested the stood-up surface');
  });

  it('pinned + a channel that did NOT verify: uncorroborated — a blocking failed', async () => {
    const { runner } = makeRunner({
      query: async () => outcome(unverifiable),
      attest: async () => ({ verified: false, kind: 'http-endpoint', detail: 'no nonce' }),
    });
    const result = await runner.run(makeReq({ executionMode: 'pinned' }));
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain(UNVERIFIABLE_UNCORROBORATED_MESSAGE);
  });

  it('pinned with no declared channel: never probed, uncorroborated — failed', async () => {
    const { runner, attest } = makeRunner({ query: async () => outcome(unverifiable) });
    const result = await runner.run(makeReq({ executionMode: 'pinned', task: makeTask({ attestation: undefined }) }));
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('pinned + a composer-declared modality the request did not run under: corroborated (c)', async () => {
    const { runner } = makeRunner({ query: async () => outcome(unverifiable) });
    const result = await runner.run(
      makeReq({ executionMode: 'pinned', modality: 'web', task: makeTask({ attestation: undefined, modality: 'native-screen' }) }),
    );
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('declared modality "native-screen"');
  });

  it.each(['explore', 'legacy'] as const)('%s: low_confidence without spending a probe', async (executionMode) => {
    const { runner, attest } = makeRunner({ query: async () => outcome(unverifiable) });
    const result = await runner.run(makeReq({ executionMode }));
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toBe('unverifiable: needs a paired Apple Watch');
  });

  it('wrong_environment reaches the engine as a redispatch, unprobed and never passed', async () => {
    const { runner, attest } = makeRunner({
      query: async () =>
        outcome(
          validReport({ outcome: 'wrong_environment', neededModality: 'mobile', app: APP, diagnosis: 'an iOS app', behaviors: [] }),
        ),
    });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('low_confidence');
    expect(result.redispatch).toEqual({ modality: 'mobile', app: APP, diagnosis: 'an iOS app' });
  });
});

describe('VerificationAgentRunner.run — A4 re-applied after drive coercion', () => {
  const driveTask = makeTask({
    app: APP,
    attestation: { kind: 'bundle-identity', bundleId: APP.bundleId },
    behaviors: [{ id: 'b1', description: 'tap Save', expected: 'the list updates', requiresDrive: true }],
  });
  const failOnDrive = validReport({ outcome: 'fail', behaviors: [failedB1], feedback: 'Save did nothing' });

  it('observe-only mobile: the struck drive claim leaves nothing failing — unverifiable, corroborated (b), advisory even pinned', async () => {
    const { runner } = makeRunner({
      mobile: mobileDeps({ maestro: false }),
      attest: bundleVerified,
      query: async () => outcome(failOnDrive),
    });
    const result = await runner.run(makeMobileReq({ executionMode: 'pinned', task: driveTask }));
    expect(result.report?.outcome).toBe('unverifiable');
    expect(result.report?.diagnosis).toContain(UNVERIFIABLE_COERCION_NOTE);
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('drive rung is none');
  });

  it('with a drive rung nothing is coerced, so the judged fail stands', async () => {
    const { runner } = makeRunner({
      mobile: mobileDeps({ maestro: true }),
      attest: bundleVerified,
      query: async () => outcome(failOnDrive),
    });
    const result = await runner.run(makeMobileReq({ executionMode: 'pinned', task: driveTask }));
    expect(result.report?.outcome).toBe('fail');
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// run() — §A4 (b) on the harness facts, end to end
// ---------------------------------------------------------------------------

describe('VerificationAgentRunner.run — an honest unverifiable on an undrivable surface (§A4 b)', () => {
  const driveTask = makeTask({
    attestation: undefined,
    behaviors: [{ id: 'b1', description: 'click the button', expected: 'it toggles', requiresDrive: true }],
  });

  it('pinned native-screen: the agent that marked the drive behavior not_testable itself lands advisory, not blocking', async () => {
    const honest = validReport({
      outcome: 'unverifiable',
      diagnosis: 'the toggle needs a click and native-screen cannot drive',
      behaviors: [untestableB1],
    });
    const { runner } = makeRunner({ query: async () => outcome(honest) });
    const result = await runner.run(makeReq({ executionMode: 'pinned', modality: 'native-screen', task: driveTask }));
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('"native-screen" surface cannot be driven');
    expect(result.errorMessage).not.toContain(UNVERIFIABLE_UNCORROBORATED_MESSAGE);
  });

  it('pinned native-screen with NO drive-required behavior stays uncorroborated — blocking', async () => {
    const r = validReport({ outcome: 'unverifiable', diagnosis: 'x', behaviors: [untestableB1] });
    const { runner } = makeRunner({ query: async () => outcome(r) });
    const result = await runner.run(
      makeReq({ executionMode: 'pinned', modality: 'native-screen', task: makeTask({ attestation: undefined }) }),
    );
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain(UNVERIFIABLE_UNCORROBORATED_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// run() — a pinned wrong_environment is not a way around §A4
// ---------------------------------------------------------------------------

describe('VerificationAgentRunner.run — wrong_environment the engine could never re-dispatch', () => {
  const wrongEnv = validReport({
    outcome: 'wrong_environment',
    neededModality: 'mobile',
    app: APP,
    diagnosis: 'an iOS app',
    behaviors: [untestableB1],
  });

  it('pinned: no redispatch; a declared, VERIFIED channel is corroboration (a) — the floor ran for it', async () => {
    const { runner, attest } = makeRunner({ query: async () => outcome(wrongEnv) });
    const result = await runner.run(makeReq({ executionMode: 'pinned' }));
    expect(attest).toHaveBeenCalledTimes(1);
    expect(result.redispatch).toBeUndefined();
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('the harness attested the stood-up surface');
  });

  it('pinned + an unverified channel: no redispatch, a blocking failed', async () => {
    const { runner } = makeRunner({
      query: async () => outcome(wrongEnv),
      attest: async () => ({ verified: false, kind: 'http-endpoint', detail: 'no nonce' }),
    });
    const result = await runner.run(makeReq({ executionMode: 'pinned' }));
    expect(result.redispatch).toBeUndefined();
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain(UNVERIFIABLE_UNCORROBORATED_MESSAGE);
  });

  it('explore keeps the re-dispatch channel', async () => {
    const { runner } = makeRunner({ query: async () => outcome(wrongEnv) });
    const result = await runner.run(makeReq({ executionMode: 'explore' }));
    expect(result.redispatch).toEqual({ modality: 'mobile', app: APP, diagnosis: 'an iOS app' });
  });
});

describe('VerificationAgentRunner.run — explore web with NO declared channel (serve-binding)', () => {
  const noChannel = (overrides: Partial<VerificationTaskV1> = {}) =>
    makeTask({ attestation: undefined, serve: { cmd: SERVE_CMD }, ...overrides });

  it('a bound composed serve lets an explore pass reach passed, without probing any channel', async () => {
    const { runner, attest } = makeRunner(servedBy(SERVE_CMD));
    const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannel() }));
    expect(attest).not.toHaveBeenCalled();
    expect(result.status).toBe('passed');
  });

  it('a FOREIGN listener on the port fails the explore pass', async () => {
    const { runner } = makeRunner(foreignListener);
    const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannel() }));
    expect(result.status).toBe('failed');
    expect(result.foreignSurface).toBe(true);
  });

  it('an unbound serve (nothing recorded) stays capped at low_confidence', async () => {
    const { runner } = makeRunner();
    const result = await runner.run(makeReq({ executionMode: 'explore', task: noChannel() }));
    expect(result.status).toBe('low_confidence');
  });

  it('a task that composed no serve.cmd stays capped at low_confidence', async () => {
    const { runner } = makeRunner(servedBy(SERVE_CMD));
    const result = await runner.run(
      makeReq({ executionMode: 'explore', task: makeTask({ attestation: undefined, target: { url: 'http://127.0.0.1:1/' } }) }),
    );
    expect(result.status).toBe('low_confidence');
  });

  it('pinned keeps the old rule: no declared channel caps even with a bound serve', async () => {
    const { runner } = makeRunner(servedBy(SERVE_CMD));
    const result = await runner.run(makeReq({ executionMode: 'pinned', task: noChannel() }));
    expect(result.status).toBe('low_confidence');
  });
});
