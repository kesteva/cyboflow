/**
 * mobileComposition — the ONE place the `mobile` verification tier's host-facing
 * objects are built (docs/proposals/mobile-verification-tier.md §8, §8.2, T15).
 *
 * WHY A FACTORY AND NOT WIRING IN `verifyComposition.ts`. Three consumers need
 * the mobile toolchain answer — the scheduler's gate 1, the verification
 * runner's pre-deploy preflight, and the §6 health panel — and they must share
 * ONE probe instance, not three. The backend memoizes its verdict for 60 s and
 * its Maestro resolution for the process; three instances would spawn three
 * `simctl list` sweeps per panel open and could disagree about whether the drive
 * rung exists, which is precisely the divergence between "what the gate allowed"
 * and "what the driver can do" that the single-resolution rule exists to
 * prevent. Composing them here, once, also puts the DARWIN GATE in one place
 * instead of three, and puts it under test — `verifyComposition.ts` boots
 * Electron and cannot be imported by a unit test.
 *
 * THE OFF-DARWIN CONTRACT is the load-bearing half of this module:
 *  - nothing is constructed: no toolchain backend, no simulator session factory,
 *    and therefore no possibility of an `xcrun` spawn on a machine that has no
 *    `xcrun` (T15: "Nothing off darwin constructs a simulator or spawns xcrun");
 *  - {@link MobileComposition.probe} resolves `false` WITHOUT spawning. Gate 1
 *    fails CLOSED, so `false` is the correct answer and a spawn would only be a
 *    slower way to reach it;
 *  - {@link MobileComposition.probeRow} reports `'inconclusive'`, NEVER
 *    `'missing'`, with `fix: null`. This is the health panel's own fail-open
 *    rule (§10): the app can install neither Xcode nor Maestro, so there is no
 *    action to offer, and "missing" would read as an instruction to go install
 *    an iOS toolchain on a machine that cannot host one;
 *  - {@link MobileComposition.sweepAtBoot} is a no-op.
 *
 * Nothing in this file mentions mcpbridge: the Xcode MCP grant is Stage 3 design
 * (§11), not built, and the Stage 1 tier runs on Apple's own command-line tools.
 */
import { execFile } from 'node:child_process';
import type { LoggerLike } from '../../orchestrator/types';
import {
  createMobileSimulatorSessionFactory,
  type AppleCliExec,
  type AppleCliExecResult,
  type MobileSimulatorSessionFactory,
} from '../../orchestrator/verify/mobileSimulatorSession';
import { XcodeToolchainBackend } from './xcodeToolchainBackend';
import type { VerifyProbeRow } from '../../../../shared/types/visualVerification';

/** Per-command bound for the default host exec. Matches both consumers' own defaults. */
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;

/** Bound on one command's captured output, so a pathological `simctl list` cannot pin memory. */
const MAX_EXEC_BUFFER_BYTES = 32 * 1024 * 1024;

/** Injection points. Everything but `dataDir` defaults to the real host. */
export interface MobileCompositionDeps {
  /** The cyboflow data dir this instance owns — `verify-mobile/` lives under it (§8.2). */
  dataDir: string;
  platform?: NodeJS.Platform;
  /** The Apple-CLI transport. Defaults to {@link createHostAppleCliExec}. */
  exec?: AppleCliExec;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: LoggerLike;
}

/** What the composition root injects into the scheduler, the runner and the tRPC context. */
export interface MobileComposition {
  /**
   * The shared toolchain backend, or `null` off darwin. The runner takes this
   * instance (not a fresh one) so `resolveMaestroBin()`'s process-lifetime memo
   * is the SAME value the probe reported and the same one exported as
   * `VERIFY_MAESTRO_BIN`.
   */
  toolchain: XcodeToolchainBackend | null;
  /** The per-request simulator session factory, or `null` off darwin. */
  session: MobileSimulatorSessionFactory | null;
  /**
   * Gate 1 / preflight boolean. ONE instance is injected into the scheduler deps,
   * the runner's preflight deps and nothing else re-derives it.
   *
   * Never throws: `XcodeToolchainBackend.healthCheck` already folds an
   * unanswerable probe to `false`, and the scheduler's own gate treats a throw
   * as incapable anyway — so the two layers agree without either depending on
   * the other's error handling.
   */
  probe: () => Promise<boolean>;
  /** The §6 health-panel row. Never throws; `fix` is always `null`. */
  probeRow: () => Promise<VerifyProbeRow>;
  /** The §8.2 boot sweep. Fire-and-forget: logs its result and NEVER throws. */
  sweepAtBoot: () => Promise<void>;
}

/**
 * The real-host {@link AppleCliExec}.
 *
 * Honours the transport contract exactly: a command that RAN resolves whatever
 * its exit code (a non-zero exit is the tool answering "no", which is data), and
 * a command that could not run at all — spawn failure, timeout, killed — REJECTS.
 * `execFile` reports both through the same error object, so the resolve branch is
 * selected on `err.code` being a number, which is what a plain non-zero exit
 * gives; an ENOENT/ETIMEDOUT/signal kill carries a string code or none and falls
 * through to the rejection.
 *
 * ARGV-ONLY, never a shell: every argument here is host-derived (a resolved
 * Maestro path, a udid, a device-type identifier) and a shell would make any of
 * them injectable.
 */
export function createHostAppleCliExec(defaultTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS): AppleCliExec {
  return (command, args, opts) =>
    new Promise<AppleCliExecResult>((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          timeout: opts?.timeoutMs ?? defaultTimeoutMs,
          maxBuffer: MAX_EXEC_BUFFER_BYTES,
          ...(opts?.env ? { env: opts.env } : {}),
          // No `shell` key at all — the default is false, and it stays that way.
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ stdout, stderr, code: 0 });
            return;
          }
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code === 'number') {
            // The tool ran and exited non-zero: evidence, not an exception.
            resolve({ stdout, stderr, code });
            return;
          }
          reject(err);
        },
      );
    });
}

/**
 * Build the mobile tier's host objects once, darwin-gated.
 *
 * Call this EXACTLY ONCE per process, from the composition root, and inject the
 * result — re-calling it would defeat every memo the module exists to share.
 */
export function composeMobileVerification(deps: MobileCompositionDeps): MobileComposition {
  const platform = deps.platform ?? process.platform;
  const logger = deps.logger;

  if (platform !== 'darwin') {
    return {
      toolchain: null,
      session: null,
      // Resolves without touching the host: see the off-darwin contract above.
      probe: async () => false,
      probeRow: async () => ({
        id: 'mobile-simulator',
        state: 'inconclusive',
        detail: 'iOS Simulator verification requires macOS; this host is not macOS',
        fix: null,
      }),
      sweepAtBoot: async () => {},
    };
  }

  const exec = deps.exec ?? createHostAppleCliExec();
  const toolchain = new XcodeToolchainBackend({
    exec,
    platform,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(logger !== undefined ? { logger } : {}),
  });
  const session = createMobileSimulatorSessionFactory({
    exec,
    platform,
    ...(logger !== undefined ? { logger } : {}),
  });

  return {
    toolchain,
    session,
    probe: () => toolchain.healthCheck(),
    probeRow: async () => {
      const probe = await toolchain.probeDetail();
      return {
        id: 'mobile-simulator',
        // `absent` is the ONLY state that becomes `missing`: the host answered,
        // and the answer was no. `inconclusive` stays inconclusive — a probe
        // that could not ask is not evidence of an absent Xcode.
        state: probe.status === 'ok' ? 'ok' : probe.status === 'absent' ? 'missing' : 'inconclusive',
        // The backend's own sentence already names the Xcode version, the newest
        // runtime and the Maestro state; restating them here would let the panel
        // and the preflight evidence line drift apart.
        detail: probe.detail,
        // Always null, in every state. Installing Xcode or Maestro is not
        // something this app can do, and a fix-it button that opened a download
        // page would be a fix in name only.
        fix: null,
      };
    },
    sweepAtBoot: async () => {
      try {
        const result = await session.sweepStaleSimulators({ dataDir: deps.dataDir });
        // Logged at info even when it reclaimed nothing: the interesting line is
        // the `skipped` one — a device left alone because another live instance
        // may own it (§8.2) is the case a user would otherwise see as a leak.
        logger?.info?.('[mobileComposition] boot sweep complete', {
          deleted: result.deleted.length,
          skipped: result.skipped,
        });
      } catch (err) {
        // A sweep is best-effort reclamation, never a boot precondition: a
        // simulator left behind costs disk, while a throw here would take the
        // app's boot with it.
        logger?.warn?.('[mobileComposition] boot sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
