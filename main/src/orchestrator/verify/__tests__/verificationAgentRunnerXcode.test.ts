/**
 * VerificationAgentRunner — the Stage 3 xcode drive rung in the mobile arm
 * (docs/proposals/runbook-optional-verification.md §B3, §B4, §B5, §B6, §B7):
 *
 *  - engine selection + degrade provenance on the report;
 *  - coercion keyed strictly on the EXPORTED rung: xcode does NOT coerce a
 *    `requiresDrive` claim, a rung degraded to none does;
 *  - `minRuntimeMajor: 27` reaches `acquire` only when xcode is intended;
 *  - the §B4.8 teardown: the session closes BEFORE the simulator is disposed,
 *    EndSession still goes out after the runner's controller has aborted, and
 *    a throwing step never skips the rest;
 *  - the §B5 pass-evidence cap;
 *  - B6: Maestro's JAVA_HOME reaches the agent's env, its bin first on PATH.
 *
 * Same fake-seam posture as verificationAgentRunnerInferredApp.test.ts, with a
 * REAL tmp artifacts dir (the runner re-reads cited screenshots from it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  VerificationAgentRunner,
  type VerificationAgentQueryArgs,
  type VerificationAgentQueryOutcome,
  type VerificationAgentRequest,
  type VerificationAgentRunnerDeps,
  type VerificationAgentRunnerMobileDeps,
} from '../verificationAgentRunner';
import type { HarnessAttestationResult } from '../harnessAttestation';
import type { AcquireSimulatorArgs, MobileSimulatorHandle } from '../mobileSimulatorSession';
import { MIN_RUNTIME_UNSATISFIED_PREFIX } from '../mobileSimulatorSession';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type {
  MobileDriveEngine,
  VerificationReportV1,
  VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';
import type { XcodeProbeSummary } from '../xcode/driveEngineSelection';
import {
  openXcodeDriveSession,
  type OpenXcodeDriveSessionOptions,
  type OpenXcodeDriveSessionResult,
  type XcodeDriveSession,
} from '../xcode/xcodeDriveSession';
import { createCaptureLedger, recordLedgerCapture, recordLedgerLaunch } from '../xcode/xcodeDriveSocketServer';
import { XCODE_LEDGER_CAP_MESSAGE } from '../xcode/xcodePassEvidence';
import { createXcodeMcpBridgeClient } from '../xcode/xcodeMcpBridgeClient';
import { END_OK, FakeBridge, START_OK, type ToolScript } from '../xcode/__tests__/fakeMcpBridge';

const UDID = 'D473B910-328C-443D-93D8-B241052F57CD';
const BUNDLE = 'com.acme.ios';
const APP = { platform: 'ios-simulator' as const, bundleId: BUNDLE, scheme: 'Acme' };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

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

function passReport(screenshot: string): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [
      { id: 'b1', result: 'pass', evidence: { screenshots: [screenshot], notes: 'the list is visible' } },
      { id: 'b2', result: 'pass', evidence: { screenshots: [screenshot], notes: 'tapped Add; the sheet opened' } },
    ],
    screenshots: [{ fileName: screenshot, caption: 'home' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'all good',
    issues: [],
  };
}

function task(): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'the todo list renders and Add opens a sheet',
    app: APP,
    attestation: { kind: 'bundle-identity', bundleId: BUNDLE },
    behaviors: [
      { id: 'b1', description: 'renders', expected: 'the list is visible' },
      { id: 'b2', description: 'tap Add', expected: 'a sheet opens', requiresDrive: true },
    ],
  };
}

interface Harness {
  runner: VerificationAgentRunner;
  order: string[];
  acquireArgs: AcquireSimulatorArgs[];
  seenEnv: () => Record<string, string>;
  artifactsDir: string;
}

interface HarnessOptions {
  engine?: MobileDriveEngine;
  probe?: XcodeProbeSummary | null;
  openSession?: (options: OpenXcodeDriveSessionOptions) => Promise<OpenXcodeDriveSessionResult>;
  maestro?: boolean;
  javaHome?: string | null;
  acquire?: (args: AcquireSimulatorArgs) => Promise<MobileSimulatorHandle>;
  /** Shared event log (the fake session's close writes into it too). */
  order?: string[];
  /** The agent: runs with the env, may write artifacts, returns a report (or throws). */
  agent: (args: VerificationAgentQueryArgs, artifactsDir: string) => Promise<VerificationReportV1>;
}

function makeHarness(opts: HarnessOptions): Harness {
  const order: string[] = opts.order ?? [];
  const acquireArgs: AcquireSimulatorArgs[] = [];
  const artifactsDir = tmp('cf-xrun-art-');
  let env: Record<string, string> = {};
  const handle: MobileSimulatorHandle = {
    udid: UDID,
    name: 'cyboflow-verify-vr-x',
    runtimeName: 'iOS 27.0',
    runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    derivedDataDir: '/data/verify-mobile/vr-x/DerivedData',
    requestDir: '/data/verify-mobile/vr-x',
    recordXcodeSessionKey: async () => {
      order.push('record-key');
    },
    dispose: async () => {
      order.push('dispose');
    },
  };
  const mobile: VerificationAgentRunnerMobileDeps = {
    session: {
      acquire: async (args) => {
        acquireArgs.push(args);
        return opts.acquire ? opts.acquire(args) : handle;
      },
      sweepStaleSimulators: async () => ({ deleted: [], skipped: [] }),
    },
    toolchain: {
      resolveMaestroBin: async () => (opts.maestro === true ? '/Users/dev/.maestro/bin/maestro' : null),
      resolvePinFlag: async () => '--udid',
      healthCheck: async () => true,
      resolveJavaHome: async () => opts.javaHome ?? null,
    },
    dataDir: tmp('cf-xrun-data-'),
    driveEngine: () => opts.engine ?? 'auto',
    ...(opts.probe === null
      ? {}
      : {
          xcode: {
            probe: async () => opts.probe ?? { outcome: 'available', approval: 'approved', detail: 'ready' },
            ...(opts.openSession !== undefined ? { openSession: opts.openSession } : {}),
          },
        }),
  };
  const run = async (args: VerificationAgentQueryArgs): Promise<VerificationAgentQueryOutcome> => {
    env = args.env;
    return { structured: await opts.agent(args, artifactsDir), transcript: null };
  };
  const deps: VerificationAgentRunnerDeps = {
    query: vi.fn(run),
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
    attest: async (): Promise<HarnessAttestationResult> => ({
      verified: true,
      kind: 'bundle-identity',
      detail: 'installed executable matches the staged product',
    }),
    readServePid: async () => null,
    listeningPidForPort: async () => null,
    processInfo: async () => null,
    resolveShellPath: async () => ['/usr/bin', '/bin'].join(delimiter),
    resolveNodeModulesRoot: async () => null,
    prepareDataDir: async () => {},
    materializeDependencyGuardShim: async () => ({ binDir: null }),
    mobile,
  };
  return { runner: new VerificationAgentRunner(deps), order, acquireArgs, seenEnv: () => env, artifactsDir };
}

function req(artifactsDir: string, overrides: Partial<VerificationAgentRequest> = {}): VerificationAgentRequest {
  return {
    runId: 'run-x',
    requestId: 'vr-x',
    projectId: 1,
    task: task(),
    runWorktreePath: '/live/worktree',
    snapshotSha: 'abc123',
    artifactsDir,
    verifyPort: null,
    verifyDriverPort: null,
    modality: 'mobile',
    executionMode: 'pinned',
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A fake live session whose ledger the test controls. */
function fakeSession(order: string[], build: (ledger: ReturnType<typeof createCaptureLedger>) => void): {
  open: (options: OpenXcodeDriveSessionOptions) => Promise<OpenXcodeDriveSessionResult>;
  close: ReturnType<typeof vi.fn>;
} {
  const ledger = createCaptureLedger(BUNDLE);
  build(ledger);
  const close = vi.fn(async () => {
    order.push('xcode-close');
    return [];
  });
  const session: XcodeDriveSession = {
    env: {
      VERIFY_MOBILE_DRIVE: 'xcode',
      VERIFY_XCODE_DRIVE_SOCKET: '/data/sockets/xd-0000000000000000.sock',
      VERIFY_XCODE_DRIVE_TOKEN: 't'.repeat(64),
    },
    ledger,
    keyFingerprint: 'abc',
    close,
  };
  return {
    open: async (options) => {
      await options.recordSessionKey('Cyboflow Verify k');
      return { ok: true, session };
    },
    close,
  };
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('the xcode rung, end to end through run()', () => {
  it('exports the xcode env, does NOT coerce a requiresDrive pass, records provenance, and passes on ledger-backed evidence', async () => {
    const order: string[] = [];
    const fake = fakeSession(order, (ledger) => {
      recordLedgerLaunch(ledger, 4321);
      recordLedgerCapture(ledger, {
        name: 'home.png',
        verb: 'mobile-capture',
        sha256: sha('home-bytes'),
        file: 'home.png',
        applicationState: 'NotRun',
        foregroundBundleId: BUNDLE,
        pid: 4321,
        activated: false,
      });
    });
    const h = makeHarness({
      order,
      openSession: fake.open,
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'home-bytes');
        return passReport('home.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir));
    expect(h.seenEnv().VERIFY_MOBILE_DRIVE).toBe('xcode');
    expect(h.seenEnv().VERIFY_XCODE_DRIVE_SOCKET).toBe('/data/sockets/xd-0000000000000000.sock');
    expect(h.seenEnv().VERIFY_MAESTRO_BIN).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(result.report?.behaviors.find((b) => b.id === 'b2')?.result).toBe('pass');
    expect(result.report?.provenance).toMatchObject({
      driveEngineRequested: 'auto',
      driveEngineUsed: 'xcode',
      captureLedger: { appBundleId: BUNDLE },
    });
    expect(result.report?.provenance?.degradeReason).toBeUndefined();
    expect(result.preflight?.checks.find((c) => c.id === 'xcode-mcp')).toMatchObject({ ok: true });
    expect(h.acquireArgs[0]?.minRuntimeMajor).toBe(27);
    // §B4.8: the session closes BEFORE the device is disposed.
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(h.order.filter((e) => e === 'xcode-close' || e === 'dispose')).toEqual(['xcode-close', 'dispose']);
  });

  it('§B5: a pass whose screenshot is NOT a ledger capture is capped at low_confidence, with the reason', async () => {
    const order: string[] = [];
    const fake = fakeSession(order, (ledger) => {
      recordLedgerLaunch(ledger, 4321);
    });
    const h = makeHarness({
      openSession: fake.open,
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'forged.png'), 'agent-made');
        return passReport('forged.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir));
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain(XCODE_LEDGER_CAP_MESSAGE);
    expect(result.errorMessage).toContain('behavior b1');
  });

  it('a degraded rung (StartSession unapproved, no Maestro) exports none, COERCES the drive claim, and says why', async () => {
    const h = makeHarness({
      openSession: async () => ({ ok: false, degradeReason: 'xcode-approval-missing', detail: "isn't approved" }),
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir));
    expect(h.seenEnv().VERIFY_MOBILE_DRIVE).toBe('none');
    expect(h.seenEnv().VERIFY_XCODE_DRIVE_SOCKET).toBeUndefined();
    expect(result.report?.behaviors.find((b) => b.id === 'b2')?.result).toBe('not_testable');
    expect(result.report?.provenance).toMatchObject({
      driveEngineRequested: 'auto',
      driveEngineUsed: 'none',
      degradeReason: 'xcode-approval-missing',
    });
    expect(result.status).toBe('low_confidence');
  });

  it('a probe that says approval-required never opens a session and never floors the runtime', async () => {
    const open = vi.fn();
    const h = makeHarness({
      probe: { outcome: 'approval-required', approval: 'expired', detail: 'grant expired' },
      openSession: open,
      maestro: true,
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir));
    expect(open).not.toHaveBeenCalled();
    expect(h.acquireArgs[0]?.minRuntimeMajor).toBeUndefined();
    expect(h.seenEnv().VERIFY_MOBILE_DRIVE).toBe('maestro');
    expect(result.report?.provenance).toMatchObject({ driveEngineUsed: 'maestro', degradeReason: 'xcode-approval-expired' });
  });

  it('a host with no iOS 27 runtime re-acquires without the floor and degrades xcode-unavailable', async () => {
    const open = vi.fn();
    const h = makeHarness({
      openSession: open,
      acquire: async (args) => {
        if (args.minRuntimeMajor !== undefined) throw new Error(`${MIN_RUNTIME_UNSATISFIED_PREFIX} 27`);
        return {
          udid: UDID,
          name: 'n',
          runtimeName: 'iOS 26.2',
          runtimeId: 'r',
          deviceTypeId: 'd',
          derivedDataDir: '/dd',
          requestDir: '/rd',
          recordXcodeSessionKey: async () => {},
          dispose: async () => {},
        };
      },
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir));
    expect(h.acquireArgs.map((a) => a.minRuntimeMajor)).toEqual([27, undefined]);
    expect(open).not.toHaveBeenCalled();
    expect(result.report?.provenance?.degradeReason).toBe('xcode-unavailable');
  });

  it('requested none never probes, never opens, and exports none', async () => {
    const open = vi.fn();
    const h = makeHarness({
      engine: 'none',
      openSession: open,
      maestro: true,
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir));
    expect(open).not.toHaveBeenCalled();
    expect(h.seenEnv().VERIFY_MOBILE_DRIVE).toBe('none');
    expect(result.report?.provenance).toMatchObject({ driveEngineRequested: 'none', driveEngineUsed: 'none' });
    expect(result.report?.provenance?.degradeReason).toBeUndefined();
  });

  it('X-3: the engine the scheduler leased with wins over a different live knob', async () => {
    // The live knob now says xcode, but the scheduler resolved maestro for this
    // row and took no `verify:xcode` lease — the runner must not open a session.
    const open = vi.fn();
    const h = makeHarness({
      engine: 'xcode',
      openSession: open,
      maestro: true,
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir, { mobileDriveEngine: 'maestro' }));
    expect(open).not.toHaveBeenCalled();
    expect(h.acquireArgs[0]).not.toHaveProperty('minRuntimeMajor');
    expect(h.seenEnv().VERIFY_MOBILE_DRIVE).toBe('maestro');
    expect(result.report?.provenance).toMatchObject({ driveEngineRequested: 'maestro', driveEngineUsed: 'maestro' });
  });

  it('B6: the Maestro rung exports JAVA_HOME and puts its bin first on the agent PATH', async () => {
    const h = makeHarness({
      engine: 'maestro',
      maestro: true,
      javaHome: '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    await h.runner.run(req(h.artifactsDir));
    const env = h.seenEnv();
    expect(env.JAVA_HOME).toBe('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home');
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') as string;
    expect(env[pathKey]?.split(delimiter)[0]).toBe('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin');
  });
});

describe('§B4.8 teardown through run()', () => {
  it('an agent that throws still closes the session and disposes the simulator', async () => {
    const order: string[] = [];
    const fake = fakeSession(order, () => {});
    const h = makeHarness({
      openSession: fake.open,
      agent: async () => {
        throw new Error('the SDK blew up');
      },
    });
    await h.runner.run(req(h.artifactsDir));
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(h.order).toContain('dispose');
  });

  it('X-1: an agent query that IGNORES the abort still lets run() reach its finally and tear down', async () => {
    const order: string[] = [];
    const fake = fakeSession(order, () => {});
    const controller = new AbortController();
    const h = makeHarness({
      order,
      openSession: fake.open,
      agent: () => {
        // The deadline fires mid-session, and the query never notices.
        setTimeout(() => controller.abort(), 5);
        return new Promise<VerificationReportV1>(() => {});
      },
    });
    const result = await h.runner.run(req(h.artifactsDir, { signal: controller.signal }));
    expect(result.status).toBe('timeout');
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(order.indexOf('xcode-close')).toBeLessThan(order.indexOf('dispose'));
  });

  it('a close() that violates its never-throw contract cannot skip the simulator dispose', async () => {
    const h = makeHarness({
      openSession: async (options) => {
        await options.recordSessionKey('k');
        return {
          ok: true,
          session: {
            env: { VERIFY_MOBILE_DRIVE: 'xcode' },
            ledger: createCaptureLedger(BUNDLE),
            keyFingerprint: 'k',
            close: async () => {
              throw new Error('boom');
            },
          },
        };
      },
      agent: async (_args, dir) => {
        writeFileSync(join(dir, 'home.png'), 'x');
        return passReport('home.png');
      },
    });
    await h.runner.run(req(h.artifactsDir));
    expect(h.order).toContain('dispose');
  });

  it('with the REAL session over a fake bridge: EndSession still goes out after the deadline aborted the run', async () => {
    const calls: string[] = [];
    const bridge = new FakeBridge({
      tools: {
        DeviceInteractionStartSession: (args) => {
          calls.push('start');
          return (START_OK as ToolScript)({ ...args });
        },
        DeviceInteractionEndSession: (args) => {
          calls.push('end');
          return END_OK(args);
        },
      },
    });
    const controller = new AbortController();
    const h = makeHarness({
      openSession: (options) =>
        openXcodeDriveSession({
          ...options,
          createClient: (o) => createXcodeMcpBridgeClient({ ...o, spawn: () => bridge, killGraceMs: 40 }),
        }),
      agent: async (args) => {
        // The deadline fires mid-session: the runner's controller aborts.
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(args.signal?.aborted).toBe(true);
        throw new Error('aborted');
      },
    });
    const result = await h.runner.run(req(h.artifactsDir, { signal: controller.signal }));
    expect(result.status).toBe('timeout');
    expect(calls).toEqual(['start', 'end']);
    expect(bridge.signals).toContain('SIGTERM');
    expect(h.order.indexOf('dispose')).toBeGreaterThan(-1);
  });
});
