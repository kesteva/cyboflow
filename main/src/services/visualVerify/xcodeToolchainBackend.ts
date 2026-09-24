/**
 * XcodeToolchainBackend — the HOST PROBE behind the `mobile` verification
 * modality (docs/proposals/mobile-verification-tier.md §5, §8).
 *
 * The mobile tier is iOS Simulator driven by Apple's OWN toolchain —
 * `xcodebuild` to build, `xcrun simctl` to create/boot/install/launch — with no
 * third-party dependency anywhere on the required path. Maestro is an OPTIONAL
 * DRIVE RUNG: without it a mobile verification still builds, installs, launches
 * and screenshots; with it, taps and typing become available too. This class is
 * the one place that asks the host which of those it can actually do.
 *
 * SHAPED AFTER {@link PeekabooBackend}, deliberately: a host-probe backend with
 * an INJECTED exec seam, no `electron` / `better-sqlite3` import, and a
 * healthCheck that NEVER throws. The mobile tier's gate-1 refusal has to be a
 * clean SKIP with an actionable reason — a missing Xcode must never wedge a
 * sprint, and a probe that could not ask must never be reported as a host that
 * said no.
 *
 * THE THREE-WAY VERDICT is the whole point of {@link XcodeToolchainBackend.probeDetail}:
 *  - `ok`          — Xcode answers, an iOS runtime is available, and a compatible
 *                    iPhone device type exists for it.
 *  - `absent`      — one of those three facts is AFFIRMATIVELY false. The host
 *                    answered; the answer was no. Only this justifies telling a
 *                    user to install something.
 *  - `inconclusive`— a probe command threw or timed out. NOTHING is known, and
 *                    reporting `absent` here is the specific bug this split
 *                    exists to prevent (it sends a user to reinstall an Xcode
 *                    they already have).
 *
 * THE INTERSECTION RULE lives in {@link resolveSimTarget} (mobileSimulatorSession.ts)
 * and this probe reuses it verbatim, so the gate and the acquire can never
 * disagree about what "a compatible iPhone" means: a naive newest-first pick out
 * of the flat `devicetypes` list yields `iPhone-6s-Plus`, which `simctl create`
 * rejects against iOS 26.2 with `Incompatible device`. Nothing here hardcodes a
 * product name — "iPhone 17 Pro" is not a stable string.
 *
 * B6 — MAESTRO `JAVA_HOME` (docs/proposals/runbook-optional-verification.md
 * §B6). MEASURED on this host: the harness login shell resolves `java` to the
 * macOS stub `/usr/bin/java` ("Unable to locate a Java Runtime"), so `maestro
 * test --help` fails there and the drive rung silently becomes `none` — with
 * `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
 * set it works and `--udid` resolves. {@link XcodeToolchainBackend.resolveJavaHome}
 * finds a JDK home (a valid `JAVA_HOME` already in the env, then
 * `/usr/libexec/java_home`, then the newest Homebrew `openjdk*` formula), and
 * every Maestro invocation this class makes runs with `JAVA_HOME` set to it
 * and its `bin` prefixed onto `PATH` — see {@link XcodeToolchainBackend.runMaestro}.
 */
import { access, readdir, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { LoggerLike } from '../../orchestrator/types';
import {
  resolveSimTarget,
  type AppleCliExec,
  type AppleCliExecResult,
  type ResolvedSimTarget,
} from '../../orchestrator/verify/mobileSimulatorSession';

export type { AppleCliExec, AppleCliExecResult };

/** How long one probe verdict is reused before the host is asked again. */
const PROBE_TTL_MS = 60_000;

/** Per-command bound. Every invocation this class makes carries one. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Maestro lookup order. Env override first (an explicitly configured binary
 * always wins), then the two install locations Maestro's own installer and
 * Homebrew use, then PATH.
 *
 * WHY A PATH AND NOT A BARE NAME: the verification agent runs with a harness
 * PATH that is NOT the user's login shell PATH, so a bare `maestro` that works
 * in a terminal resolves to nothing there. Resolving to one ABSOLUTE path here,
 * once, and handing that to both the health probe and the driver is what keeps
 * the gate's answer and the driver's behaviour from diverging.
 */
const MAESTRO_ENV_VAR = 'VERIFY_MAESTRO_BIN';

/** The full toolchain verdict: one gate boolean and the evidence behind it. */
export interface XcodeToolchainProbe {
  status: 'ok' | 'absent' | 'inconclusive';
  /** One human sentence: the Xcode version, the newest runtime, and the Maestro state. */
  detail: string;
  /** e.g. `26.2`, parsed from `xcodebuild -version`. `null` when it could not be read. */
  xcodeVersion: string | null;
  /** e.g. `iOS 26.2` — the newest AVAILABLE iOS runtime. `null` when none resolved. */
  newestRuntime: string | null;
  /** The resolved absolute Maestro path, or `null` — the optional drive rung. */
  maestroBin: string | null;
  /**
   * The JDK home Maestro was (or would be) run under, per B6 — `null` when
   * `maestroBin` is `null` (nothing to run) or when none of the four rungs in
   * {@link XcodeToolchainBackend.resolveJavaHome} answered.
   */
  javaHome: string | null;
}

/** The flag `maestro test` uses to pin a target device, as parsed from its own `--help`. */
export type MaestroPinFlag = '--udid' | '--device';

/** Construction-time deps. Only `exec` is required; the rest default to the real host. */
export interface XcodeToolchainBackendDeps {
  exec: AppleCliExec;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  logger?: LoggerLike;
  /**
   * Whether an absolute path is an existing EXECUTABLE FILE. Defaults to an
   * `fs.access(X_OK)` + `stat().isFile()` pair. Injected so the Maestro
   * resolution order is testable without planting real binaries — and so a
   * DIRECTORY named `maestro` can never be handed to the driver as a binary.
   */
  isExecutableFile?: (absPath: string) => Promise<boolean>;
  /**
   * Whether an absolute path is an existing DIRECTORY. Defaults to
   * `fs.stat().isDirectory()`. Injected for the same reason as
   * {@link isExecutableFile}: {@link XcodeToolchainBackend.resolveJavaHome}'s
   * `/usr/libexec/java_home` and Homebrew rungs (B6) must be testable without
   * a real JDK on the CI host.
   */
  isDirectory?: (absPath: string) => Promise<boolean>;
  /**
   * List a directory's entries by bare name, or throw when it does not exist
   * (matches `fs.readdir`'s contract; defaults to it). Injected so the
   * `openjdk*` Homebrew glob in {@link XcodeToolchainBackend.resolveJavaHome}
   * (B6) never touches a real `/opt/homebrew/opt` or `/usr/local/opt`.
   */
  readdir?: (dirPath: string) => Promise<string[]>;
  /** Per-command bound. Defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
}

/** Appended when `simctl` cannot answer: the usual cause is a pending Xcode first-launch install. */
export const SIMCTL_FIRST_LAUNCH_HINT =
  ' (a simctl that never answers usually means Xcode has not finished its first-launch component install — run `sudo xcodebuild -runFirstLaunch` once, or open Xcode and accept the components prompt)';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse the version out of `xcodebuild -version`, whose first line is
 * `Xcode 26.2`. Returns `null` for anything it does not recognise rather than
 * guessing — an unparseable version is cosmetic (it only reaches `detail`), so
 * it must not be allowed to decide the verdict.
 */
export function parseXcodeVersion(stdout: string): string | null {
  const match = /^\s*Xcode\s+([0-9][0-9.]*)/im.exec(stdout);
  return match ? (match[1] as string) : null;
}

/**
 * Pick the device-pin flag out of `maestro test --help`.
 *
 * `--udid` is preferred because it names exactly one device; `--device` is the
 * older spelling and, on some versions, matches by name (ambiguous across two
 * simulators built from the same device type — which is precisely the
 * concurrent-lane case). NEITHER present ⇒ `null`, and the driver must then
 * REFUSE to drive rather than run an unpinned `maestro test` that would land on
 * whichever simulator happened to be booted.
 */
export function parseMaestroPinFlag(helpText: string): MaestroPinFlag | null {
  if (/--udid\b/.test(helpText)) return '--udid';
  if (/--device\b/.test(helpText)) return '--device';
  return null;
}

/**
 * Sort key for one `openjdk*` Homebrew formula directory name (B6). The bare
 * `openjdk` formula (no `@N`) always tracks Homebrew's current release, so it
 * outranks every pinned `openjdk@N`; among pinned formulas the higher `N`
 * wins. Anything that is not an `openjdk` formula name at all sorts lowest —
 * callers filter those out before this ever runs, so this is a fallback, not
 * the filter.
 */
export function parseOpenjdkVersion(name: string): number {
  if (name === 'openjdk') return Number.POSITIVE_INFINITY;
  const match = /^openjdk@([0-9]+(?:\.[0-9]+)?)$/.exec(name);
  return match ? Number.parseFloat(match[1] as string) : -1;
}

/** The default executable-file test: it must exist, be a regular file, and carry +x. */
async function defaultIsExecutableFile(absPath: string): Promise<boolean> {
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return false;
    await access(absPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The default directory test, backing {@link XcodeToolchainBackendDeps.isDirectory}. */
async function defaultIsDirectory(absPath: string): Promise<boolean> {
  try {
    const info = await stat(absPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** The default directory listing, backing {@link XcodeToolchainBackendDeps.readdir}. */
async function defaultReaddir(dirPath: string): Promise<string[]> {
  return readdir(dirPath);
}

export class XcodeToolchainBackend {
  private readonly exec: AppleCliExec;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly logger?: LoggerLike;
  private readonly isExecutableFile: (absPath: string) => Promise<boolean>;
  private readonly isDirectory: (absPath: string) => Promise<boolean>;
  private readonly readdir: (dirPath: string) => Promise<string[]>;
  private readonly timeoutMs: number;

  /** The 60 s memo: a settled verdict plus when it settled. */
  private cached: { at: number; probe: XcodeToolchainProbe } | null = null;
  /** Concurrent callers share ONE probe rather than racing several `simctl list` spawns. */
  private inFlight: Promise<XcodeToolchainProbe> | null = null;

  /**
   * Maestro resolution is memoized for the PROCESS, not for 60 s: it answers
   * "where is this binary", and a binary that moves mid-session is not a case
   * worth re-spawning `which` for on every request.
   */
  private maestroMemo: Promise<string | null> | null = null;
  private readonly pinFlagMemo = new Map<string, Promise<MaestroPinFlag | null>>();

  /**
   * The B6 JDK-home memo: process-lifetime, same rationale as
   * {@link maestroMemo} — {@link resolveJavaHome} answers "where is the JDK",
   * not something worth re-probing (a `java_home` spawn plus two `readdir`s)
   * on every Maestro invocation.
   */
  private javaHomeMemo: Promise<string | null> | null = null;

  constructor(deps: XcodeToolchainBackendDeps) {
    this.exec = deps.exec;
    this.platform = deps.platform ?? process.platform;
    this.homeDir = deps.homeDir ?? homedir();
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
    this.isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;
    this.isDirectory = deps.isDirectory ?? defaultIsDirectory;
    this.readdir = deps.readdir ?? defaultReaddir;
    this.timeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /**
   * The gate: can this host run a mobile verification at all? Folds the
   * three-way verdict to one boolean — `absent` AND `inconclusive` both collapse
   * to `false`, exactly as `PeekabooBackend.healthCheck` collapses an
   * unanswerable TCC probe. Proceeding on an unverified toolchain would burn a
   * lease and ten minutes of build before failing; a skip is recoverable where a
   * wedge is not. NEVER throws.
   */
  async healthCheck(): Promise<boolean> {
    return (await this.probeDetail()).status === 'ok';
  }

  /**
   * The reporting surface (the §6 health panel row, and the preflight evidence
   * line). Memoized for 60 s against the injected clock, and shared between
   * concurrent callers. NEVER throws.
   */
  async probeDetail(): Promise<XcodeToolchainProbe> {
    const cached = this.cached;
    if (cached !== null && this.now() - cached.at < PROBE_TTL_MS) return cached.probe;
    if (this.inFlight !== null) return this.inFlight;

    const attempt = this.computeProbe()
      .then((probe) => {
        this.cached = { at: this.now(), probe };
        return probe;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * Resolve the Maestro binary to ONE ABSOLUTE PATH, or `null`.
   *
   * Never a bare name (see {@link MAESTRO_ENV_VAR}'s note), never a directory,
   * never a path that is not executable. This is the single source both this
   * probe's `detail` and the mobile driver's tap/type rung read, so they cannot
   * disagree about whether the drive rung is available.
   */
  async resolveMaestroBin(): Promise<string | null> {
    if (this.maestroMemo === null) this.maestroMemo = this.computeMaestroBin();
    return this.maestroMemo;
  }

  /**
   * Which flag this Maestro build uses to pin a device, per its OWN `--help`.
   * Memoized per binary. `null` means neither flag exists and the driver must
   * refuse to drive — see {@link parseMaestroPinFlag}.
   */
  async resolvePinFlag(maestroBin: string): Promise<MaestroPinFlag | null> {
    const memo = this.pinFlagMemo.get(maestroBin);
    if (memo !== undefined) return memo;
    const attempt = (async (): Promise<MaestroPinFlag | null> => {
      try {
        const result = await this.runMaestro(maestroBin, ['test', '--help']);
        // `--help` exits non-zero on some builds while still printing usage, so
        // the TEXT decides, not the exit code.
        return parseMaestroPinFlag(`${result.stdout}\n${result.stderr}`);
      } catch (err) {
        this.logger?.info('[XcodeToolchainBackend] could not read maestro test --help', {
          maestroBin,
          error: errorText(err),
        });
        return null;
      }
    })();
    this.pinFlagMemo.set(maestroBin, attempt);
    return attempt;
  }

  /**
   * B6: resolve a JDK home Maestro can run under. See the class-header "B6 —
   * MAESTRO JAVA_HOME" note for the measured failure and the four-rung order;
   * exposed publicly (not just used internally by {@link runMaestro}) so a
   * caller that exports env into an agent process — the mobile verification
   * runner — can read the SAME resolved value this backend used to run
   * Maestro's own health probes, rather than re-deriving it and risking the
   * two disagreeing.
   */
  async resolveJavaHome(): Promise<string | null> {
    if (this.javaHomeMemo === null) this.javaHomeMemo = this.computeJavaHome();
    return this.javaHomeMemo;
  }

  private run(command: string, args: readonly string[]): Promise<AppleCliExecResult> {
    return this.exec(command, args, { timeoutMs: this.timeoutMs });
  }

  /**
   * Run a resolved Maestro binary with {@link resolveJavaHome}'s answer
   * threaded into its environment (B6): `JAVA_HOME` set, and `PATH` prefixed
   * with `$JAVA_HOME/bin` so Maestro's own launcher finds that `java` before
   * whatever the login shell would otherwise have resolved (the measured
   * failure: the macOS `/usr/bin/java` stub). A `null` JAVA_HOME runs Maestro
   * unchanged — the pre-B6 behaviour — rather than inventing a path.
   *
   * THE CHILD'S BASE ENV IS `process.env`, NOT `this.env`. `this.env` is this
   * class's LOOKUP environment (`VERIFY_MAESTRO_BIN`, rung 1's `JAVA_HOME`),
   * and callers narrow it on purpose — mobileVerification.itest.ts injects `{}`
   * so a developer's own variables cannot leak into resolution. The child, by
   * contrast, would otherwise inherit `process.env` from the transport
   * (`createHostAppleCliExec` forwards `env` only when one is given), so that
   * is what gets extended:
   * building the override from a narrowed `this.env` would strip `HOME`,
   * `TMPDIR` and `PATH` out from under Maestro the moment the transport starts
   * honouring `env`. The full env (not a delta) is passed so the answer is the
   * same whether a transport REPLACES its child env with `opts.env` or merges it.
   */
  private async runMaestro(maestroBin: string, args: readonly string[]): Promise<AppleCliExecResult> {
    const javaHome = await this.resolveJavaHome();
    const opts: NonNullable<Parameters<AppleCliExec>[2]> = { timeoutMs: this.timeoutMs };
    if (javaHome !== null) {
      const inherited = process.env;
      const javaBin = join(javaHome, 'bin');
      opts.env = {
        ...inherited,
        JAVA_HOME: javaHome,
        PATH: inherited.PATH ? `${javaBin}${delimiter}${inherited.PATH}` : javaBin,
      };
    }
    return this.exec(maestroBin, args, opts);
  }

  private async computeProbe(): Promise<XcodeToolchainProbe> {
    // Off darwin there is no iOS Simulator and nothing to ask, so spawn
    // NOTHING: a probe on a Linux CI box must cost zero processes.
    if (this.platform !== 'darwin') {
      return {
        status: 'absent',
        detail: `the iOS Simulator toolchain requires macOS; this host reports platform "${this.platform}". Maestro not found.`,
        xcodeVersion: null,
        newestRuntime: null,
        maestroBin: null,
        javaHome: null,
      };
    }

    const maestro = await this.describeMaestro();

    // FACT 1 — Xcode's command-line tools answer at all.
    let xcodebuild: AppleCliExecResult;
    try {
      xcodebuild = await this.run('xcodebuild', ['-version']);
    } catch (err) {
      return this.inconclusive(`\`xcodebuild -version\` could not run: ${errorText(err)}`, maestro, null);
    }
    if (xcodebuild.code !== 0) {
      return {
        status: 'absent',
        detail: `Xcode command-line tools unavailable: \`xcodebuild -version\` exited ${
          xcodebuild.code ?? 'null'
        }${trimForDetail(xcodebuild.stderr)}. ${maestro.label}.`,
        xcodeVersion: null,
        newestRuntime: null,
        maestroBin: maestro.bin,
        javaHome: maestro.javaHome,
      };
    }
    const xcodeVersion = parseXcodeVersion(xcodebuild.stdout);

    // FACTS 2 + 3 — an available iOS runtime, and an iPhone device type
    // COMPATIBLE with it. One `simctl list -j` answers both, and
    // `resolveSimTarget` is the same resolver the acquire path uses.
    let listed: AppleCliExecResult;
    try {
      listed = await this.run('xcrun', ['simctl', 'list', '-j']);
    } catch (err) {
      // Observed 2026-09-17 on the reference host right after an Xcode major
      // upgrade: `simctl` is a wrapper script that, when CoreSimulator is older
      // than the Xcode it ships with, runs `xcodebuild -runFirstLaunch` (an
      // admin-privileged component install) BEFORE answering — and blocks there
      // indefinitely from a non-interactive process. It surfaces here as a
      // timeout, so the one actionable cause is named rather than guessed.
      return this.inconclusive(
        `\`xcrun simctl list -j\` could not run: ${errorText(err)}${SIMCTL_FIRST_LAUNCH_HINT}`,
        maestro,
        xcodeVersion,
      );
    }
    if (listed.code !== 0) {
      // The tool ran but refused to answer. That says nothing about whether
      // runtimes exist, so it is inconclusive, not absent.
      return this.inconclusive(
        `\`xcrun simctl list -j\` exited ${listed.code ?? 'null'}${trimForDetail(listed.stderr)}`,
        maestro,
        xcodeVersion,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.stdout);
    } catch (err) {
      return this.inconclusive(
        `\`xcrun simctl list -j\` produced unreadable JSON: ${errorText(err)}`,
        maestro,
        xcodeVersion,
      );
    }

    let target: ResolvedSimTarget;
    try {
      target = resolveSimTarget(parsed);
    } catch (err) {
      // resolveSimTarget throws ONLY on affirmative absence — no available iOS
      // runtime, or no compatible iPhone for the one it picked. Its message
      // already names which, which is exactly what `absent` owes the user.
      return {
        status: 'absent',
        detail: `${xcodeLabel(xcodeVersion)}, but ${errorText(err)}. ${maestro.label}.`,
        xcodeVersion,
        newestRuntime: null,
        maestroBin: maestro.bin,
        javaHome: maestro.javaHome,
      };
    }

    return {
      status: 'ok',
      detail: `${xcodeLabel(xcodeVersion)}, newest iOS runtime ${target.runtimeName} (${target.deviceTypeName}). ${maestro.label}.`,
      xcodeVersion,
      newestRuntime: target.runtimeName,
      maestroBin: maestro.bin,
      javaHome: maestro.javaHome,
    };
  }

  private inconclusive(
    reason: string,
    maestro: { bin: string | null; label: string; javaHome: string | null },
    xcodeVersion: string | null,
  ): XcodeToolchainProbe {
    this.logger?.info('[XcodeToolchainBackend] the toolchain probe could not answer', { reason });
    return {
      status: 'inconclusive',
      detail: `${xcodeLabel(xcodeVersion)}: the iOS toolchain probe could not answer — ${reason}. ${maestro.label}.`,
      xcodeVersion,
      newestRuntime: null,
      maestroBin: maestro.bin,
      javaHome: maestro.javaHome,
    };
  }

  /**
   * Resolve Maestro and describe it for `detail`. Wholly best-effort: the drive
   * rung is optional, so nothing here may turn into an inconclusive verdict for
   * the REQUIRED path.
   */
  private async describeMaestro(): Promise<{ bin: string | null; label: string; javaHome: string | null }> {
    let bin: string | null = null;
    try {
      bin = await this.resolveMaestroBin();
    } catch (err) {
      this.logger?.info('[XcodeToolchainBackend] maestro resolution threw', { error: errorText(err) });
    }
    if (bin === null) return { bin: null, label: 'Maestro not found', javaHome: null };

    // B6: resolve before `--version` so that call itself already runs under
    // the right JAVA_HOME — the login-shell `java` stub can make even
    // `maestro --version` fail, not just `test --help`.
    const javaHome = await this.resolveJavaHome();
    let version = 'unknown version';
    try {
      const result = await this.runMaestro(bin, ['--version']);
      const line = result.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (result.code === 0 && line.length > 0) version = line;
    } catch (err) {
      this.logger?.info('[XcodeToolchainBackend] maestro --version could not run', {
        error: errorText(err),
      });
    }
    return {
      bin,
      label: `Maestro ${version}${javaHome === null ? ' (no JAVA_HOME resolved)' : ''}`,
      javaHome,
    };
  }

  private async computeJavaHome(): Promise<string | null> {
    // The drive rung is iOS-Simulator-only, so off darwin there is nothing to
    // resolve and nothing to spawn — same posture as computeMaestroBin.
    if (this.platform !== 'darwin') return null;

    // Rung 1: an existing JAVA_HOME, but only if it actually names a JDK —
    // trusting the variable just because it is SET would repeat the exact bug
    // this method exists to fix (a stale or wrong JAVA_HOME left in the env).
    const fromEnv = this.env.JAVA_HOME;
    if (
      typeof fromEnv === 'string' &&
      fromEnv.length > 0 &&
      (await this.isExecutableFile(join(fromEnv, 'bin', 'java')))
    ) {
      return fromEnv;
    }

    // Rung 2: the platform's own JDK locator.
    try {
      const result = await this.run('/usr/libexec/java_home', []);
      const candidate = result.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (result.code === 0 && candidate.length > 0 && (await this.isDirectory(candidate))) {
        return candidate;
      }
    } catch (err) {
      this.logger?.info('[XcodeToolchainBackend] `/usr/libexec/java_home` could not run', {
        error: errorText(err),
      });
    }

    // Rungs 3 and 4: the newest Homebrew `openjdk*` formula, Apple Silicon
    // prefix before Intel — a host with both installed is expected to prefer
    // the one matching its own architecture, and Apple Silicon is checked
    // first because that is this backend's primary target.
    for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
      const home = await this.newestOpenjdkHome(prefix);
      if (home !== null) return home;
    }
    return null;
  }

  /**
   * The newest `openjdk*` Homebrew formula's JDK home directly under `prefix`
   * (e.g. `/opt/homebrew/opt`), or `null` when none is installed there.
   * "Newest" is decided by {@link parseOpenjdkVersion}. A `readdir` failure
   * (ENOENT — this Homebrew prefix is not installed at all, the common case on
   * either architecture) is swallowed rather than logged: it is the expected
   * outcome on most hosts, not evidence of anything wrong.
   */
  private async newestOpenjdkHome(prefix: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await this.readdir(prefix);
    } catch {
      return null;
    }
    const candidates = entries
      .filter((name) => name === 'openjdk' || name.startsWith('openjdk@'))
      .sort((a, b) => parseOpenjdkVersion(b) - parseOpenjdkVersion(a));
    for (const name of candidates) {
      const home = join(prefix, name, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
      if (await this.isDirectory(home)) return home;
    }
    return null;
  }

  private async computeMaestroBin(): Promise<string | null> {
    // The drive rung is iOS-Simulator-only here, so off darwin there is nothing
    // to resolve and nothing to spawn.
    if (this.platform !== 'darwin') return null;

    const candidates = [
      this.env[MAESTRO_ENV_VAR],
      join(this.homeDir, '.maestro', 'bin', 'maestro'),
      '/opt/homebrew/bin/maestro',
      '/usr/local/bin/maestro',
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      if (await this.isExecutableFile(candidate)) return candidate;
    }

    // PATH last. `which` may print a relative path or nothing at all, so the
    // result is held to the same bar as every hardcoded candidate: absolute,
    // and an executable file.
    try {
      const result = await this.run('which', ['maestro']);
      const first = result.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (result.code === 0 && first.startsWith('/') && (await this.isExecutableFile(first))) {
        return first;
      }
    } catch (err) {
      this.logger?.info('[XcodeToolchainBackend] `which maestro` could not run', {
        error: errorText(err),
      });
    }
    return null;
  }
}

function xcodeLabel(version: string | null): string {
  return version === null ? 'Xcode (version unreadable)' : `Xcode ${version}`;
}

/** Fold a command's stderr into one bounded clause, or nothing when it said nothing. */
function trimForDetail(stderr: string): string {
  const trimmed = stderr.trim().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? '' : `: ${trimmed.slice(0, 200)}`;
}
