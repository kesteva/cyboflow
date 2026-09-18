/**
 * T14 — the `mobile` verification tier end-to-end over a FAKE APPLE TOOLCHAIN
 * (docs/proposals/mobile-verification-tier.md §5.1.1, §5.5, §8, §8.2, §9, §10).
 *
 * WHAT IS REAL HERE, AND WHY THAT IS THE POINT. The unit suites fake the
 * simulator session, the toolchain probe and the attestation thunk, so each one
 * proves its own module in isolation and NONE of them proves the seams between
 * them. This test fakes exactly one thing — the four binaries
 * (`xcrun`/`xcodebuild`/`maestro`/`plutil`) — and runs everything else for real:
 *
 *   - `composeMobileVerification` builds the session factory over the real
 *     `execFile` transport (`createHostAppleCliExec`);
 *   - `mobileSimulatorSession.acquire` really creates, boots and tears down a
 *     (fake) device, writes a real `owner.json`, and makes a real DerivedData dir;
 *   - `VerificationAgentRunner.run` really runs preflight, provisioning, the env
 *     build, the drive-rung probe, the coercion pass and teardown;
 *   - the "agent" is a fake SDK session that drives the REAL driver CLI
 *     (`runDriverCommand` + `createDefaultDriverDeps`) — real globbing, real
 *     `Info.plist` reading, real sha256 on both sides of the install, the real
 *     pixel-based readiness loop;
 *   - the attestation is the REAL `performHarnessAttestation` (`attest` is left
 *     unset), which re-hashes the executable it finds in the device container.
 *
 * So a shape mismatch anywhere on that chain — an argv the session builds that
 * the driver's model of `simctl` does not match, a glob that does not resolve, a
 * record the attestation cannot read — fails here rather than on a developer's
 * Mac ten minutes into a real verification.
 *
 * WHY THE SHIMS ARE SHELL SCRIPTS ON `PATH` rather than injected fakes: the
 * driver CLI resolves its tools by NAME through `child_process.spawn`, which
 * inherits `process.env`. There is no injection point there by design (the CLI
 * is a standalone bundle), so the only honest way to exercise it is to put a
 * different `xcrun` in front of it.
 *
 * PLATFORM: `darwin` is passed EXPLICITLY into every composition, so the suite
 * is meaningful on a Linux CI box too (the `plutil` shim is what makes that
 * true — Linux has no plutil). Only Windows is skipped: the shims are `#!/bin/sh`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  composeMobileVerification,
  createHostAppleCliExec,
} from '../../../services/visualVerify/mobileComposition';
import { XcodeToolchainBackend } from '../../../services/visualVerify/xcodeToolchainBackend';
import {
  VerificationAgentRunner,
  type ResolvedVerifyAgent,
  type VerificationAgentQueryArgs,
  type VerificationAgentQueryOutcome,
  type VerificationAgentRequest,
  type VerificationAgentRunnerDeps,
  type VerificationAgentRunResult,
} from '../../verify/verificationAgentRunner';
import { classifyVerificationFailure } from '../../verify/failureClassifier';
import { mobileToolchainDetail } from '../../verify/mobileGates';
import {
  MOBILE_EXIT_OK,
  MOBILE_EXIT_REFUSED,
  MOBILE_EXIT_READINESS_TIMEOUT,
  MOBILE_INSTALL_RECORD_NAME,
  READINESS_LAST_FRAME_NAME,
  type MobileInstallRecord,
} from '../../verify/driver/mobileCommands';
import {
  createDefaultDriverDeps,
  runDriverCommand,
  type DriverDeps,
} from '../../verify/driver/driverCore';
import { VERIFY_MOBILE_DIRNAME } from '../../verify/mobileSimulatorSession';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type {
  VerificationReportV1,
  VerificationTaskV1,
} from '../../../../../shared/types/visualVerification';
import type { SnapshotProvision } from '../../verify/snapshotProvisioner';

// ---------------------------------------------------------------------------
// Fixture location + fake-toolchain binaries
// ---------------------------------------------------------------------------

const SHIM_NAMES = ['xcrun', 'xcodebuild', 'maestro', 'plutil'] as const;

/**
 * Walk up from the cwd to the fixture dir. vitest may run this file with the
 * repo root OR `main/` as cwd depending on how it was invoked, and this module
 * is transformed to ESM (so `__dirname` is not reliably present) while the
 * package's tsconfig is `module: commonjs` (so `import.meta` will not compile).
 * Walking is the one answer that is right under both.
 */
function locateFixtureDir(): string {
  const tail = join(
    'orchestrator',
    '__tests__',
    'integration',
    'fixtures',
    'fakeAppleToolchain',
  );
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [join(dir, 'src', tail), join(dir, 'main', 'src', tail)]) {
      if (existsSync(join(candidate, 'xcrun'))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not locate the fakeAppleToolchain fixture from ${process.cwd()}`);
    dir = parent;
  }
}

const FIXTURE_DIR = locateFixtureDir();

// ---------------------------------------------------------------------------
// PNG generation — the readiness loop judges PIXELS, so the frames must be real
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * A 1-row, 8-bit, non-interlaced RGBA PNG — exactly the shape `isUniformPng`
 * supports (a simulator screenshot's shape), built by hand so the suite needs no
 * image library and the "is this frame flat?" answer is unambiguous.
 */
function makePng(pixels: ReadonlyArray<readonly [number, number, number, number]>): Buffer {
  const width = pixels.length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const raw = Buffer.alloc(width * 4 + 1);
  let o = 0;
  raw[o++] = 0; // scanline filter: none
  for (const [r, g, b, a] of pixels) {
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A frame with real content: readiness accepts it once two consecutive captures match. */
const PAINTED_FRAME = makePng([
  [0, 0, 0, 255],
  [255, 255, 255, 255],
  [0, 0, 0, 255],
  [255, 255, 255, 255],
]);

/** A flat white frame: stable, byte-identical forever, and NEVER ready (§5.5). */
const BLANK_FRAME = makePng([
  [255, 255, 255, 255],
  [255, 255, 255, 255],
  [255, 255, 255, 255],
  [255, 255, 255, 255],
]);

// ---------------------------------------------------------------------------
// The world one test runs in
// ---------------------------------------------------------------------------

const BUNDLE_ID = 'com.cyboflow.fakeapp';
const REQUEST_ID = 'vr_mobile_itest';
const RUN_ID = 'run-mobile-itest';

interface World {
  root: string;
  /** The cyboflow data dir — `verify-mobile/<requestId>` is created under it. */
  dataDir: string;
  artifactsDir: string;
  snapshotDir: string;
  /** `$HOME` the toolchain backend resolves `~/.maestro/bin/maestro` against. */
  homeDir: string;
  /** `$FAKE_APPLE_STATE` — every shim's state lives here. */
  stateDir: string;
  /** The PATH dir the shims are copied into (arm (b) omits `maestro` from it). */
  binDir: string;
  driverCliPath: string;
}

function makeWorld(opts: { maestro: boolean; failBoot?: boolean; blankFrames?: boolean }): World {
  const root = mkdtempSync(join(tmpdir(), 'cyboflow-mobile-itest-'));
  const world: World = {
    root,
    dataDir: join(root, 'data'),
    artifactsDir: join(root, 'artifacts'),
    snapshotDir: join(root, 'snapshot'),
    homeDir: join(root, 'home'),
    stateDir: join(root, 'fake-apple-state'),
    binDir: join(root, 'bin'),
    driverCliPath: join(root, 'driverCli.js'),
  };
  for (const dir of [world.dataDir, world.artifactsDir, world.snapshotDir, world.homeDir, world.stateDir, world.binDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(world.driverCliPath, '// stub driver CLI — never executed by this suite\n');

  // The PATH copy. `maestro` is omitted for the observe-only arm, so BOTH of the
  // backend's resolution routes (the `~/.maestro` candidate and the `which`
  // fallback) come back empty there — a shim left on PATH would make the
  // "Maestro absent" arm quietly test nothing.
  for (const name of SHIM_NAMES) {
    if (name === 'maestro' && !opts.maestro) continue;
    const dest = join(world.binDir, name);
    copyFileSync(join(FIXTURE_DIR, name), dest);
    chmodSync(dest, 0o755);
  }
  if (opts.maestro) {
    const maestroHome = join(world.homeDir, '.maestro', 'bin');
    mkdirSync(maestroHome, { recursive: true });
    copyFileSync(join(FIXTURE_DIR, 'maestro'), join(maestroHome, 'maestro'));
    chmodSync(join(maestroHome, 'maestro'), 0o755);
  }

  writeFileSync(join(world.stateDir, 'frame.png'), opts.blankFrames ? BLANK_FRAME : PAINTED_FRAME);
  writeFileSync(join(world.stateDir, 'bundle-id'), BUNDLE_ID);
  if (opts.failBoot) writeFileSync(join(world.stateDir, 'fail-boot'), '');
  return world;
}

/** Every `sleep` pid the fake `simctl launch` started, so afterEach can reap them. */
function launchedPids(world: World): number[] {
  const file = join(world.stateDir, 'pids', 'all');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 1);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid that is PROVABLY dead: spawned, waited on, and reaped by this process. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return pid;
}

// ---------------------------------------------------------------------------
// The composed stack
// ---------------------------------------------------------------------------

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * Build the real mobile stack for one world.
 *
 * TWO TOOLCHAIN INSTANCES, deliberately, and this is the one place the suite
 * departs from production wiring. `composeMobileVerification` owns the session
 * factory and the gate-1 probe and is used for both. It does NOT expose
 * `XcodeToolchainBackend`'s `isExecutableFile` seam, though, and the backend's
 * Maestro search includes two HARDCODED absolute paths (`/opt/homebrew/bin`,
 * `/usr/local/bin`) — so on a developer machine that actually has Maestro
 * installed, the composed backend would resolve the REAL binary and the
 * observe-only arm would silently become a drive arm. The runner therefore takes
 * a backend built here with that seam confined to this test's own tmp root,
 * which is exactly what the seam is documented for. The composition is still
 * exercised: its `session` is what acquires the device, its `probe` is what gate
 * 1 is asserted against, and its `sweepAtBoot` is what the §8.2 test drives.
 */
function composeStack(world: World): {
  session: NonNullable<ReturnType<typeof composeMobileVerification>['session']>;
  composition: ReturnType<typeof composeMobileVerification>;
  toolchain: XcodeToolchainBackend;
} {
  const exec = createHostAppleCliExec();
  const composition = composeMobileVerification({
    dataDir: world.dataDir,
    platform: 'darwin',
    exec,
    homeDir: world.homeDir,
    // Pin the composition's own Maestro answer at the fixture copy so its probe
    // never spawns a real Maestro JVM on a host that happens to have one.
    env: { VERIFY_MAESTRO_BIN: join(FIXTURE_DIR, 'maestro') },
    logger,
  });
  const session = composition.session;
  if (session === null) throw new Error('composeMobileVerification returned no session on darwin');

  const toolchain = new XcodeToolchainBackend({
    exec,
    platform: 'darwin',
    homeDir: world.homeDir,
    env: {},
    isExecutableFile: async (absPath) => {
      if (!absPath.startsWith(world.root + sep)) return false;
      try {
        if (!statSync(absPath).isFile()) return false;
        accessSync(absPath, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    logger,
  });
  return { session, composition, toolchain };
}

// ---------------------------------------------------------------------------
// The fake agent session
// ---------------------------------------------------------------------------

/** One driver invocation's result, as the fake agent observes it through Bash. */
interface DriverRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface AgentContext {
  env: Record<string, string>;
  cwd: string;
  /** Run `$VERIFY_DRIVER <argv>` — the REAL CLI logic, in process. */
  driver(argv: string[]): Promise<DriverRun>;
  /** Run `xcodebuild … -derivedDataPath $VERIFY_DERIVED_DATA build` — the agent's build step. */
  build(): Promise<void>;
}

type AgentScript = (ctx: AgentContext) => Promise<VerificationReportV1>;

function runFixtureTool(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The SDK seam: a session that, instead of reasoning, mechanically drives the
 * driver CLI the way the harness contract tells a real agent to — build,
 * `mobile-install`, `mobile-launch`, `mobile-screenshot` — and returns a report.
 */
function makeAgentQuery(
  world: World,
  script: AgentScript,
  seen: { env: Record<string, string> | null; calls: number },
): (args: VerificationAgentQueryArgs) => Promise<VerificationAgentQueryOutcome> {
  return async (args) => {
    seen.env = args.env;
    seen.calls += 1;
    const driverEnv: NodeJS.ProcessEnv = { ...process.env, ...args.env };
    const ctx: AgentContext = {
      env: args.env,
      cwd: args.cwd,
      driver: async (argv) => {
        let stdout = '';
        let stderr = '';
        const deps: DriverDeps = {
          ...createDefaultDriverDeps(),
          cwd: () => args.cwd,
          stdout: (line) => {
            stdout += `${line}\n`;
          },
          stderr: (line) => {
            stderr += `${line}\n`;
          },
        };
        const code = await runDriverCommand(argv, driverEnv, deps);
        return { code, stdout, stderr };
      },
      build: async () => {
        await runFixtureTool(
          join(world.binDir, 'xcodebuild'),
          ['-scheme', 'FakeApp', '-derivedDataPath', args.env.VERIFY_DERIVED_DATA, 'build'],
          driverEnv,
        );
      },
    };
    return { structured: await script(ctx), transcript: 'fake mobile agent session' };
  };
}

// ---------------------------------------------------------------------------
// Task / request / runner
// ---------------------------------------------------------------------------

/**
 * The composed task: an `app` block (so the modality derives to `mobile`), the
 * one channel a mobile request may declare, and TWO behaviors — one observable,
 * one `requiresDrive` (the coercion subject).
 */
function mobileTask(): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'the fake iOS app paints its home screen and opens settings on tap',
    app: { platform: 'ios-simulator', bundleId: BUNDLE_ID, scheme: 'FakeApp' },
    attestation: { kind: 'bundle-identity', bundleId: BUNDLE_ID },
    behaviors: [
      { id: 'b1', description: 'the home screen renders', expected: 'content is visible' },
      {
        id: 'b2',
        description: 'tapping Settings opens the settings screen',
        expected: 'the settings screen is visible',
        requiresDrive: true,
      },
    ],
  };
}

function mobileRequest(world: World): VerificationAgentRequest {
  return {
    runId: RUN_ID,
    requestId: REQUEST_ID,
    projectId: 1,
    task: mobileTask(),
    runWorktreePath: world.snapshotDir,
    snapshotSha: 'deadbeef',
    artifactsDir: world.artifactsDir,
    modality: 'mobile',
    // The scheduler leases a mobile request NEITHER port.
    verifyPort: null,
    verifyDriverPort: null,
    signal: new AbortController().signal,
  };
}

function verifyAgent(): ResolvedVerifyAgent {
  const agent: EffectiveAgent = {
    agentKey: 'visual-verify',
    name: 'cyboflow-visual-verify',
    role: 'verify',
    description: 'the central visual verifier',
    systemPrompt: 'SYSTEM PROMPT BODY',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
  };
  return { agent, runProvider: 'claude', runModel: 'claude-sonnet-5' };
}

interface Harness {
  run(): Promise<VerificationAgentRunResult>;
  seen: { env: Record<string, string> | null; calls: number };
  composition: ReturnType<typeof composeMobileVerification>;
}

function makeHarness(world: World, script: AgentScript, readyTimeoutMs: number): Harness {
  const { session, composition, toolchain } = composeStack(world);
  const seen: { env: Record<string, string> | null; calls: number } = { env: null, calls: 0 };
  const snapshotDispose = vi.fn(async () => {});
  const deps: VerificationAgentRunnerDeps = {
    query: makeAgentQuery(world, script, seen),
    resolveVerifyAgent: () => verifyAgent(),
    resolveClaudeAlias: (alias) => `claude-${alias}`,
    claudeDefaultModel: 'claude-opus-5',
    resolveNode: async () => process.execPath,
    driverCliPath: world.driverCliPath,
    logger,
    provision: async (): Promise<SnapshotProvision> => ({
      worktreePath: world.snapshotDir,
      sha: 'deadbeef',
      dispose: snapshotDispose,
    }),
    // Faked so the suite spawns no git, no login shell, and no driver wrapper.
    checkSnapshotMutated: async () => false,
    resolveShellPath: async () => process.env.PATH ?? '',
    resolveNodeModulesRoot: async () => null,
    writeDriverScript: async () => join(world.artifactsDir, '.driver', 'verify-driver.sh'),
    stopDriver: async () => {},
    reapBrowser: () => {},
    reapServe: () => {},
    // `attest` is DELIBERATELY UNSET: the real performHarnessAttestation runs,
    // shells `xcrun simctl get_app_container` through the shim, and re-hashes
    // the executable it finds in the container.
    mobile: {
      session,
      toolchain,
      dataDir: world.dataDir,
      bootTimeoutMs: 10_000,
      readyTimeoutMs,
    },
  };
  const runner = new VerificationAgentRunner(deps);
  return { run: () => runner.run(mobileRequest(world)), seen, composition };
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function report(
  behaviors: VerificationReportV1['behaviors'],
  screenshots: VerificationReportV1['screenshots'],
): VerificationReportV1 {
  return {
    version: 1,
    behaviors,
    screenshots,
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'the fake app behaved as described',
    issues: [],
  };
}

function readInstallRecord(world: World): MobileInstallRecord {
  const raw = readFileSync(join(world.artifactsDir, MOBILE_INSTALL_RECORD_NAME), 'utf8');
  return JSON.parse(raw) as MobileInstallRecord;
}

function requestDir(world: World): string {
  return join(world.dataDir, VERIFY_MOBILE_DIRNAME, REQUEST_ID);
}

/** Every device the fake `simctl` currently believes exists. */
function deviceDirs(world: World): string[] {
  const root = join(world.stateDir, 'devices');
  return existsSync(root) ? readdirSync(root) : [];
}

// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('mobile verification over a fake Apple toolchain', () => {
  let world: World | null = null;
  let savedPath: string | undefined;
  let savedState: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
    savedState = process.env.FAKE_APPLE_STATE;
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  afterEach(() => {
    if (world) {
      // Reap anything the fake `simctl launch` left behind BEFORE the tmp tree
      // goes, so a failed assertion cannot leak a 10-minute `sleep`.
      for (const pid of launchedPids(world)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone — the normal path, since teardown kills it */
        }
      }
      rmSync(world.root, { recursive: true, force: true });
      world = null;
    }
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedState === undefined) delete process.env.FAKE_APPLE_STATE;
    else process.env.FAKE_APPLE_STATE = savedState;
  });

  /** Install the world's fake toolchain in front of the real one. */
  function activate(w: World): World {
    world = w;
    process.env.PATH = `${w.binDir}${delimiter}${savedPath ?? ''}`;
    process.env.FAKE_APPLE_STATE = w.stateDir;
    return w;
  }

  // -------------------------------------------------------------------------
  // (a) happy path
  // -------------------------------------------------------------------------

  it('(a) builds, installs, launches, screenshots, attests by bundle identity and tears the device down', async () => {
    const w = activate(makeWorld({ maestro: true }));
    const observed: Record<string, DriverRun> = {};
    const harness = makeHarness(
      w,
      async (ctx) => {
        await ctx.build();
        observed.install = await ctx.driver(['mobile-install']);
        observed.launch = await ctx.driver(['mobile-launch']);
        observed.shot = await ctx.driver(['mobile-screenshot', 'home']);
        observed.tap = await ctx.driver(['mobile-tap', 'Settings']);
        return report(
          [
            { id: 'b1', result: 'pass', evidence: { screenshots: ['home.png'], notes: 'content rendered' } },
            { id: 'b2', result: 'pass', evidence: { screenshots: ['home.png'], notes: 'settings opened' } },
          ],
          [{ fileName: 'home.png', caption: 'the home screen' }],
        );
      },
      8_000,
    );

    // Gate 1 agrees this host can run a mobile verification, through the SAME
    // composed probe index.ts injects into the scheduler.
    await expect(mobileToolchainDetail(harness.composition.probe, logger)).resolves.toBeNull();

    const result = await harness.run();

    expect(observed.install.code).toBe(MOBILE_EXIT_OK);
    expect(observed.launch.code).toBe(MOBILE_EXIT_OK);
    expect(observed.launch.stdout).toMatch(/^ready pid=\d+ after=\d+ms$/m);
    expect(observed.shot.code).toBe(MOBILE_EXIT_OK);
    expect(observed.tap.code).toBe(MOBILE_EXIT_OK);

    expect(result.status).toBe('passed');
    expect(result.deployed).toBe(true);
    expect(result.verdict?.status).toBe('pass');

    // The harness's OWN probe re-hashed the container executable and agreed.
    expect(result.errorMessage).toBeUndefined();

    // The install record: one product, hashed identically on both sides.
    const record = readInstallRecord(w);
    expect(record.bundleId).toBe(BUNDLE_ID);
    expect(record.executable).toBe('FakeApp');
    expect(record.builtSha256).toBe(record.installedSha256);
    expect(record.builtSha256).toHaveLength(64);
    expect(record.builtPath).toContain(join('Build', 'Products', 'Debug-iphonesimulator', 'FakeApp.app'));

    // The env the agent actually got: the drive rung resolved, and NEITHER port
    // exists (a mobile request is leased none).
    const env = harness.seen.env as Record<string, string>;
    expect(env.VERIFY_MODALITY).toBe('mobile');
    expect(env.VERIFY_MOBILE_DRIVE).toBe('maestro');
    expect(env.VERIFY_MAESTRO_BIN).toBe(join(w.homeDir, '.maestro', 'bin', 'maestro'));
    expect(env.VERIFY_SIM_UDID).toMatch(/^FAKE0000-/);
    expect(env.VERIFY_SIM_NAME).toBe(`cyboflow-verify-${REQUEST_ID}`);
    expect(env.VERIFY_SIM_RUNTIME).toBe('iOS 26.2');
    expect(env.VERIFY_APP_BUNDLE_ID).toBe(BUNDLE_ID);
    expect(env.VERIFY_MOBILE_READY_TIMEOUT_MS).toBe('8000');
    expect(env.VERIFY_PORT).toBeUndefined();
    expect(env.VERIFY_DRIVER_PORT).toBeUndefined();

    // Maestro was pinned to the leased device and nothing else.
    const drives = readFileSync(join(w.stateDir, 'maestro-invocations'), 'utf8').trim().split('\n');
    expect(drives).toHaveLength(1);
    expect(drives[0].startsWith(`--udid ${env.VERIFY_SIM_UDID} `)).toBe(true);

    // Teardown: the device is deleted, the request dir is gone, the app is dead.
    expect(deviceDirs(w)).toEqual([]);
    expect(existsSync(requestDir(w))).toBe(false);
    const pids = launchedPids(w);
    expect(pids).toHaveLength(1);
    expect(isAlive(pids[0])).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (b) Maestro absent ⇒ observe-only
  // -------------------------------------------------------------------------

  it('(b) runs observe-only with no Maestro: the drive command is refused and the claim is coerced', async () => {
    const w = activate(makeWorld({ maestro: false }));
    const observed: Record<string, DriverRun> = {};
    const harness = makeHarness(
      w,
      async (ctx) => {
        await ctx.build();
        observed.install = await ctx.driver(['mobile-install']);
        observed.launch = await ctx.driver(['mobile-launch']);
        observed.shot = await ctx.driver(['mobile-screenshot', 'home']);
        observed.tap = await ctx.driver(['mobile-tap', 'Settings']);
        // A DISHONEST model: it claims the drive-required behavior passed even
        // though the driver refused it. The harness must not believe it.
        return report(
          [
            { id: 'b1', result: 'pass', evidence: { screenshots: ['home.png'], notes: 'content rendered' } },
            { id: 'b2', result: 'pass', evidence: { screenshots: ['home.png'], notes: 'settings opened' } },
          ],
          [{ fileName: 'home.png', caption: 'the home screen' }],
        );
      },
      8_000,
    );

    const result = await harness.run();

    const env = harness.seen.env as Record<string, string>;
    expect(env.VERIFY_MOBILE_DRIVE).toBe('none');
    expect(env.VERIFY_MAESTRO_BIN).toBeUndefined();

    // Observe-only is still a real verification: install/launch/screenshot all work.
    expect(observed.install.code).toBe(MOBILE_EXIT_OK);
    expect(observed.launch.code).toBe(MOBILE_EXIT_OK);
    expect(observed.shot.code).toBe(MOBILE_EXIT_OK);

    // The drive rung refuses, and says what the agent should report instead.
    expect(observed.tap.code).toBe(MOBILE_EXIT_REFUSED);
    expect(observed.tap.stderr).toContain('drive rung unavailable on this host');
    expect(observed.tap.stderr).toContain('VERIFY_MOBILE_DRIVE=none');
    expect(observed.tap.stderr).toContain('not_testable (drive-unsupported)');
    expect(existsSync(join(w.stateDir, 'maestro-invocations'))).toBe(false);

    // The claimed pass is coerced, and a report with any not_testable and no
    // fail maps to low_confidence — NOT `passed`.
    expect(result.report?.behaviors[0].result).toBe('pass');
    expect(result.report?.behaviors[1].result).toBe('not_testable');
    expect(result.report?.behaviors[1].evidence.notes).toContain('coerced: drive-unsupported');
    expect(result.status).toBe('low_confidence');
    expect(result.deployed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (c) boot failure ⇒ a pre-deploy, env-class skip
  // -------------------------------------------------------------------------

  it('(c) skips with an env-class mobile-simulator check when the device will not boot, and never deploys', async () => {
    const w = activate(makeWorld({ maestro: true, failBoot: true }));
    const harness = makeHarness(
      w,
      async () => {
        throw new Error('the agent must never be invoked when acquisition failed');
      },
      8_000,
    );

    const result = await harness.run();

    expect(result.status).toBe('skipped');
    expect(result.deployed).toBe(false);
    expect(harness.seen.calls).toBe(0);

    const check = result.preflight?.checks.find((c) => c.id === 'mobile-simulator');
    expect(check).toBeDefined();
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('simulator acquisition failed');
    expect(check?.detail).toContain('simctl boot');
    // The shim's own stderr rides all the way out to the evidence row.
    expect(check?.detail).toContain('fail-boot');

    // The §3.1 classifier reads that row and answers `env` — an ADVANCING skip
    // that charges the lane no attempt.
    const classified = classifyVerificationFailure({
      preflight: result.preflight ?? null,
      runnerStatus: result.status,
      reportOutcome: null,
      provisionMode: result.provisionMode ?? null,
      instanceLockContention: false,
      runbookMismatch: result.runbookMismatch === true,
    });
    expect(classified.failureClass).toBe('env');
    expect(classified.evidence.some((e) => e.check === 'mobile-simulator')).toBe(true);

    // acquire() rolled ITSELF back: no device survives, and no request dir.
    expect(deviceDirs(w)).toEqual([]);
    expect(existsSync(requestDir(w))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (d) the negative attestation
  // -------------------------------------------------------------------------

  it('(d) fails a pass whose installed executable no longer matches the staged product', async () => {
    const w = activate(makeWorld({ maestro: true }));
    const harness = makeHarness(
      w,
      async (ctx) => {
        await ctx.build();
        await ctx.driver(['mobile-install']);
        await ctx.driver(['mobile-launch']);
        await ctx.driver(['mobile-screenshot', 'home']);
        // Swap the bits INSIDE the device container, leaving the staged product
        // and the install record untouched. Everything the record claims is
        // still literally true; only the live app is different.
        const container = join(
          w.stateDir,
          'containers',
          ctx.env.VERIFY_SIM_UDID,
          `${BUNDLE_ID}.app`,
          'FakeApp',
        );
        writeFileSync(container, 'a DIFFERENT build of the same bundle id\n');
        return report(
          [
            { id: 'b1', result: 'pass', evidence: { screenshots: ['home.png'], notes: 'content rendered' } },
            { id: 'b2', result: 'pass', evidence: { screenshots: ['home.png'], notes: 'settings opened' } },
          ],
          [{ fileName: 'home.png', caption: 'the home screen' }],
        );
      },
      8_000,
    );

    const result = await harness.run();

    // WHAT THIS PROVES, HONESTLY: two different bundles hash differently, i.e.
    // the identity COMPARISON works and a swapped binary cannot pass. It does
    // NOT prove the passing artifact in arm (a) was compiled from the snapshot —
    // `bundle-identity` makes no such claim (§9, residual B1). A staged product
    // that was never built from this tree, but is installed faithfully, still
    // attests.
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('attestation missing/mismatched');
    expect(result.errorMessage).toContain('NOT the product staged for this request');
    expect(result.deployed).toBe(true);

    // The record itself still agrees with itself — the disagreement is between
    // the record and the LIVE re-hash, which is the only reading that matters.
    const record = readInstallRecord(w);
    expect(record.builtSha256).toBe(record.installedSha256);
  });

  // -------------------------------------------------------------------------
  // (e) readiness never reached
  // -------------------------------------------------------------------------

  it('(e) reports low_confidence, never a fail, when the app never paints a non-uniform frame', async () => {
    const w = activate(makeWorld({ maestro: true, blankFrames: true }));
    const observed: Record<string, DriverRun> = {};
    const harness = makeHarness(
      w,
      async (ctx) => {
        await ctx.build();
        observed.install = await ctx.driver(['mobile-install']);
        observed.launch = await ctx.driver(['mobile-launch']);
        return report(
          [
            {
              id: 'b1',
              result: 'not_testable',
              evidence: { screenshots: [READINESS_LAST_FRAME_NAME], notes: 'readiness-timeout' },
            },
            {
              id: 'b2',
              result: 'not_testable',
              evidence: { screenshots: [READINESS_LAST_FRAME_NAME], notes: 'readiness-timeout' },
            },
          ],
          [{ fileName: READINESS_LAST_FRAME_NAME, caption: 'the last frame before the budget ran out' }],
        );
      },
      1_500,
    );

    const result = await harness.run();

    expect(observed.install.code).toBe(MOBILE_EXIT_OK);
    expect(observed.launch.code).toBe(MOBILE_EXIT_READINESS_TIMEOUT);
    expect(observed.launch.stdout).toContain(`readiness-timeout after=`);
    expect(observed.launch.stdout).toContain(`lastFrame=${READINESS_LAST_FRAME_NAME}`);
    expect(existsSync(join(w.artifactsDir, READINESS_LAST_FRAME_NAME))).toBe(true);

    // A budget that ran out is not a broken app: never `failed`.
    expect(result.status).toBe('low_confidence');
    expect(result.verdict?.status).toBe('low_confidence');
    expect(result.report?.behaviors.every((b) => b.result === 'not_testable')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // §8.2 — the boot sweep
  // -------------------------------------------------------------------------

  it('sweeps a dead owner’s simulator at boot and leaves a live owner’s alone', async () => {
    const w = activate(makeWorld({ maestro: true }));
    const { composition } = composeStack(w);
    const exec = createHostAppleCliExec();

    const create = async (requestId: string): Promise<string> => {
      const res = await exec('xcrun', [
        'simctl',
        'create',
        `cyboflow-verify-${requestId}`,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      ]);
      return res.stdout.trim();
    };

    const staleUdid = await create('stale');
    const liveUdid = await create('live');
    const gonePid = await deadPid();

    const marker = (requestId: string, pid: number, udid: string): void => {
      const dir = join(w.dataDir, VERIFY_MOBILE_DIRNAME, requestId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'owner.json'),
        JSON.stringify({
          pid,
          // Empty on purpose: the start-time check then degrades to plain
          // liveness, which is the conservative direction the module documents.
          pidStartedAt: '',
          simName: `cyboflow-verify-${requestId}`,
          simUdid: udid,
          requestId,
          createdAt: new Date().toISOString(),
        }),
      );
    };
    marker('stale', gonePid, staleUdid);
    marker('live', process.pid, liveUdid);

    await composition.sweepAtBoot();

    // The dead owner's device AND its request dir are reclaimed.
    expect(existsSync(join(w.stateDir, 'devices', staleUdid))).toBe(false);
    expect(existsSync(join(w.dataDir, VERIFY_MOBILE_DIRNAME, 'stale'))).toBe(false);
    // The live owner's are untouched — this process is still holding them.
    expect(existsSync(join(w.stateDir, 'devices', liveUdid))).toBe(true);
    expect(existsSync(join(w.dataDir, VERIFY_MOBILE_DIRNAME, 'live', 'owner.json'))).toBe(true);
  });
});

/** Assert the fixture ships every shim the suite puts on PATH. */
describe.skipIf(process.platform === 'win32')('fakeAppleToolchain fixture', () => {
  it('ships all four shims', () => {
    for (const name of SHIM_NAMES) {
      expect(existsSync(join(FIXTURE_DIR, name)), `${name} is missing`).toBe(true);
    }
  });
});
