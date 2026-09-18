/**
 * runAgentPreflight — the agent-path pre-deploy gate
 * (docs/proposals/verification-setup-flow.md §3.5). The agent engine
 * (`VerificationAgentRunner`) bypasses the legacy `selectCandidates` health
 * gate entirely, so today a missing chromium (or an occupied leased port)
 * only surfaces *after* budget increment + snapshot provisioning + a full SDK
 * deploy (`driverCore.ts:330-336`) — an expensive, slow way to learn the host
 * cannot run the check at all. This module is the cheap check that runs
 * BEFORE any of that: chromium/node resolvable, the driver CLI present, and
 * the ports the agent is about to bind/attach to are genuinely free.
 *
 * Preflight results are the EVIDENCE BASE for the §3.1 conservative failure
 * classifier (`failureClassifier.ts`) — a failed check here is what lets a
 * downstream FAIL be reclassified `env` (advancing skip) instead of staying
 * lane-blocking. This is also the §1(e) "false-ready" fix's evidence
 * source: the port pool is an in-process mutex that "guards the logical
 * slot, NOT the OS socket" (shared/types/visualVerification.ts), so a
 * `port-free` check that actually connects to the leased port before launch
 * is what would have caught the production incident (a stale Vite from an
 * unrelated worktree answering 404 on a leased pool port).
 *
 * PURE MODULE — no `fs` / `net` / `child_process` import. Every side-effecting
 * probe (resolving node, resolving chromium, checking a file, dialing a port)
 * is INJECTED via {@link AgentPreflightDeps} so this file typechecks and unit
 * tests standalone; the runner (VerificationScheduler / VerificationAgentRunner)
 * wires the real implementations (Node's own `process.execPath`, Playwright's
 * chromium resolution, `fs.access`, a raw TCP connect probe).
 *
 * CRITICAL FAIL-OPEN RULE — read this before touching any check body: a probe
 * that THROWS is INCONCLUSIVE, not evidence. A preflight failure converts a
 * lane-blocking FAIL into an advancing SKIP downstream (via the classifier),
 * so only AFFIRMATIVE evidence may fail a check — chromium resolved `null`,
 * a file was confirmed absent, a port connect actually succeeded (a
 * squatter), or node resolution threw. A probe that merely COULDN'T ANSWER
 * (network hiccup, permission denial, an unexpected exception shape) must
 * record `ok:true` with the error folded into `detail` and let the run
 * proceed to the real deploy — guessing `ok:false` from an inconclusive probe
 * would let an env-eligible skip fire on no real evidence, which is exactly
 * the danger the classifier's own doc warns against (a false 'env' verdict
 * is dangerous — it advances the lane — while a false 'ambiguous' is merely
 * annoying).
 *
 * THE ONE EXCEPTION: `resolveNode()` throwing IS treated as affirmative
 * evidence (`ok:false`) — unlike the other probes, "node is unresolvable" is
 * itself the harness-derived fact being checked (there is no separate
 * "inconclusive" outcome for it: either a node binary was resolved, in which
 * case the deploy can proceed, or it wasn't, in which case nothing downstream
 * can run at all — the driver wrapper cannot even be written).
 */
import type {
  VerificationTaskV1,
  VerificationModality,
} from '../../../../shared/types/visualVerification';

/**
 * One preflight check's outcome. Only checks that RAN appear in
 * {@link AgentPreflightResult.checks}.
 *
 * `'mobile-simulator'` is NOT emitted by anything in this module — preflight
 * is allocation-free and the simulator is acquired later, by the runner, not
 * here. The id exists only so the runner can synthesize a
 * {@link PreflightCheckResult}-shaped, env-classified failure row (source
 * `'preflight'` via the generic `failureClassifier.ts` loop) when simulator
 * acquisition itself throws — this module never constructs one.
 */
export interface PreflightCheckResult {
  id:
    | 'node'
    | 'chromium'
    | 'driver-cli'
    | 'data-dir'
    | 'port-free'
    | 'driver-port-free'
    | 'native-capture'
    | 'mobile-toolchain'
    | 'mobile-simulator';
  ok: boolean;
  /** Bounded human-readable detail — what was resolved, or why the check failed / was inconclusive. */
  detail: string;
}

/** The aggregate preflight result: `ok` iff every APPLICABLE check ran and passed. */
export interface AgentPreflightResult {
  ok: boolean;
  /** The checks that ran, in the order {@link runAgentPreflight} evaluates them. Inapplicable checks are omitted, not recorded as skipped. */
  checks: PreflightCheckResult[];
}

/**
 * The injected probes `runAgentPreflight` calls. The runner wires real
 * implementations; tests wire fakes. Every probe may reject/throw — per the
 * module doc, a throw is inconclusive (fail-open) for every probe EXCEPT
 * `resolveNode`.
 */
export interface AgentPreflightDeps {
  /** Resolve an executable node path (e.g. `process.execPath`, or a resolved node binary for the driver wrapper). MUST throw when unresolvable — that throw is the affirmative evidence this check fails on. */
  resolveNode: () => Promise<string>;
  /** Resolve a launchable chromium binary path, or `null` when none is installed/resolvable. A throw here is INCONCLUSIVE (fail-open), not a `null`. */
  resolveChromium: () => Promise<string | null>;
  /** Whether a file exists at an absolute path (e.g. the driver CLI entrypoint). */
  fileExists: (absPath: string) => Promise<boolean>;
  /** `true` when nothing is listening on `port` (a connect attempt was refused/timed out); `false` when something answered — a squatter. */
  portFreeProbe: (port: number) => Promise<boolean>;
  /**
   * `true` when this host can actually capture the screen for the
   * `native-screen` modality — binary present AND both macOS TCC grants
   * (Screen Recording + Accessibility), i.e. the retired
   * `peekabooBackend.healthCheck()` reused as the live grant probe (§4,
   * "Driver additions for native-screen").
   *
   * OPTIONAL, and absence is NOT a failure: an unwired probe means the
   * 'native-capture' check is simply NOT RUN. The scheduler-side capability
   * gate already refuses to enqueue a `native-screen` request on a host with
   * no proven capture capability, so a second, evidence-free failure here
   * would add a check that can only fire where the request should never have
   * arrived. A throw is INCONCLUSIVE (fail-open), like every probe but
   * `resolveNode`.
   */
  nativeCaptureProbe?: () => Promise<boolean>;
  /**
   * `true` when this host's Xcode toolchain can actually drive the `mobile`
   * modality — Xcode Command Line Tools installed, at least one iOS
   * Simulator runtime downloaded, AND at least one compatible iPhone device
   * type available to pair with it. Mirrors `nativeCaptureProbe` exactly:
   * OPTIONAL, and absence is NOT a failure — an unwired probe means the
   * 'mobile-toolchain' check is simply NOT RUN (the scheduler-side
   * capability gate is what should have kept a `mobile` request from
   * arriving on a host with no proven toolchain in the first place).
   *
   * This probe is DISTINCT from simulator ACQUISITION: it answers "can this
   * host do mobile work at all" (Xcode/runtime/device-type presence), never
   * "is a simulator instance available right now" — that allocation happens
   * later, in the runner, deliberately outside preflight (see
   * `PreflightCheckResult`'s 'mobile-simulator' doc).
   *
   * An AFFIRMATIVE `false` fails the check — the harness-derived `'env'`
   * evidence a mobile skip needs. A THROW is INCONCLUSIVE (fail-open), the
   * same rule every probe but `resolveNode`/`prepareDataDir` follows.
   */
  mobileToolchainProbe?: () => Promise<boolean>;
  /**
   * Provision the request's FRESH, EMPTY `VERIFY_DATA_DIR` at the absolute path
   * the runner derived (F3 / RC4): leave it existing and empty. OPTIONAL like
   * `nativeCaptureProbe` — absent (or no `dataDir` in the args) ⇒ the
   * 'data-dir' check is NOT RUN.
   *
   * A THROW here is AFFIRMATIVE failure, not inconclusive — the second probe
   * after `resolveNode` to work that way. The harness itself tried to create a
   * directory under the request's own artifacts root and could not; a serve
   * command that keys its app's state dir off the var would then start against
   * a path that does not exist, and the failure would surface as the AGENT's
   * `launch_failed` with no harness evidence behind it — a blocking
   * `ambiguous` that burns an implement attempt on a broken host. Failing the
   * preflight instead makes it a fail-open `skipped` with the evidence attached.
   */
  prepareDataDir?: (dataDir: string) => Promise<void>;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 'node' — ALWAYS applicable. Harness-derived: the driver wrapper (the
 * script the scheduler spawns to drive the CDP session) cannot be written or
 * executed without a resolvable node binary. `resolveNode()` throwing is the
 * one exception to the fail-open rule (see module doc) — it fails the check.
 */
async function checkNode(deps: AgentPreflightDeps): Promise<PreflightCheckResult> {
  try {
    const path = await deps.resolveNode();
    return { id: 'node', ok: true, detail: `resolved: ${path}` };
  } catch (err) {
    return { id: 'node', ok: false, detail: `node unresolvable: ${errorDetail(err)}` };
  }
}

/**
 * 'chromium' — applicable ONLY when `task.serve?.attach !== 'cdp'` AND
 * `modality !== 'mobile'`. In attach mode the driver ATTACHES to the
 * deliverable app's OWN CDP endpoint (`VERIFY_DRIVER_ATTACH_ONLY` —
 * driverCore.ts's attach-only mode never launches a browser, its "launch
 * fallback is DISABLED"); no chromium is ever needed. `mobile` drives the
 * iOS Simulator, never a browser, so chromium is equally irrelevant there.
 * Every other shape — a web serve, a static build, or a bare pre-live
 * target (the degenerate path, `task.serve` absent entirely) — drives via a
 * chromium the driver launches itself, so the check runs.
 * `resolveChromium()` returning `null` is affirmative evidence (absent);
 * a throw is inconclusive (fail-open).
 */
async function checkChromium(deps: AgentPreflightDeps): Promise<PreflightCheckResult> {
  try {
    const path = await deps.resolveChromium();
    if (path === null) {
      return { id: 'chromium', ok: false, detail: 'chromium not resolved (absent)' };
    }
    return { id: 'chromium', ok: true, detail: `resolved: ${path}` };
  } catch (err) {
    return {
      id: 'chromium',
      ok: true,
      detail: `chromium probe inconclusive (fail-open): ${errorDetail(err)}`,
    };
  }
}

/**
 * 'native-capture' — applicable ONLY when the request's modality is
 * `'native-screen'` AND a {@link AgentPreflightDeps.nativeCaptureProbe} is
 * wired. Every other modality drives a browser surface and never touches the
 * screen-capture grants, so running it there would be noise; an unwired probe
 * omits the check entirely (see the dep's doc for why an unwired probe is not
 * a failure).
 *
 * An AFFIRMATIVE `false` fails it — that is the harness-derived fact "this
 * host cannot capture the screen", which is exactly the §3.1 `'env'` evidence
 * a native-screen skip needs. A THROW is inconclusive ⇒ `ok:true`, the same
 * fail-open rule the chromium/file/port probes follow: an unanswerable probe
 * must never be the reason a lane advances on an unrun verification.
 */
async function checkNativeCapture(probe: () => Promise<boolean>): Promise<PreflightCheckResult> {
  try {
    const capable = await probe();
    if (!capable) {
      return {
        id: 'native-capture',
        ok: false,
        detail: 'native screen capture unavailable (probe returned false — binary missing or a TCC grant declined)',
      };
    }
    return { id: 'native-capture', ok: true, detail: 'native screen capture available' };
  } catch (err) {
    return {
      id: 'native-capture',
      ok: true,
      detail: `native-capture probe inconclusive (fail-open): ${errorDetail(err)}`,
    };
  }
}

/**
 * 'mobile-toolchain' — applicable ONLY when the request's modality is
 * `'mobile'` AND a {@link AgentPreflightDeps.mobileToolchainProbe} is wired.
 * Every other modality never touches Xcode; an unwired probe omits the
 * check entirely (see the dep's doc for why an unwired probe is not a
 * failure).
 *
 * An AFFIRMATIVE `false` fails it — the harness-derived fact that this host
 * cannot drive `mobile` at all (Xcode Command Line Tools absent, no iOS
 * Simulator runtime downloaded, or no compatible iPhone device type), which
 * is exactly the §3.1 `'env'` evidence a mobile skip needs. A THROW is
 * inconclusive ⇒ `ok:true`, the same fail-open rule `checkNativeCapture`
 * follows.
 */
async function checkMobileToolchain(probe: () => Promise<boolean>): Promise<PreflightCheckResult> {
  try {
    const capable = await probe();
    if (!capable) {
      return {
        id: 'mobile-toolchain',
        ok: false,
        detail:
          'mobile toolchain unavailable (probe returned false — missing one of: Xcode Command Line Tools, an available iOS Simulator runtime, a compatible iPhone device type)',
      };
    }
    return { id: 'mobile-toolchain', ok: true, detail: 'mobile toolchain available' };
  } catch (err) {
    return {
      id: 'mobile-toolchain',
      ok: true,
      detail: `mobile-toolchain probe inconclusive (fail-open): ${errorDetail(err)}`,
    };
  }
}

/** 'driver-cli' — ALWAYS applicable: the bundled driver CLI entrypoint must exist before the runner can spawn it. A `fileExists` throw is inconclusive (fail-open). */
/**
 * 'data-dir' — CONDITIONAL on the probe being wired AND a path being given.
 * Affirmative on throw (see the dep's doc): the harness could not make a
 * directory it owns.
 */
async function checkDataDir(
  prepareDataDir: NonNullable<AgentPreflightDeps['prepareDataDir']>,
  dataDir: string,
): Promise<PreflightCheckResult> {
  try {
    await prepareDataDir(dataDir);
    return { id: 'data-dir', ok: true, detail: `provisioned ${dataDir}` };
  } catch (err) {
    return { id: 'data-dir', ok: false, detail: `could not provision VERIFY_DATA_DIR at ${dataDir}: ${errorDetail(err)}` };
  }
}

async function checkDriverCli(deps: AgentPreflightDeps, driverCliPath: string): Promise<PreflightCheckResult> {
  try {
    const exists = await deps.fileExists(driverCliPath);
    if (!exists) {
      return { id: 'driver-cli', ok: false, detail: `driver CLI not found at ${driverCliPath}` };
    }
    return { id: 'driver-cli', ok: true, detail: `present at ${driverCliPath}` };
  } catch (err) {
    return {
      id: 'driver-cli',
      ok: true,
      detail: `driver-cli probe inconclusive (fail-open): ${errorDetail(err)}`,
    };
  }
}

/**
 * Shared port-probe body for both 'port-free' and 'driver-port-free'. A
 * connect-SUCCESS (`portFreeProbe` resolves `false`) is affirmative evidence
 * of a squatter — the §1(e) false-ready fix's evidence base. A throw is
 * inconclusive (fail-open): the probe couldn't determine occupancy either
 * way, so proceed and let the real deploy discover the truth.
 */
async function checkPortFree(
  deps: AgentPreflightDeps,
  id: 'port-free' | 'driver-port-free',
  port: number,
): Promise<PreflightCheckResult> {
  try {
    const free = await deps.portFreeProbe(port);
    if (!free) {
      return { id, ok: false, detail: `port ${port} is occupied — a connect probe succeeded (squatter)` };
    }
    return { id, ok: true, detail: `port ${port} free` };
  } catch (err) {
    return { id, ok: true, detail: `port ${port} probe inconclusive (fail-open): ${errorDetail(err)}` };
  }
}

/**
 * Run every APPLICABLE preflight check for a composed task, in order:
 * node → chromium (conditional) → native-capture (conditional) →
 * mobile-toolchain (conditional) → driver-cli → data-dir (conditional) →
 * port-free (conditional) → driver-port-free (conditional). See each
 * check's own doc for its applicability rule. `ok` is the conjunction of
 * every check that RAN; an inapplicable check is simply absent from
 * `checks`, never counted for or against `ok`.
 *
 * `modality` (§4 roster) is OPTIONAL: it gates the `native-capture` and
 * `mobile-toolchain` checks, so a caller that has not yet resolved a
 * modality runs exactly the pre-roster check set.
 */
export async function runAgentPreflight(
  deps: AgentPreflightDeps,
  args: {
    task: VerificationTaskV1;
    driverCliPath: string;
    /**
     * The leased dev-server port the agent must BIND, or `null` when the
     * scheduler leased no port pair at all (a `mobile` request: the iOS
     * Simulator tier serves nothing over HTTP, so there is no slot to
     * recover and no number to invent). `null` skips the 'port-free' check
     * exactly as a task with no `serve` step does — this module never
     * probes a port it was not given.
     */
    leasedPort: number | null;
    /**
     * The driver's own CDP port, or `null` for a `mobile` task — mobile has
     * NO serve and NO ports at all pre-deploy (the simulator is acquired
     * later, by the runner, not here); `null` skips both port checks.
     */
    driverPort: number | null;
    modality?: VerificationModality;
    /** The request's `VERIFY_DATA_DIR`; with `deps.prepareDataDir`, enables the 'data-dir' check. */
    dataDir?: string;
  },
): Promise<AgentPreflightResult> {
  const { task, driverCliPath, leasedPort, driverPort, modality, dataDir } = args;
  const isAttachCdp = task.serve?.attach === 'cdp';
  const isMobile = modality === 'mobile';
  const checks: PreflightCheckResult[] = [];

  checks.push(await checkNode(deps));

  if (!isAttachCdp && !isMobile) {
    checks.push(await checkChromium(deps));
  }

  if (modality === 'native-screen' && deps.nativeCaptureProbe) {
    checks.push(await checkNativeCapture(deps.nativeCaptureProbe));
  }

  if (isMobile && deps.mobileToolchainProbe) {
    checks.push(await checkMobileToolchain(deps.mobileToolchainProbe));
  }

  checks.push(await checkDriverCli(deps, driverCliPath));

  if (deps.prepareDataDir && dataDir !== undefined) {
    checks.push(await checkDataDir(deps.prepareDataDir, dataDir));
  }

  // The agent must BIND the leased port itself only when there is a serve
  // step it is NOT attaching to an existing CDP endpoint for, AND a port was
  // actually leased. A mobile task satisfies neither: it declares an `app`
  // block instead of a serve, and the scheduler leases it no ports at all.
  if (task.serve !== undefined && !isAttachCdp && leasedPort !== null) {
    checks.push(await checkPortFree(deps, 'port-free', leasedPort));
  }

  // The driver's own CDP port (or, in attach mode, the app's own CDP
  // endpoint) must be free pre-launch — EXCEPT for `mobile`, which has no
  // ports at all pre-deploy (`driverPort` is `null`): the simulator is
  // acquired later, by the runner, not in this allocation-free module.
  if (driverPort !== null) {
    checks.push(await checkPortFree(deps, 'driver-port-free', driverPort));
  }

  return { ok: checks.every((c) => c.ok), checks };
}
