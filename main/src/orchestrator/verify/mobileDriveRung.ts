/**
 * mobileDriveRung — the verification runner's mobile-arm drive decision,
 * pulled out of verificationAgentRunner.ts (docs/proposals/runbook-optional-verification.md
 * §B3, §B4, §B6).
 *
 * Three steps, called by the runner in this order inside its try block:
 *
 *  1. {@link planXcodeIntent} — BEFORE the simulator is acquired: read the
 *     live `mobileDriveEngine` knob and the §B2 probe, and decide whether to
 *     ATTEMPT the xcode rung (`driveEngineSelection.intendXcode`).
 *  2. {@link acquireMobileSimulator} — `session.acquire`, with
 *     `minRuntimeMajor: 27` when xcode is intended (DeviceInteraction refuses
 *     an older runtime). A host whose newest runtime is older gets ONE retry
 *     without the floor and a recorded `xcode-unavailable` degrade: degrade,
 *     never skip.
 *  3. {@link buildMobileDriveEnv} — open the xcode session when intended,
 *     resolve Maestro (with its device-pin flag and, B6, its JAVA_HOME), settle
 *     the final rung (`finalizeDriveEngine`), and build the §5.1 mobile env
 *     from it: `VERIFY_MOBILE_DRIVE` is set from the rung that was actually
 *     exported, and nothing else. The drive coercion downstream keys strictly
 *     on that rung being `'none'` — an xcode run does NOT coerce
 *     `requiresDrive`, a degraded-to-none one does.
 *
 * The decision also becomes an ADVISORY preflight row (`'xcode-mcp'`, always
 * `ok: true`): a degraded rung is a fact about how the request ran, never a
 * reason to skip it, but it must survive into `preflight_json` for requests
 * that end with no report.
 */
import type { LoggerLike } from '../types';
import type { MobileAppSpec, MobileDriveEngine } from '../../../../shared/types/visualVerification';
import { DEFAULT_MOBILE_PRODUCT_GLOB } from '../../../../shared/types/visualVerification';
import {
  MIN_RUNTIME_UNSATISFIED_PREFIX,
  type AcquireSimulatorArgs,
  type MobileSimulatorHandle,
  type MobileSimulatorSessionFactory,
} from './mobileSimulatorSession';
import {
  finalizeDriveEngine,
  intendXcode,
  type DriveEngineDecision,
  type XcodeIntent,
  type XcodeProbeSummary,
} from './xcode/driveEngineSelection';
import {
  openXcodeDriveSession,
  type OpenXcodeDriveSessionOptions,
  type OpenXcodeDriveSessionResult,
  type XcodeDriveSession,
} from './xcode/xcodeDriveSession';
import type { PreflightCheckResult } from './preflight';

/** DeviceInteraction's runtime floor (§B0: "requires an iOS 27.0+ simulator runtime"). */
export const XCODE_MIN_RUNTIME_MAJOR = 27;

/** The Stage 3 collaborators the runner needs; absent ⇒ the xcode rung is `xcode-unavailable`. */
export interface MobileXcodeDeps {
  /** The §B2 probe summary (spawn-free, 60 s memo). A throw reads as `inconclusive`. */
  probe: () => Promise<XcodeProbeSummary>;
  /** The resolved `xcrun` the bridge is spawned through. */
  xcrunPath?: string;
  /** Test seam over {@link openXcodeDriveSession}. */
  openSession?: (options: OpenXcodeDriveSessionOptions) => Promise<OpenXcodeDriveSessionResult>;
  /** Root for the drive socket's long-path fallback. */
  shortTmpDir?: string;
}

/** The toolchain calls this module makes. `resolveJavaHome` is optional so older fakes still fit. */
export interface MobileDriveToolchain {
  resolveMaestroBin(): Promise<string | null>;
  resolvePinFlag(maestroBin: string): Promise<string | null>;
  resolveJavaHome?(): Promise<string | null>;
}

export interface MobileXcodePlan {
  requested: MobileDriveEngine;
  intent: XcodeIntent;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Step 1: what the request asked for, and whether the xcode rung is worth attempting. */
export async function planXcodeIntent(
  driveEngine: (() => MobileDriveEngine) | undefined,
  xcode: MobileXcodeDeps | undefined,
  logger: LoggerLike | undefined,
): Promise<MobileXcodePlan> {
  let requested: MobileDriveEngine = 'auto';
  try {
    requested = driveEngine?.() ?? 'auto';
  } catch {
    requested = 'auto';
  }
  if (requested === 'none' || requested === 'maestro' || xcode === undefined) {
    return { requested, intent: intendXcode(requested, null) };
  }
  let probe: XcodeProbeSummary;
  try {
    probe = await xcode.probe();
  } catch (err) {
    // The probe's contract is never-throw; if it does, it could not answer —
    // and an unanswered probe is `inconclusive`, which still attempts xcode.
    logger?.info('[mobileDriveRung] xcode probe threw; treating as inconclusive', { error: errorText(err) });
    probe = { outcome: 'inconclusive', approval: 'unknown', detail: `the Xcode MCP probe threw: ${errorText(err)}` };
  }
  return { requested, intent: intendXcode(requested, probe) };
}

/**
 * Step 2: acquire, with the iOS 27 floor when xcode is intended. Returns the
 * (possibly downgraded) intent alongside the handle. Any OTHER acquire failure
 * propagates unchanged — the runner's own catch turns it into the synthetic
 * `'mobile-simulator'` skip, exactly as before this rung existed.
 */
export async function acquireMobileSimulator(
  session: MobileSimulatorSessionFactory,
  args: AcquireSimulatorArgs,
  intent: XcodeIntent,
  logger: LoggerLike | undefined,
): Promise<{ handle: MobileSimulatorHandle; intent: XcodeIntent }> {
  if (!intent.attempt) return { handle: await session.acquire(args), intent };
  try {
    return { handle: await session.acquire({ ...args, minRuntimeMajor: XCODE_MIN_RUNTIME_MAJOR }), intent };
  } catch (err) {
    const message = errorText(err);
    if (!message.includes(MIN_RUNTIME_UNSATISFIED_PREFIX)) throw err;
    logger?.info('[mobileDriveRung] no iOS 27 runtime for the xcode rung; acquiring without it', { detail: message });
    return {
      handle: await session.acquire(args),
      intent: { attempt: false, degradeReason: 'xcode-unavailable', detail: message },
    };
  }
}

/** Step 3's result. `session` is non-null only when the xcode rung is live; the runner's `finally` closes it. */
export interface MobileDriveEnv {
  env: Record<string, string>;
  decision: DriveEngineDecision;
  session: XcodeDriveSession | null;
  /** B6: the JDK home Maestro runs under, when one resolved; the runner puts `$JAVA_HOME/bin` first on PATH. */
  javaHome: string | null;
  /** The advisory `'xcode-mcp'` preflight row describing the decision. */
  preflightRow: PreflightCheckResult;
}

/**
 * Step 3: open the xcode session (when intended), resolve Maestro, settle the
 * rung and build the env. Never throws for a drive-rung reason: every probe or
 * session failure degrades the rung, because the observe-only arm is a real,
 * useful verification.
 */
export async function buildMobileDriveEnv(args: {
  requestId: string;
  app: MobileAppSpec;
  handle: MobileSimulatorHandle;
  plan: MobileXcodePlan;
  toolchain: MobileDriveToolchain;
  xcode: MobileXcodeDeps | undefined;
  dataDir: string;
  artifactsDir: string;
  readyTimeoutMs: number;
  logger: LoggerLike | undefined;
}): Promise<MobileDriveEnv> {
  const { app, handle, plan, toolchain, logger } = args;

  let xcodeOutcome: { ok: true; session: XcodeDriveSession } | { ok: false; degradeReason: DriveEngineDecision['degradeReason']; detail: string | null } =
    plan.intent.attempt
      ? { ok: false, degradeReason: null, detail: null }
      : { ok: false, degradeReason: plan.intent.degradeReason, detail: plan.intent.detail };
  if (plan.intent.attempt) {
    const open = args.xcode?.openSession ?? openXcodeDriveSession;
    const opened = await open({
      requestId: args.requestId,
      udid: handle.udid,
      appBundleId: app.bundleId,
      dataDir: args.dataDir,
      artifactsDir: args.artifactsDir,
      recordSessionKey: (key) => handle.recordXcodeSessionKey(key),
      retainSessionKey: async (key) => {
        await handle.retainXcodeSessionKey?.(key);
      },
      ...(args.xcode?.xcrunPath !== undefined ? { xcrunPath: args.xcode.xcrunPath } : {}),
      ...(args.xcode?.shortTmpDir !== undefined ? { shortTmpDir: args.xcode.shortTmpDir } : {}),
      ...(logger !== undefined ? { logger } : {}),
    });
    xcodeOutcome = opened.ok
      ? { ok: true, session: opened.session }
      : { ok: false, degradeReason: opened.degradeReason, detail: opened.detail };
  }

  // Maestro is resolved whenever it could be the rung: the request asked for
  // it, or xcode did not come up. Both calls are caught — a probe that cannot
  // answer degrades the rung, it never fails the request.
  let maestroBin: string | null = null;
  if (plan.requested !== 'none' && !xcodeOutcome.ok) {
    try {
      const bin = await toolchain.resolveMaestroBin();
      maestroBin = bin !== null && (await toolchain.resolvePinFlag(bin)) !== null ? bin : null;
      if (bin !== null && maestroBin === null) {
        logger?.info('[mobileDriveRung] maestro resolved but names no device-pin flag; not a drive rung', { maestro: bin });
      }
    } catch (err) {
      logger?.info('[mobileDriveRung] maestro probe failed; not a drive rung', { error: errorText(err) });
      maestroBin = null;
    }
  }
  // B6: the JDK Maestro needs — exported to the AGENT too, since the driver it
  // runs spawns Maestro (and probes its `--help`) under the agent's env.
  let javaHome: string | null = null;
  if (maestroBin !== null && toolchain.resolveJavaHome !== undefined) {
    try {
      javaHome = await toolchain.resolveJavaHome();
    } catch {
      javaHome = null;
    }
  }

  const decision = finalizeDriveEngine({
    requested: plan.requested,
    xcode: xcodeOutcome.ok ? { ok: true } : { ok: false, degradeReason: xcodeOutcome.degradeReason, detail: xcodeOutcome.detail },
    maestroAvailable: maestroBin !== null,
  });
  if (decision.degradeReason !== null) {
    logger?.info('[mobileDriveRung] xcode drive rung degraded', {
      requestId: args.requestId,
      requested: decision.requested,
      used: decision.used,
      reason: decision.degradeReason,
      detail: decision.degradeDetail,
    });
  }
  // A session that opened but lost to `requested: 'none'` cannot happen (none
  // never attempts), so `session` is live exactly when the rung is xcode.
  const session = xcodeOutcome.ok ? xcodeOutcome.session : null;

  const env: Record<string, string> = {
    VERIFY_SIM_UDID: handle.udid,
    VERIFY_SIM_NAME: handle.name,
    VERIFY_SIM_RUNTIME: handle.runtimeName,
    VERIFY_DERIVED_DATA: handle.derivedDataDir,
    VERIFY_APP_BUNDLE_ID: app.bundleId,
    VERIFY_APP_PRODUCT_GLOB: app.productGlob ?? DEFAULT_MOBILE_PRODUCT_GLOB,
    VERIFY_MOBILE_DRIVE: decision.used,
    ...(decision.used === 'maestro' && maestroBin !== null ? { VERIFY_MAESTRO_BIN: maestroBin } : {}),
    ...(javaHome !== null ? { JAVA_HOME: javaHome } : {}),
    ...(session !== null ? session.env : {}),
    VERIFY_MOBILE_READY_TIMEOUT_MS: String(args.readyTimeoutMs),
  };

  const preflightRow: PreflightCheckResult = {
    id: 'xcode-mcp',
    // ADVISORY by construction: degrade, never skip (§B3).
    ok: true,
    detail:
      `drive engine requested ${decision.requested}, used ${decision.used}` +
      (decision.degradeReason !== null
        ? ` (degraded: ${decision.degradeReason}${decision.degradeDetail !== null ? ` — ${decision.degradeDetail}` : ''})`
        : ''),
  };
  return { env, decision, session, javaHome, preflightRow };
}
