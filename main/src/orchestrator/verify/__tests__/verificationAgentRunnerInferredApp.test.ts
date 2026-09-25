/**
 * VerificationAgentRunner — §A2's runner rule
 * (docs/proposals/runbook-optional-verification.md §A2): on an INFERRED `app`
 * block, a bundle-id mismatch at `mobile-install`, an unknown scheme, or a
 * build that needs a forbidden dependency step is `unverifiable`, never
 * `build_failed`. Every other stand-up failure keeps its classification.
 *
 * Same fake-seam posture as verificationAgentRunnerExplore.test.ts (no SDK, no
 * process, no socket); the harness below is a trimmed copy of that suite's.
 */
import { describe, expect, it, vi } from 'vitest';
import { delimiter } from 'node:path';
import {
  VerificationAgentRunner,
  mapReportToResult,
  reclassifyInferredAppFailure,
  type VerificationAgentQueryOutcome,
  type VerificationAgentRequest,
  type VerificationAgentRunnerDeps,
  type VerificationAgentRunnerMobileDeps,
} from '../verificationAgentRunner';
import type { HarnessAttestationResult } from '../harnessAttestation';
import type { MobileSimulatorHandle } from '../mobileSimulatorSession';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type { VerificationReportV1, VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

const APP = { platform: 'ios-simulator' as const, bundleId: 'com.example.distractodo', scheme: 'Distractodo' };
const MISMATCH =
  'bundle id mismatch: /data/DerivedData/Build/Products/Debug-iphonesimulator/Distractodo.app declares CFBundleIdentifier "com.example.Distractodo" but this request\'s VERIFY_APP_BUNDLE_ID is "com.example.distractodo"';
const UNKNOWN_SCHEME = 'xcodebuild: error: The project named "Distractodo" does not contain a scheme named "Distractodo".';
const DEP_DENY = 'Blocked: `pod install` mutates dependencies. Dependency install/rebuild is forbidden inside verification snapshots';
const COMPILE_BREAK = "ContentView.swift:12:5: error: cannot find 'TodoRow' in scope";

function report(overrides: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'not_testable', evidence: { screenshots: [], notes: 'never launched' } }],
    screenshots: [],
    outcome: 'build_failed',
    buildLogExcerpt: MISMATCH,
    confidence: 0.9,
    feedback: 'the build did not produce an installable product',
    issues: [],
    ...overrides,
  };
}

describe('reclassifyInferredAppFailure', () => {
  const inferred = { appInferred: true, modality: 'mobile' as const };

  it.each([
    ['a bundle-id mismatch at mobile-install', { buildLogExcerpt: MISMATCH }],
    ['an unknown scheme', { buildLogExcerpt: UNKNOWN_SCHEME }],
    ['a forbidden dependency step', { buildLogExcerpt: 'build needs pods', feedback: DEP_DENY }],
    ['a forbidden dependency step', { buildLogExcerpt: 'the Podfile is not installed; `pod install` is required' }],
  ])('turns a build_failed naming %s into unverifiable, with the agent text kept', (reason, fields) => {
    const out = reclassifyInferredAppFailure(report(fields), inferred);
    expect(out.reason).toBe(reason);
    expect(out.report.outcome).toBe('unverifiable');
    expect(out.report.diagnosis).toContain('INFERRED');
    expect(out.report.diagnosis).toContain(fields.buildLogExcerpt);
  });

  it('applies to launch_failed too', () => {
    const out = reclassifyInferredAppFailure(report({ outcome: 'launch_failed' }), inferred);
    expect(out.report.outcome).toBe('unverifiable');
  });

  it('a real defect (a compile break) on an inferred block KEEPS build_failed', () => {
    const r = report({ buildLogExcerpt: COMPILE_BREAK });
    expect(reclassifyInferredAppFailure(r, inferred)).toEqual({ report: r, reason: null });
  });

  it('never fires on a composed or runbook-supplied block, off mobile, or on another outcome', () => {
    const r = report();
    expect(reclassifyInferredAppFailure(r, { appInferred: false, modality: 'mobile' }).report).toBe(r);
    expect(reclassifyInferredAppFailure(r, { appInferred: true, modality: 'web' }).report).toBe(r);
    const failed = report({ outcome: 'fail', behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: MISMATCH } }] });
    expect(reclassifyInferredAppFailure(failed, inferred).report).toBe(failed);
  });

  it('the rewritten report maps to an advisory low_confidence in explore (no loopback)', () => {
    const out = reclassifyInferredAppFailure(report(), inferred);
    const mapped = mapReportToResult(out.report, {
      provisionMode: 'snapshot',
      mutated: false,
      model: 'm',
      executionMode: 'explore',
      modality: 'mobile',
      floor: null,
      corroboration: [],
    });
    expect(mapped.status).toBe('low_confidence');
    expect(mapped.errorMessage).toContain('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// End to end through run(): the flag on the request is what decides.
// ---------------------------------------------------------------------------

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

function outcome(structured: unknown): VerificationAgentQueryOutcome {
  return { structured, transcript: null };
}

function mobileDeps(): VerificationAgentRunnerMobileDeps {
  const handle: MobileSimulatorHandle = {
    udid: 'B1C0FFEE-0000-4000-8000-0123456789AB',
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
      resolveMaestroBin: async () => '/Users/dev/.maestro/bin/maestro',
      resolvePinFlag: async () => '--udid',
      healthCheck: async () => true,
    },
    dataDir: '/data',
  };
}

function makeRunner(structured: VerificationReportV1): VerificationAgentRunner {
  const deps: VerificationAgentRunnerDeps = {
    query: vi.fn(async () => outcome(structured)),
    codexQuery: vi.fn(async () => outcome(structured)),
    resolveVerifyAgent: () => ({ agent: makeAgent(), runProvider: 'claude', runModel: 'claude-sonnet-5' }),
    resolveClaudeAlias: (alias) => `claude-${alias}-resolved`,
    claudeDefaultModel: 'claude-opus-4-8',
    resolveNode: async () => '/usr/bin/node',
    driverCliPath: '/app/driverCli.js',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    provision: async () => ({ worktreePath: '/snap', sha: 'abc123', dispose: async () => {} }),
    checkSnapshotMutated: async () => false,
    fileExists: async () => true,
    resolveChromium: async () => '/opt/chromium',
    portFreeProbe: async () => true,
    writeDriverScript: async () => '/artifacts/.driver/verify-driver.sh',
    stopDriver: async () => {},
    reapBrowser: () => {},
    reapServe: () => {},
    writeTranscript: async () => {},
    attest: async (): Promise<HarnessAttestationResult> => ({ verified: false, kind: 'bundle-identity', detail: 'never installed' }),
    readServePid: async () => null,
    listeningPidForPort: async () => null,
    processInfo: async () => null,
    resolveShellPath: async () => ['/usr/bin', '/bin'].join(delimiter),
    resolveNodeModulesRoot: async () => null,
    prepareDataDir: async () => {},
    materializeDependencyGuardShim: async () => ({ binDir: null }),
    mobile: mobileDeps(),
  };
  return new VerificationAgentRunner(deps);
}

function mobileReq(overrides: Partial<VerificationAgentRequest> = {}): VerificationAgentRequest {
  const task: VerificationTaskV1 = {
    version: 1,
    summary: 'the todo list renders',
    app: APP,
    attestation: { kind: 'bundle-identity', bundleId: APP.bundleId },
    behaviors: [{ id: 'b1', description: 'renders', expected: 'the list is visible' }],
  };
  return {
    runId: 'run-1',
    requestId: 'vr-inferred-1',
    projectId: 1,
    task,
    runWorktreePath: '/live/worktree',
    snapshotSha: 'abc123',
    artifactsDir: '/artifacts',
    verifyPort: null,
    verifyDriverPort: null,
    modality: 'mobile',
    executionMode: 'explore',
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('VerificationAgentRunner.run — an inferred app block (§A2)', () => {
  it('a bundle-id mismatch on an INFERRED block is advisory low_confidence, not a blocking build_failed', async () => {
    const result = await makeRunner(report()).run(mobileReq({ appInferred: true }));
    expect(result.status).toBe('low_confidence');
    expect(result.report?.outcome).toBe('unverifiable');
    expect(result.errorMessage).toContain('INFERRED');
  });

  it('the SAME report on a composed block stays a blocking build_failed', async () => {
    const result = await makeRunner(report()).run(mobileReq());
    expect(result.status).toBe('failed');
    expect(result.report?.outcome).toBe('build_failed');
    expect(result.errorMessage).toBe(MISMATCH);
  });

  it('a compile break on an inferred block is still a blocking build_failed', async () => {
    const result = await makeRunner(report({ buildLogExcerpt: COMPILE_BREAK })).run(mobileReq({ appInferred: true }));
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe(COMPILE_BREAK);
  });
});
