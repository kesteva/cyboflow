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
 */
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  /** Per-command bound. Defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
}

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

export class XcodeToolchainBackend {
  private readonly exec: AppleCliExec;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly logger?: LoggerLike;
  private readonly isExecutableFile: (absPath: string) => Promise<boolean>;
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

  constructor(deps: XcodeToolchainBackendDeps) {
    this.exec = deps.exec;
    this.platform = deps.platform ?? process.platform;
    this.homeDir = deps.homeDir ?? homedir();
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
    this.isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;
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
        const result = await this.run(maestroBin, ['test', '--help']);
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

  private run(command: string, args: readonly string[]): Promise<AppleCliExecResult> {
    return this.exec(command, args, { timeoutMs: this.timeoutMs });
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
      return this.inconclusive(
        `\`xcrun simctl list -j\` could not run: ${errorText(err)}`,
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
      };
    }

    return {
      status: 'ok',
      detail: `${xcodeLabel(xcodeVersion)}, newest iOS runtime ${target.runtimeName} (${target.deviceTypeName}). ${maestro.label}.`,
      xcodeVersion,
      newestRuntime: target.runtimeName,
      maestroBin: maestro.bin,
    };
  }

  private inconclusive(
    reason: string,
    maestro: { bin: string | null; label: string },
    xcodeVersion: string | null,
  ): XcodeToolchainProbe {
    this.logger?.info('[XcodeToolchainBackend] the toolchain probe could not answer', { reason });
    return {
      status: 'inconclusive',
      detail: `${xcodeLabel(xcodeVersion)}: the iOS toolchain probe could not answer — ${reason}. ${maestro.label}.`,
      xcodeVersion,
      newestRuntime: null,
      maestroBin: maestro.bin,
    };
  }

  /**
   * Resolve Maestro and describe it for `detail`. Wholly best-effort: the drive
   * rung is optional, so nothing here may turn into an inconclusive verdict for
   * the REQUIRED path.
   */
  private async describeMaestro(): Promise<{ bin: string | null; label: string }> {
    let bin: string | null = null;
    try {
      bin = await this.resolveMaestroBin();
    } catch (err) {
      this.logger?.info('[XcodeToolchainBackend] maestro resolution threw', { error: errorText(err) });
    }
    if (bin === null) return { bin: null, label: 'Maestro not found' };
    let version = 'unknown version';
    try {
      const result = await this.run(bin, ['--version']);
      const line = result.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (result.code === 0 && line.length > 0) version = line;
    } catch (err) {
      this.logger?.info('[XcodeToolchainBackend] maestro --version could not run', {
        error: errorText(err),
      });
    }
    return { bin, label: `Maestro ${version}` };
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
