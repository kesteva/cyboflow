/**
 * mobileCommands — the `mobile-*` half of `$VERIFY_DRIVER` (docs/proposals/
 * mobile-verification-tier.md). Sibling of driverCore.ts rather than more of
 * it: the CDP driver is already ~1.7k lines, and the two families share only a
 * dispatcher, a deps bag and an exit-code vocabulary. esbuild bundles this file
 * into `driverCli.js` (scripts/bundle-verify-driver.mjs is a `bundle: true`
 * build over the CLI entry), so a sibling import costs the standalone CLI
 * nothing.
 *
 * The `mobile` modality is an iOS app on a simulator the HARNESS leased for
 * this request, stood up on Apple's own command-line toolchain (`xcrun
 * simctl`), optionally driven by Maestro. There is no port, no server and no
 * CDP endpoint — which is exactly why none of this could live behind the
 * existing commands.
 *
 * THREE INVARIANTS SHAPE EVERY COMMAND HERE.
 *
 *  1. ONE SIMULATOR, AND IT IS NOT THE AGENT'S. Every `simctl`/Maestro argv this
 *     module builds names `$VERIFY_SIM_UDID` and nothing else. The agent has
 *     Bash, so it *could* run `simctl` itself against some other device — the
 *     prompts forbid it — but nothing the DRIVER emits may ever reach a
 *     simulator the scheduler did not lease, because a capture from the wrong
 *     device is indistinguishable from a capture of the deliverable. Maestro is
 *     the sharp edge: its default is "the only booted device", so every drive
 *     argv carries an explicit pin flag, and a Maestro that exposes neither
 *     `--udid` nor `--device` is REFUSED rather than run unpinned.
 *
 *  2. THE HARNESS OWNS THE INSTALL. `mobile-install` — not the agent — resolves
 *     the product, proves it is the one built into THIS request's DerivedData,
 *     and hashes the executable on both sides of `simctl install`. That record
 *     is what makes `bundle-identity` attestable at all (§7.1's rule that a
 *     surface nobody can identify never passes). An agent running `simctl
 *     install` by hand produces a running app with no provenance whatsoever.
 *
 *  3. READINESS IS PROVEN FROM PIXELS, NOT FROM AN EXIT CODE. `simctl launch`
 *     returns the moment launchd forks the process, long before the first frame
 *     renders — measured on Xcode 26.2, a freshly launched app screenshots as a
 *     uniform blank for ~3 s. A capture taken then is a picture of nothing, and
 *     an agent judging from it reports a confident wrong answer. So
 *     `mobile-launch` owns the wait: pid alive, two byte-identical consecutive
 *     frames, and that frame not a single flat colour.
 *
 * EXIT CODES (the agent acts on these; see {@link MOBILE_EXIT_REFUSED}):
 *   0 — did what it said.
 *   1 — usage / missing harness env (a harness bug, not an agent-fixable one).
 *   2 — refused or failed: the command could not do its job honestly.
 *   3 — `mobile-launch` ONLY: readiness timeout, last frame preserved. Distinct
 *       from 2 because it is NOT a failing app — the agent must report every
 *       behavior `not_testable (readiness-timeout)`, never `fail`.
 *
 * Everything is injectable through {@link MobileDeps} (a subset of driverCore's
 * `DriverDeps`, which extends it), so the unit tests drive the whole family
 * without a simulator, an Xcode install, or a Maestro JVM.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Exit code for a command that did what it said. */
export const MOBILE_EXIT_OK = 0;

/** Exit code for bad usage or missing harness env (mirrors driverCore's `1`). */
export const MOBILE_EXIT_USAGE = 1;

/**
 * Exit code for "refused, or could not do its job". Every failure that is not a
 * readiness timeout lands here: a product that did not match, a bundle id that
 * disagreed, an install whose bits changed, a drive rung this host does not
 * have. The agent's contract is to report the refusal line, never to reach past
 * the driver for the same effect with raw `simctl`.
 */
export const MOBILE_EXIT_REFUSED = 2;

/**
 * Exit code for a `mobile-launch` readiness timeout — deliberately its OWN code.
 * "The app never painted within the budget" is not "the app is broken": the
 * agent reports `not_testable (readiness-timeout)` and cites the preserved
 * frame, and a verdict built on `fail` there would be a false accusation.
 */
export const MOBILE_EXIT_READINESS_TIMEOUT = 3;

/** Default `VERIFY_APP_PRODUCT_GLOB`, relative to `$VERIFY_DERIVED_DATA`. */
export const DEFAULT_APP_PRODUCT_GLOB = 'Build/Products/*-iphonesimulator/*.app';

/** Default readiness budget when `VERIFY_MOBILE_READY_TIMEOUT_MS` is unset. */
export const DEFAULT_READY_TIMEOUT_MS = 90_000;

/** Gap between readiness frames. Two identical frames 500 ms apart is the stability signal. */
export const READY_POLL_INTERVAL_MS = 500;

/** Budget for a short `simctl` / `plutil` invocation (screenshot, openurl, launch, container lookup). */
export const MOBILE_QUICK_TIMEOUT_MS = 30_000;

/** Budget for `simctl install`, which copies a whole app bundle into the device container. */
export const MOBILE_INSTALL_TIMEOUT_MS = 120_000;

/** Budget for one Maestro invocation — a JVM start plus the flow itself. */
export const MAESTRO_TIMEOUT_MS = 300_000;

/** The install record `mobile-install` writes into `$VERIFY_ARTIFACTS_DIR`. */
export const MOBILE_INSTALL_RECORD_NAME = 'mobile-install.json';

/** Where a readiness timeout preserves the last frame it managed to capture. */
export const READINESS_LAST_FRAME_NAME = 'readiness-last-frame.png';

/** Driver-owned state dir under `$VERIFY_ARTIFACTS_DIR` (mirrors driverCore's `.driver`). */
const DRIVER_STATE_DIR = '.driver';

/** Scratch frame the readiness loop overwrites each poll. */
const READINESS_FRAME_RELATIVE = join(DRIVER_STATE_DIR, 'readiness', 'frame.png');

/** Where generated one-step Maestro flows are written (kept as artifacts — they are evidence of what was driven). */
const MAESTRO_FLOW_DIR = 'maestro';

/** At most this many pixels are compared by {@link isUniformPng}; a 3× Retina frame has millions. */
const UNIFORM_SAMPLE_BUDGET = 20_000;

/** The `mobile-*` words this module owns, in USAGE order. */
export const MOBILE_COMMAND_WORDS = [
  'mobile-install',
  'mobile-launch',
  'mobile-screenshot',
  'mobile-openurl',
  'mobile-tap',
  'mobile-type',
  'mobile-swipe',
  'mobile-press',
  'mobile-flow',
] as const;

/** The mobile family's slice of the driver USAGE text. */
export const MOBILE_USAGE = `  mobile-install
  mobile-launch
  mobile-screenshot <name>
  mobile-openurl <url>
  mobile-tap <text-or-id>
  mobile-type <text...>
  mobile-swipe <up|down|left|right>
  mobile-press <home|back|enter>
  mobile-flow <path-to-yaml>`;

// ---------------------------------------------------------------------------
// Command model
// ---------------------------------------------------------------------------

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';
export type PressKey = 'home' | 'back' | 'enter';

/**
 * One `mobile-*` invocation. Shaped like driverCore's `AttestCommand` — a
 * single `kind` with a `sub` discriminant — so the dispatcher can exclude the
 * whole family in one clause rather than nine.
 */
export type MobileCommand =
  | { kind: 'mobile'; sub: 'install' }
  | { kind: 'mobile'; sub: 'launch' }
  | { kind: 'mobile'; sub: 'screenshot'; name: string }
  | { kind: 'mobile'; sub: 'openurl'; url: string }
  | { kind: 'mobile'; sub: 'tap'; target: string }
  | { kind: 'mobile'; sub: 'type'; text: string }
  | { kind: 'mobile'; sub: 'swipe'; direction: SwipeDirection }
  | { kind: 'mobile'; sub: 'press'; key: PressKey }
  | { kind: 'mobile'; sub: 'flow'; flowPath: string };

/** The five subcommands that DRIVE the device and therefore need the Maestro rung. */
const DRIVE_SUBS: ReadonlySet<MobileCommand['sub']> = new Set([
  'tap',
  'type',
  'swipe',
  'press',
  'flow',
]);

/** True for a subcommand that requires `VERIFY_MOBILE_DRIVE=maestro`. */
export function isMobileDriveSub(sub: MobileCommand['sub']): boolean {
  return DRIVE_SUBS.has(sub);
}

export type ParseMobileResult =
  | { ok: true; command: MobileCommand }
  | { ok: false; message: string };

/** What `mobile-install` writes to `$VERIFY_ARTIFACTS_DIR/mobile-install.json`. */
export interface MobileInstallRecord {
  /** Absolute realpath of the `.app` under this request's DerivedData. */
  builtPath: string;
  /** Absolute path `simctl get_app_container` reported after the install. */
  installedPath: string;
  /** sha256 of the Mach-O executable INSIDE the staged product. */
  builtSha256: string;
  /** sha256 of the same executable read back out of the device container. */
  installedSha256: string;
  bundleId: string;
  /** `CFBundleExecutable` — which file inside the bundle was hashed. */
  executable: string;
  installedAt: string;
}

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

/**
 * Everything the mobile family touches outside itself. driverCore's `DriverDeps`
 * EXTENDS this interface, so there is exactly one deps bag at runtime and the
 * four members both families share (`ensureDir`, `isProcessAlive`, `stdout`,
 * `stderr`) are declared once, here.
 *
 * `runTool` is deliberately NOT driverCore's `runPeekaboo`: peekaboo's helper
 * REJECTS on a non-zero exit, which throws away the stderr the refusal lines
 * here need to quote, and several of these commands treat a non-zero exit as a
 * fact to report rather than an exception. Every call passes an argv ARRAY —
 * there is no shell anywhere in this module, so a bundle id or a URL out of the
 * task can never be word-split or interpolated into a command line.
 */
export interface MobileDeps {
  /** Spawn `bin` with an argv array; resolve the exit code and both streams. Rejects only on spawn error / timeout. */
  runTool(
    bin: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** `fs.readdir` — rejects for a path that is not a readable directory. */
  readDir(path: string): Promise<string[]>;
  /** `lstat`-based kind probe (NOT `stat`): a symlink reports as `'symlink'`, a missing path as `null`. */
  pathKind(path: string): Promise<'file' | 'dir' | 'symlink' | null>;
  /** `fs.realpath` — resolves every symlink and `..` in the path. */
  realpath(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Buffer>;
  writeTextFile(path: string, contents: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /** `process.kill(pid, 0)` — shared with driverCore's serve reaper. */
  isProcessAlive(pid: number): boolean;
  /** Injected clock (`Date.now`), so the readiness loop is testable without real time. */
  now(): number;
  /** Injected sleep, so the readiness loop's 500 ms polls cost a test nothing. */
  sleep(ms: number): Promise<void>;
  /** The snapshot worktree the driver was invoked from — one of the two roots `mobile-flow` accepts. */
  cwd(): string;
  stdout(line: string): void;
  stderr(line: string): void;
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `mobile-*` invocation. Returns `null` — not a failure — when `cmd` is
 * not one of this family's words, so driverCore's `parseArgv` can fall through
 * to its own "unknown command" message for everything else.
 *
 * `mobile-type` JOINS its trailing words (it is free text, like `type`);
 * everything else demands an EXACT arity, for the same reason the attest
 * channels do: a tap target or a swipe direction is a comparison value, and a
 * loose join would silently drive something other than what was asked.
 */
export function parseMobileArgv(cmd: string, rest: string[]): ParseMobileResult | null {
  switch (cmd) {
    case 'mobile-install':
      if (rest.length !== 0) return { ok: false, message: 'mobile-install takes no arguments' };
      return { ok: true, command: { kind: 'mobile', sub: 'install' } };
    case 'mobile-launch':
      if (rest.length !== 0) return { ok: false, message: 'mobile-launch takes no arguments' };
      return { ok: true, command: { kind: 'mobile', sub: 'launch' } };
    case 'mobile-screenshot': {
      if (rest.length !== 1) {
        return { ok: false, message: 'mobile-screenshot requires exactly one argument: <name>' };
      }
      const name = sanitizeMobileScreenshotName(rest[0]);
      if (!name) {
        return {
          ok: false,
          message: `invalid mobile-screenshot name: ${rest[0]} — pass a bare filename (no "/", no "\\", no "..")`,
        };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'screenshot', name } };
    }
    case 'mobile-openurl': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return { ok: false, message: 'mobile-openurl requires exactly one argument: <url>' };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'openurl', url: rest[0] } };
    }
    case 'mobile-tap': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return {
          ok: false,
          message: 'mobile-tap requires exactly one argument: <text-or-id> (quote it)',
        };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'tap', target: rest[0] } };
    }
    case 'mobile-type': {
      if (rest.length < 1) {
        return { ok: false, message: 'mobile-type requires at least one argument: <text...>' };
      }
      const text = rest.join(' ');
      if (text.trim().length === 0) {
        return { ok: false, message: 'mobile-type requires non-empty text' };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'type', text } };
    }
    case 'mobile-swipe': {
      const direction = rest.length === 1 ? rest[0].trim().toLowerCase() : '';
      if (!isSwipeDirection(direction)) {
        return {
          ok: false,
          message: 'mobile-swipe requires exactly one argument: <up|down|left|right>',
        };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'swipe', direction } };
    }
    case 'mobile-press': {
      const key = rest.length === 1 ? rest[0].trim().toLowerCase() : '';
      if (!isPressKey(key)) {
        return { ok: false, message: 'mobile-press requires exactly one argument: <home|back|enter>' };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'press', key } };
    }
    case 'mobile-flow': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return { ok: false, message: 'mobile-flow requires exactly one argument: <path-to-yaml>' };
      }
      return { ok: true, command: { kind: 'mobile', sub: 'flow', flowPath: rest[0] } };
    }
    default:
      return null;
  }
}

function isSwipeDirection(value: string): value is SwipeDirection {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right';
}

function isPressKey(value: string): value is PressKey {
  return value === 'home' || value === 'back' || value === 'enter';
}

/**
 * STRICTER than driverCore's `sanitizeScreenshotName`, on purpose. That one
 * silently basenames a traversal (`../evil` -> `evil.png`) because it predates
 * the harness contract and its callers rely on the rewrite. Here a name with a
 * path separator is REFUSED outright: the mobile family is new, so there is no
 * caller to keep happy, and a silent rewrite means the agent's report cites a
 * filename that is not the one it asked for — which is precisely the confusion
 * a screenshot is supposed to remove.
 *
 * Returns the `.png`-suffixed basename, or `null` when the name is unusable.
 */
export function sanitizeMobileScreenshotName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.includes('..')) return null;
  if (name.startsWith('.')) return null;
  return /\.png$/i.test(name) ? name : `${name}.png`;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** One resolved harness lever, or the message naming the one that is missing. */
type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

function requireVar(env: NodeJS.ProcessEnv, name: string): Resolved<string> {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, message: `${name} is required but not set` };
  }
  return { ok: true, value: raw.trim() };
}

/** The readiness budget, defaulting when unset and ignoring a malformed value rather than failing the launch. */
export function resolveReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.VERIFY_MOBILE_READY_TIMEOUT_MS;
  if (!raw) return DEFAULT_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READY_TIMEOUT_MS;
}

/**
 * The refusal a drive command gets when this host has no Maestro rung. Exported
 * so the tests, the harness contract and the agent prompts can all name ONE
 * string — the agent's correct response (`not_testable (drive-unsupported)`) is
 * spelled inside it, because a refusal that does not say what to do instead is
 * an invitation to work around it with raw `simctl`.
 */
export function mobileDriveRefusal(env: NodeJS.ProcessEnv): string {
  const drive = env.VERIFY_MOBILE_DRIVE?.trim() ?? '';
  const bin = env.VERIFY_MAESTRO_BIN?.trim() ?? '';
  const why =
    drive === 'maestro' && bin.length === 0
      ? 'VERIFY_MOBILE_DRIVE=maestro but VERIFY_MAESTRO_BIN is not set'
      : `VERIFY_MOBILE_DRIVE=${drive.length > 0 ? drive : 'unset'}`;
  return `drive rung unavailable on this host (${why}) — report the behavior as not_testable (drive-unsupported)`;
}

/** The Maestro binary, or `null` when this host has no drive rung. */
function resolveMaestroBin(env: NodeJS.ProcessEnv): string | null {
  if (env.VERIFY_MOBILE_DRIVE?.trim() !== 'maestro') return null;
  const bin = env.VERIFY_MAESTRO_BIN?.trim();
  return bin && bin.length > 0 ? bin : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run one `mobile-*` command end-to-end and return its exit code. Never throws:
 * an unexpected error from a dep becomes a `MOBILE_EXIT_REFUSED` with the
 * message on stderr, because a stack trace out of a CLI the agent is reading
 * through Bash is strictly less actionable than one refusal line.
 */
export async function runMobileCommand(
  command: MobileCommand,
  env: NodeJS.ProcessEnv,
  deps: MobileDeps,
): Promise<number> {
  const artifactsDir = requireVar(env, 'VERIFY_ARTIFACTS_DIR');
  if (!artifactsDir.ok) {
    deps.stderr(artifactsDir.message);
    return MOBILE_EXIT_USAGE;
  }
  const udid = requireVar(env, 'VERIFY_SIM_UDID');
  if (!udid.ok) {
    deps.stderr(udid.message);
    return MOBILE_EXIT_USAGE;
  }

  // The drive guard fires BEFORE any work, so a host without Maestro produces
  // the same refusal whatever the command would have done — the agent must be
  // able to tell "this rung does not exist here" from "the tap missed".
  if (isMobileDriveSub(command.sub) && resolveMaestroBin(env) === null) {
    deps.stderr(mobileDriveRefusal(env));
    return MOBILE_EXIT_REFUSED;
  }

  try {
    switch (command.sub) {
      case 'install':
        return await mobileInstall(env, udid.value, artifactsDir.value, deps);
      case 'launch':
        return await mobileLaunch(env, udid.value, artifactsDir.value, deps);
      case 'screenshot':
        return await mobileScreenshot(command.name, udid.value, artifactsDir.value, deps);
      case 'openurl':
        return await mobileOpenUrl(command.url, udid.value, deps);
      default:
        return await mobileDrive(command, env, udid.value, artifactsDir.value, deps);
    }
  } catch (err) {
    deps.stderr(`${commandWord(command)} failed: ${errorText(err)}`);
    return MOBILE_EXIT_REFUSED;
  }
}

function commandWord(command: MobileCommand): string {
  return `mobile-${command.sub}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last 400 characters of a tool's stderr — enough to be decisive, bounded so a build log cannot flood the transcript. */
function tail(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

// ---------------------------------------------------------------------------
// mobile-install
// ---------------------------------------------------------------------------

/**
 * `mobile-install` — resolve, PROVE, install, and re-hash.
 *
 * The confinement checks are the point, not paperwork. The product glob comes
 * from a runbook the verify-setup flow drafted, so it is attacker-adjacent in
 * the same sense every task field is: a glob resolving outside this request's
 * DerivedData would install some OTHER build — a stale one from the developer's
 * own Xcode session, or a deliberately substituted one — and every subsequent
 * screenshot would be evidence about the wrong binary. Three layers say no:
 *
 *   - `..` is rejected in the glob itself (before any I/O), so a traversal
 *     never even gets a readdir;
 *   - the matched `.app` may not BE a symlink;
 *   - its realpath must sit under the realpath of DerivedData, which catches a
 *     symlink anywhere in the intermediate path too.
 *
 * Then `CFBundleIdentifier` must equal `$VERIFY_APP_BUNDLE_ID`: the glob proves
 * WHERE the bundle came from, the bundle id proves WHAT it claims to be, and
 * the task declared the latter. Finally the executable is hashed before the
 * install and read back out of the device container after it — `simctl install`
 * is byte-preserving for the Mach-O, so an inequality means the device already
 * held a different build of the same bundle id and the install did not take.
 */
async function mobileInstall(
  env: NodeJS.ProcessEnv,
  udid: string,
  artifactsDir: string,
  deps: MobileDeps,
): Promise<number> {
  const bundleIdVar = requireVar(env, 'VERIFY_APP_BUNDLE_ID');
  if (!bundleIdVar.ok) {
    deps.stderr(bundleIdVar.message);
    return MOBILE_EXIT_USAGE;
  }
  const derivedDataVar = requireVar(env, 'VERIFY_DERIVED_DATA');
  if (!derivedDataVar.ok) {
    deps.stderr(derivedDataVar.message);
    return MOBILE_EXIT_USAGE;
  }
  const bundleId = bundleIdVar.value;
  const derivedData = derivedDataVar.value;
  const glob = env.VERIFY_APP_PRODUCT_GLOB?.trim() || DEFAULT_APP_PRODUCT_GLOB;

  const segments = parseGlobSegments(glob);
  if (!segments.ok) {
    deps.stderr(segments.message);
    return MOBILE_EXIT_REFUSED;
  }

  const matches = await globUnderRoot(derivedData, segments.value, deps);
  if (matches.length === 0) {
    deps.stderr(
      `no product matched ${join(derivedData, glob)} — nothing was built into this request's DerivedData`,
    );
    return MOBILE_EXIT_REFUSED;
  }
  if (matches.length > 1) {
    deps.stderr(
      `expected exactly one product under ${join(derivedData, glob)} but matched ${matches.length}: ${matches.join(', ')}`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  const candidate = matches[0];
  if ((await deps.pathKind(candidate)) === 'symlink') {
    deps.stderr(
      `product escapes DerivedData: ${candidate} is a symlink — the installed app must be the bundle this request built, not a link to one`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  let builtPath: string;
  let realRoot: string;
  try {
    builtPath = await deps.realpath(candidate);
    realRoot = await deps.realpath(derivedData);
  } catch (err) {
    deps.stderr(`could not resolve the product path: ${errorText(err)}`);
    return MOBILE_EXIT_REFUSED;
  }
  if (builtPath !== realRoot && !builtPath.startsWith(realRoot + sep)) {
    deps.stderr(
      `product escapes DerivedData: ${candidate} resolves to ${builtPath}, which is outside ${realRoot}`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  const info = await readInfoPlist(join(builtPath, 'Info.plist'), deps);
  if (!info.ok) {
    deps.stderr(info.message);
    return MOBILE_EXIT_REFUSED;
  }
  if (info.value.bundleId !== bundleId) {
    deps.stderr(
      `bundle id mismatch: ${builtPath} declares CFBundleIdentifier "${info.value.bundleId}" but this request's VERIFY_APP_BUNDLE_ID is "${bundleId}"`,
    );
    return MOBILE_EXIT_REFUSED;
  }
  const executable = info.value.executable;

  let builtSha256: string;
  try {
    builtSha256 = sha256(await deps.readFileBytes(join(builtPath, executable)));
  } catch (err) {
    deps.stderr(
      `could not hash the staged executable ${join(builtPath, executable)}: ${errorText(err)}`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  const install = await deps.runTool(
    'xcrun',
    ['simctl', 'install', udid, builtPath],
    MOBILE_INSTALL_TIMEOUT_MS,
  );
  if (install.code !== 0) {
    deps.stderr(`simctl install exited ${install.code}: ${tail(install.stderr || install.stdout)}`);
    return MOBILE_EXIT_REFUSED;
  }

  const container = await deps.runTool(
    'xcrun',
    ['simctl', 'get_app_container', udid, bundleId, 'app'],
    MOBILE_QUICK_TIMEOUT_MS,
  );
  const installedPath = container.stdout.trim();
  if (container.code !== 0 || installedPath.length === 0) {
    deps.stderr(
      `simctl get_app_container exited ${container.code} with no container path: ${tail(container.stderr || container.stdout)}`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  let installedSha256: string;
  try {
    installedSha256 = sha256(await deps.readFileBytes(join(installedPath, executable)));
  } catch (err) {
    deps.stderr(
      `could not hash the installed executable ${join(installedPath, executable)}: ${errorText(err)}`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  // The record is written BEFORE the comparison: a mismatch is exactly the case
  // a human will want the two hashes for.
  const record: MobileInstallRecord = {
    builtPath,
    installedPath,
    builtSha256,
    installedSha256,
    bundleId,
    executable,
    installedAt: new Date(deps.now()).toISOString(),
  };
  await deps.ensureDir(artifactsDir);
  await deps.writeTextFile(
    join(artifactsDir, MOBILE_INSTALL_RECORD_NAME),
    `${JSON.stringify(record, null, 2)}\n`,
  );

  if (builtSha256 !== installedSha256) {
    deps.stderr(
      `installed bits differ from the staged product: ${executable} hashes ${builtSha256} under DerivedData but ${installedSha256} inside the device container`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  deps.stdout(
    `ok: installed ${bundleId} (${executable} sha256 ${builtSha256}) from ${builtPath} to ${installedPath}`,
  );
  return MOBILE_EXIT_OK;
}

/** sha256, hex — the one hash both sides of the install are compared with. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read the two `Info.plist` keys the install needs, via `plutil -convert json`.
 * A `.app`'s Info.plist is normally BINARY plist, so there is no text parsing
 * shortcut here; `plutil` ships with macOS and is the same tool Xcode uses.
 */
async function readInfoPlist(
  plistPath: string,
  deps: MobileDeps,
): Promise<Resolved<{ bundleId: string; executable: string }>> {
  const res = await deps.runTool(
    'plutil',
    ['-convert', 'json', '-o', '-', plistPath],
    MOBILE_QUICK_TIMEOUT_MS,
  );
  if (res.code !== 0) {
    return {
      ok: false,
      message: `could not read ${plistPath}: plutil exited ${res.code}: ${tail(res.stderr || res.stdout)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    return { ok: false, message: `${plistPath} did not convert to valid JSON: ${errorText(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, message: `${plistPath} did not convert to a JSON object` };
  }
  const record = parsed as Record<string, unknown>;
  const bundleId = record.CFBundleIdentifier;
  const executable = record.CFBundleExecutable;
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    return { ok: false, message: `${plistPath} declares no CFBundleIdentifier` };
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    return { ok: false, message: `${plistPath} declares no CFBundleExecutable` };
  }
  if (executable.includes('/') || executable.includes('\\') || executable.includes('..')) {
    // CFBundleExecutable names a file INSIDE the bundle; anything path-shaped
    // would let a crafted plist point the hash at a file outside it.
    return {
      ok: false,
      message: `${plistPath} declares a path-shaped CFBundleExecutable ("${executable}") — it must name a file inside the bundle`,
    };
  }
  return { ok: true, value: { bundleId, executable } };
}

// ---------------------------------------------------------------------------
// The glob (no dependency, `*`/`?` within one path segment)
// ---------------------------------------------------------------------------

/**
 * Split a product glob into path segments, refusing anything that could leave
 * the root BEFORE any filesystem call. An absolute glob is refused too: the
 * contract is "relative to `$VERIFY_DERIVED_DATA`", and a leading `/` would
 * quietly mean something else entirely.
 */
export function parseGlobSegments(glob: string): Resolved<string[]> {
  const raw = glob.trim();
  if (raw.length === 0) {
    return { ok: false, message: 'VERIFY_APP_PRODUCT_GLOB is empty' };
  }
  if (raw.startsWith('/') || isAbsolute(raw)) {
    return {
      ok: false,
      message: `VERIFY_APP_PRODUCT_GLOB must be relative to this request's DerivedData, but is absolute: ${glob}`,
    };
  }
  const segments = raw.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    return {
      ok: false,
      message: `VERIFY_APP_PRODUCT_GLOB may not contain "..": ${glob} would resolve outside this request's DerivedData`,
    };
  }
  if (segments.length === 0) {
    return { ok: false, message: `VERIFY_APP_PRODUCT_GLOB names no path: ${glob}` };
  }
  return { ok: true, value: segments };
}

/**
 * Expand pre-validated glob segments under `root`, returning absolute paths in
 * a stable (sorted) order. `*` and `?` match within ONE segment only — there is
 * no `**`, because the product glob's whole job is to name a precise build
 * output directory and a recursive wildcard would happily reach a nested
 * `.app` inside a test host or an app extension.
 *
 * Dotfiles are matched only by a segment that itself starts with `.`, the
 * standard shell rule.
 */
export async function globUnderRoot(
  root: string,
  segments: string[],
  deps: MobileDeps,
): Promise<string[]> {
  let current = [root];
  for (const segment of segments) {
    const next: string[] = [];
    if (!/[*?]/.test(segment)) {
      for (const dir of current) {
        const candidate = join(dir, segment);
        if ((await deps.pathKind(candidate)) !== null) next.push(candidate);
      }
    } else {
      const matches = segmentMatcher(segment);
      for (const dir of current) {
        let entries: string[];
        try {
          entries = await deps.readDir(dir);
        } catch {
          continue; // not a readable directory — simply contributes no matches
        }
        for (const name of [...entries].sort()) {
          if (name.startsWith('.') && !segment.startsWith('.')) continue;
          if (matches(name)) next.push(join(dir, name));
        }
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

/** Compile ONE glob segment into a predicate over a directory entry name. */
function segmentMatcher(segment: string): (name: string) => boolean {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  const re = new RegExp(`^${source}$`);
  return (name) => re.test(name);
}

// ---------------------------------------------------------------------------
// mobile-launch + readiness
// ---------------------------------------------------------------------------

/**
 * `mobile-launch` — launch, then WAIT for the app to actually be on screen.
 *
 * `simctl launch` prints `<bundle id>: <pid>` and returns immediately, which is
 * why the pid is parsed rather than ignored: it is the only cheap signal that
 * distinguishes "still painting" from "crashed on launch", and those two demand
 * opposite reports from the agent (`not_testable` vs a real failure).
 *
 * Readiness needs all three of its conditions, and each one alone is wrong:
 *   - pid alive, only: a crashed-after-launch app is caught, a blank one is not;
 *   - two identical frames, only: a blank screen is perfectly stable, so this
 *     passes instantly on exactly the frame that shows nothing;
 *   - non-uniform, only: a half-painted frame mid-animation is non-uniform.
 * Together they mean "a process is alive and the screen it painted stopped
 * changing at something that is not a flat colour".
 */
async function mobileLaunch(
  env: NodeJS.ProcessEnv,
  udid: string,
  artifactsDir: string,
  deps: MobileDeps,
): Promise<number> {
  const bundleIdVar = requireVar(env, 'VERIFY_APP_BUNDLE_ID');
  if (!bundleIdVar.ok) {
    deps.stderr(bundleIdVar.message);
    return MOBILE_EXIT_USAGE;
  }
  const bundleId = bundleIdVar.value;
  const timeoutMs = resolveReadyTimeoutMs(env);

  const launch = await deps.runTool(
    'xcrun',
    ['simctl', 'launch', udid, bundleId],
    MOBILE_QUICK_TIMEOUT_MS,
  );
  if (launch.code !== 0) {
    deps.stderr(`simctl launch exited ${launch.code}: ${tail(launch.stderr || launch.stdout)}`);
    return MOBILE_EXIT_REFUSED;
  }
  const pid = parseLaunchPid(launch.stdout);
  if (pid === null) {
    deps.stderr(
      `simctl launch reported no pid (stdout: ${tail(launch.stdout, 200) || '(empty)'}) — cannot verify the app stayed up`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  const framePath = join(artifactsDir, READINESS_FRAME_RELATIVE);
  await deps.ensureDir(join(artifactsDir, DRIVER_STATE_DIR, 'readiness'));

  const start = deps.now();
  let previous: Buffer | null = null;
  let haveFrame = false;
  let lastCaptureError = '';

  while (deps.now() - start < timeoutMs) {
    if (!deps.isProcessAlive(pid)) {
      deps.stderr(
        `app exited during launch: pid ${pid} (${bundleId}) is gone after ${deps.now() - start}ms — the app crashed or was terminated before it became ready`,
      );
      return MOBILE_EXIT_REFUSED;
    }

    const shot = await deps.runTool(
      'xcrun',
      ['simctl', 'io', udid, 'screenshot', framePath],
      MOBILE_QUICK_TIMEOUT_MS,
    );
    if (shot.code === 0) {
      let frame: Buffer | null = null;
      try {
        frame = await deps.readFileBytes(framePath);
      } catch (err) {
        lastCaptureError = errorText(err);
      }
      if (frame) {
        haveFrame = true;
        if (previous && frame.equals(previous) && !isUniformPng(frame)) {
          deps.stdout(`ready pid=${pid} after=${deps.now() - start}ms`);
          return MOBILE_EXIT_OK;
        }
        previous = frame;
      }
    } else {
      lastCaptureError = tail(shot.stderr || shot.stdout, 200);
    }

    await deps.sleep(READY_POLL_INTERVAL_MS);
  }

  const elapsed = deps.now() - start;
  let lastFrame = '(none)';
  if (haveFrame) {
    try {
      await deps.copyFile(framePath, join(artifactsDir, READINESS_LAST_FRAME_NAME));
      lastFrame = READINESS_LAST_FRAME_NAME;
    } catch (err) {
      lastCaptureError = errorText(err);
    }
  }
  // ONE structured line, because this is the outcome an agent must transcribe
  // into `not_testable (readiness-timeout)` without paraphrasing it.
  deps.stdout(`readiness-timeout after=${elapsed}ms lastFrame=${lastFrame}`);
  if (lastCaptureError.length > 0) deps.stderr(`last capture problem: ${lastCaptureError}`);
  return MOBILE_EXIT_READINESS_TIMEOUT;
}

/**
 * Pull the pid out of `simctl launch` stdout (`com.example.App: 51234`).
 * Tolerant of a leading status line, which some Xcode versions emit; anchored
 * on the LAST `: <digits>` so a bundle id containing digits cannot be read as
 * the pid.
 */
export function parseLaunchPid(stdout: string): number | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /:\s*(\d+)$/.exec(lines[i]);
    if (match) {
      const pid = Number.parseInt(match[1], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The minimal PNG reader behind the blank-frame check
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Samples per pixel, by PNG colour type. Type 3 (palette) is absent on purpose — it needs PLTE. */
const CHANNELS_BY_COLOR_TYPE: Record<number, number | undefined> = {
  0: 1, // greyscale
  2: 3, // truecolour
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
};

/**
 * True when every pixel of `buf` is the same colour — the "the app has launched
 * but painted nothing yet" signal the readiness loop needs.
 *
 * FALSE IS THE SAFE ANSWER, and every unsupported shape returns it: a 16-bit
 * frame, an interlaced one, a palette image, a truncated file, an inflate
 * error. Saying "not uniform" only ever lets readiness proceed on a frame we
 * could not read, which the byte-identity condition still gates; saying
 * "uniform" on a frame we misread would BLOCK readiness for a perfectly good
 * app until the budget ran out. A wrong `not_testable` is more expensive than a
 * slightly early ready.
 *
 * Simulator screenshots are 8-bit non-interlaced RGBA, which is the shape this
 * reader supports; nothing else has ever needed to work.
 */
export function isUniformPng(buf: Buffer): boolean {
  try {
    return uniformPngInner(buf);
  } catch {
    return false;
  }
}

function uniformPngInner(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;

  let header: {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    compression: number;
    filter: number;
    interlace: number;
  } | null = null;
  const idat: Buffer[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) return false; // truncated chunk
    if (type === 'IHDR') {
      if (length < 13) return false;
      header = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        compression: buf[dataStart + 10],
        filter: buf[dataStart + 11],
        interlace: buf[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip the CRC
  }

  if (!header || idat.length === 0) return false;
  if (header.bitDepth !== 8) return false;
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) return false;
  if (header.width <= 0 || header.height <= 0) return false;
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (!channels) return false;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  if (raw.length < (stride + 1) * header.height) return false;

  const pixels = Buffer.alloc(stride * header.height);
  unfilterScanlines(raw, pixels, stride, channels, header.height);

  const pixelCount = header.width * header.height;
  const step = Math.max(1, Math.floor(pixelCount / UNIFORM_SAMPLE_BUDGET));
  for (let p = step; p < pixelCount; p += step) {
    if (!samePixel(pixels, p * channels, channels)) return false;
  }
  // The last pixel is always compared: a sampled sweep can stride straight past
  // the one differing pixel of an otherwise flat frame, and the bottom-right
  // corner is where a status bar or a home indicator first appears.
  return samePixel(pixels, (pixelCount - 1) * channels, channels);
}

/** True when the pixel at `at` equals pixel 0 (the reference). */
function samePixel(pixels: Buffer, at: number, channels: number): boolean {
  for (let c = 0; c < channels; c++) {
    if (pixels[at + c] !== pixels[c]) return false;
  }
  return true;
}

/**
 * Reverse PNG's per-scanline filters (RFC 2083 §6) in place into `out`. Each
 * scanline is one filter byte followed by `stride` bytes; Up/Average/Paeth all
 * read the RECONSTRUCTED previous line, which is why this writes into `out` and
 * reads its own earlier output rather than working on `raw`.
 */
function unfilterScanlines(
  raw: Buffer,
  out: Buffer,
  stride: number,
  bpp: number,
  height: number,
): void {
  let inPos = 0;
  let outPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos];
    inPos += 1;
    const prevPos = outPos - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[inPos + i];
      const a = i >= bpp ? out[outPos + i - bpp] : 0;
      const b = y > 0 ? out[prevPos + i] : 0;
      const c = i >= bpp && y > 0 ? out[prevPos + i - bpp] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filter}`);
      }
      out[outPos + i] = value & 0xff;
    }
    inPos += stride;
    outPos += stride;
  }
}

/** The Paeth predictor (RFC 2083 §6.6). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------
// mobile-screenshot / mobile-openurl
// ---------------------------------------------------------------------------

async function mobileScreenshot(
  name: string,
  udid: string,
  artifactsDir: string,
  deps: MobileDeps,
): Promise<number> {
  await deps.ensureDir(artifactsDir);
  const outPath = join(artifactsDir, name);
  const res = await deps.runTool(
    'xcrun',
    ['simctl', 'io', udid, 'screenshot', outPath],
    MOBILE_QUICK_TIMEOUT_MS,
  );
  if (res.code !== 0) {
    deps.stderr(`simctl screenshot exited ${res.code}: ${tail(res.stderr || res.stdout)}`);
    return MOBILE_EXIT_REFUSED;
  }
  deps.stdout(`ok: mobile screenshot ${name}`);
  return MOBILE_EXIT_OK;
}

/**
 * `mobile-openurl` — NAVIGATION through the OS URL handler, not driving. It
 * works on both drive arms on purpose: a deep link is how a `VERIFY_MOBILE_DRIVE
 * =none` host reaches a screen at all, so gating it behind the Maestro rung
 * would make the no-drive arm able to observe only the launch screen.
 */
async function mobileOpenUrl(url: string, udid: string, deps: MobileDeps): Promise<number> {
  const res = await deps.runTool(
    'xcrun',
    ['simctl', 'openurl', udid, url],
    MOBILE_QUICK_TIMEOUT_MS,
  );
  if (res.code !== 0) {
    deps.stderr(`simctl openurl exited ${res.code}: ${tail(res.stderr || res.stdout)}`);
    return MOBILE_EXIT_REFUSED;
  }
  deps.stdout(`ok: opened ${url}`);
  return MOBILE_EXIT_OK;
}

// ---------------------------------------------------------------------------
// The Maestro drive rung
// ---------------------------------------------------------------------------

/**
 * The five drive subcommands, all funnelled through ONE Maestro invocation
 * shape. Four of them generate a one-step flow; `mobile-flow` runs a file the
 * agent wrote. Both paths then take the identical argv, which is what makes the
 * pin invariant checkable in one place: no Maestro process is ever started
 * without `<pinFlag> $VERIFY_SIM_UDID`.
 *
 * The generated flows are kept under `$VERIFY_ARTIFACTS_DIR/maestro/` rather
 * than a temp dir the OS reclaims — they are the record of what was actually
 * driven, and a human reading a failed verification's artifacts should be able
 * to see the exact step.
 */
async function mobileDrive(
  command: Extract<MobileCommand, { sub: 'tap' | 'type' | 'swipe' | 'press' | 'flow' }>,
  env: NodeJS.ProcessEnv,
  udid: string,
  artifactsDir: string,
  deps: MobileDeps,
): Promise<number> {
  const bin = resolveMaestroBin(env);
  if (bin === null) {
    // Already checked by the caller's guard; repeated so this function is safe
    // to call directly and cannot be the hole in the invariant.
    deps.stderr(mobileDriveRefusal(env));
    return MOBILE_EXIT_REFUSED;
  }

  let flowPath: string;
  if (command.sub === 'flow') {
    const resolved = await resolveAgentFlowPath(command.flowPath, artifactsDir, deps);
    if (!resolved.ok) {
      deps.stderr(resolved.message);
      return MOBILE_EXIT_REFUSED;
    }
    flowPath = resolved.value;
  } else {
    const bundleIdVar = requireVar(env, 'VERIFY_APP_BUNDLE_ID');
    if (!bundleIdVar.ok) {
      deps.stderr(bundleIdVar.message);
      return MOBILE_EXIT_USAGE;
    }
    const dir = join(artifactsDir, MAESTRO_FLOW_DIR);
    await deps.ensureDir(dir);
    flowPath = join(dir, `${command.sub}-${deps.now()}.yaml`);
    await deps.writeTextFile(flowPath, maestroFlowYaml(bundleIdVar.value, command));
  }

  // Resolved per process, which is per command: the driver CLI runs exactly one
  // command and exits, so one `--help` probe can never be amortised across two
  // drive steps anyway.
  const pinFlag = await resolveMaestroPinFlag(bin, deps);
  if (pinFlag === null) {
    deps.stderr(
      `cannot pin Maestro to the leased simulator: ${bin} test --help advertises neither --udid nor --device, and an unpinned Maestro drives whichever device happens to be booted`,
    );
    return MOBILE_EXIT_REFUSED;
  }

  const argv = maestroTestArgs(pinFlag, udid, flowPath);
  const res = await deps.runTool(bin, argv, MAESTRO_TIMEOUT_MS);
  if (res.code !== 0) {
    deps.stderr(
      `maestro exited ${res.code} for ${flowPath}: ${tail(res.stderr || res.stdout)}`,
    );
    return MOBILE_EXIT_REFUSED;
  }
  deps.stdout(`ok: ${commandWord(command)} via ${flowPath}`);
  return MOBILE_EXIT_OK;
}

/**
 * The Maestro argv, pulled out so a test can pin the exact shape without a JVM.
 * The pin flag and the udid are ALWAYS positions 1-2 after `test`, before the
 * flow path — Maestro parses flags before the positional argument.
 */
export function maestroTestArgs(pinFlag: string, udid: string, flowPath: string): string[] {
  return ['test', pinFlag, udid, flowPath];
}

/**
 * Ask the installed Maestro which device-pinning flag it speaks.
 *
 * The flag has been renamed across Maestro versions (`--device` in the 1.x
 * line, `--udid` in 2.x), and a driver that guessed wrong would either fail
 * every drive step on an unknown-option error or — worse, on a Maestro that
 * ignores unknown flags — drive whatever device is booted. Reading `--help` is
 * the only answer that cannot drift. Both streams are read because CLIs split
 * help output between them, and the exit code is ignored for the same reason:
 * several argument parsers exit non-zero for `--help`.
 *
 * `null` means neither flag exists, which is a REFUSAL rather than a fallback —
 * see the module header's invariant 1.
 */
async function resolveMaestroPinFlag(bin: string, deps: MobileDeps): Promise<string | null> {
  let help = '';
  try {
    const res = await deps.runTool(bin, ['test', '--help'], MOBILE_QUICK_TIMEOUT_MS);
    help = `${res.stdout}\n${res.stderr}`;
  } catch {
    return null;
  }
  if (/(^|[\s,[(])--udid\b/.test(help)) return '--udid';
  if (/(^|[\s,[(])--device\b/.test(help)) return '--device';
  return null;
}

/**
 * Render a one-step Maestro flow. Every interpolated value goes through
 * {@link yamlScalar}, so a tap target containing a quote, a newline or a YAML
 * metacharacter becomes one scalar rather than extra flow steps — the YAML
 * equivalent of the argv-array rule this module follows everywhere else.
 */
export function maestroFlowYaml(
  bundleId: string,
  command: Extract<MobileCommand, { sub: 'tap' | 'type' | 'swipe' | 'press' }>,
): string {
  const header = `appId: ${yamlScalar(bundleId)}\n---\n`;
  switch (command.sub) {
    case 'tap':
      return `${header}- tapOn: ${yamlScalar(command.target)}\n`;
    case 'type':
      return `${header}- inputText: ${yamlScalar(command.text)}\n`;
    case 'swipe':
      return `${header}- swipe:\n    direction: ${command.direction.toUpperCase()}\n`;
    case 'press':
      return `${header}- pressKey: ${PRESS_KEY_NAMES[command.key]}\n`;
  }
}

/** `mobile-press` words → Maestro's `pressKey` names. */
const PRESS_KEY_NAMES: Record<PressKey, string> = {
  home: 'Home',
  back: 'Back',
  enter: 'Enter',
};

/**
 * A YAML double-quoted scalar. `JSON.stringify` emits exactly that subset —
 * double quotes, backslash escapes, `\n`, `\uXXXX` — all of which YAML 1.2
 * double-quoted scalars define identically.
 */
export function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Resolve an agent-authored flow file to an absolute path inside one of the two
 * roots it may live in: this request's artifacts dir, or the snapshot worktree
 * the driver was invoked from. Anything else is refused.
 *
 * The check is on the REALPATH, so `$VERIFY_ARTIFACTS_DIR/../../etc/flow.yaml`
 * and a symlink pointing at the developer's home directory are both caught by
 * the same comparison — the containment rule from `mobile-install`, applied to
 * the one other file path this family accepts from outside.
 */
export async function resolveAgentFlowPath(
  raw: string,
  artifactsDir: string,
  deps: MobileDeps,
): Promise<Resolved<string>> {
  const absolute = isAbsolute(raw) ? raw : join(deps.cwd(), raw);
  if ((await deps.pathKind(absolute)) === null) {
    return { ok: false, message: `flow file not found: ${raw}` };
  }
  let real: string;
  try {
    real = await deps.realpath(absolute);
  } catch (err) {
    return { ok: false, message: `could not resolve the flow file ${raw}: ${errorText(err)}` };
  }
  const roots: string[] = [];
  for (const root of [artifactsDir, deps.cwd()]) {
    try {
      roots.push(await deps.realpath(root));
    } catch {
      roots.push(root);
    }
  }
  const contained = roots.some((root) => real === root || real.startsWith(root + sep));
  if (!contained) {
    return {
      ok: false,
      message: `flow file ${raw} resolves to ${real}, which is outside both this request's artifacts dir (${roots[0]}) and the snapshot worktree (${roots[1]}) — write the flow into $VERIFY_ARTIFACTS_DIR`,
    };
  }
  return { ok: true, value: real };
}
