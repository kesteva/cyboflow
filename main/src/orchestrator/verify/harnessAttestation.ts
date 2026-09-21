/**
 * harnessAttestation — the HARNESS's own §7.1 identity probe, performed by the
 * runner against the still-live surface after the agent's session ends and
 * before anything is torn down.
 *
 * WHY THIS MODULE EXISTS (the forgery hole it closes). §7.1's floor used to rest
 * on `<VERIFY_ARTIFACTS_DIR>/.driver/attest.json` — a file the driver CLI wrote
 * and the runner read — on the reasoning that "a model can claim it attested, it
 * cannot forge a file only this CLI writes". That reasoning was wrong in exactly
 * one place, and the whole floor rested on it: the agent has `Bash` and it owns
 * `VERIFY_ARTIFACTS_DIR`, so ONE redirect —
 * `echo '{"ok":true,"kind":"http-endpoint","detail":"x"}' > "$VERIFY_ARTIFACTS_DIR/.driver/attest.json"`
 * — produced a perfect record for a channel that never ran. The nonce did not
 * help: `VERIFY_ATTEST_NONCE` is exported into the agent's OWN environment, so
 * it authenticates nothing against the agent itself. It proves a *surface*
 * knows the secret; it can never prove that the agent asked a surface.
 *
 * The fix is not a better file format, it is moving the ACT. Attestation is a
 * thing the harness DOES, not a thing the harness READS. Everything under
 * `VERIFY_ARTIFACTS_DIR` is now agent-authored data with no evidentiary weight
 * for identity; the only identity evidence is the result of a probe this process
 * ran itself, over sockets the agent does not mediate.
 *
 * WHAT THIS MODULE IS. A pure, Electron-free, IO-injected evaluator: it decides
 * what to ask and how to judge the answer, and the three probes that actually
 * touch the outside world (an HTTP GET, a CDP evaluate, an OS window listing)
 * are injected. The real implementations live in the runner's wiring, built out
 * of the SAME driverCore machinery the driver CLI uses, so the harness probe and
 * the agent's self-check can never disagree about what a channel means.
 *
 * NOTHING HERE THROWS. Every probe failure — a refused connection, a missing
 * peekaboo binary, a CDP endpoint the agent shut down — resolves as
 * `verified: false` with the error in `detail`. A probe that could not run is a
 * FAILED attestation, never an exception: the §7.1 floor is what decides what an
 * unproven identity costs, and a throw escaping into the runner would turn a
 * provable verification failure into an unexplained crash (which the runner's
 * outer catch maps to a fail-open `skipped` — i.e. the lane would ADVANCE on the
 * exact case this module exists to block).
 */
import { join, sep } from 'node:path';
import type { LoggerLike } from '../types';
import type { AttestationSpec } from '../../../../shared/types/visualVerification';
import { compileTitleMatcher } from './driver/driverCore';

/**
 * What the harness concluded about ONE surface's identity. `kind` echoes the
 * spec's channel rather than being discovered: the harness CHOOSES the channel
 * from the task's declaration, so "a record for the wrong channel" — a real
 * failure mode back when the evidence was an agent-adjacent file — is now
 * impossible by construction.
 */
export interface HarnessAttestationResult {
  verified: boolean;
  kind: AttestationSpec['kind'];
  detail: string;
}

/**
 * The three outside-world probes, injected so this module stays fs/net/
 * playwright-free at module scope (same posture as the rest of `verify/`).
 *
 * Each is expected to REJECT on failure rather than encode one — an HTTP GET
 * that got a 404, a CDP endpoint that is gone, a peekaboo binary that is not
 * installed. {@link performHarnessAttestation} folds every rejection into
 * `verified: false`, so the probes stay simple and the "what does a failure
 * mean" decision lives in exactly one place.
 */
export interface HarnessAttestationDeps {
  /** GET the URL and return its body; REJECTS on a non-2xx status or a refused/timed-out connection. */
  httpGetBody: (url: string, timeoutMs: number) => Promise<string>;
  /** Evaluate `expression` over the CDP endpoint on `port` and return `String(result)`. */
  cdpEvaluate: (port: number, expression: string, timeoutMs: number) => Promise<string>;
  /**
   * List the window titles of ONE application (peekaboo) for the
   * `window-identity` channel. Scoped rather than host-wide because peekaboo
   * offers no host-wide listing, and because "some window somewhere matches"
   * would not be an identity check.
   */
  listNativeWindows: (app: string) => Promise<string[]>;
  /**
   * Read a UTF-8 file. REJECTS when it is absent or unreadable — the
   * `bundle-identity` channel reads the driver's own `mobile-install.json`
   * through this, and "absent" is a meaningful answer there (nothing was ever
   * installed), not an error to swallow at this seam.
   *
   * OPTIONAL like the three mobile deps below it: a deployment that never wired
   * them cannot probe `bundle-identity`, and the arm answers `verified:false`
   * rather than throwing. Unverified is always the safe reading here.
   */
  readTextFile?: (absPath: string) => Promise<string>;
  /** Resolve an absolute path through every symlink. REJECTS when it does not exist. */
  realpath?: (absPath: string) => Promise<string>;
  /** sha256, hex, of a file's bytes. REJECTS when the file cannot be read. */
  sha256File?: (absPath: string) => Promise<string>;
  /**
   * Run one Apple CLI (`xcrun simctl get_app_container …`) and return its exit
   * code + streams. Resolves for a NON-ZERO exit as well — the arm reads the
   * code itself, because "the container is not there" and "the probe broke" are
   * different verdicts and only the first is evidence.
   */
  exec?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /**
   * The inter-attempt delay. Injected ONLY so the unit suite does not spend real
   * seconds proving the retry loop; production always uses the real timer.
   */
  sleep?: (ms: number) => Promise<void>;
  logger?: LoggerLike;
}

/**
 * The simulator context ONE `bundle-identity` probe needs. Supplied by the
 * runner for a `mobile` request and absent for every other modality, which is
 * why the arm treats "no context" as an unproven identity rather than a
 * programming error: an attestation that cannot be performed is a failed
 * attestation (see this module's header).
 */
export interface MobileAttestationContext {
  /** `VERIFY_ARTIFACTS_DIR` — where `mobile-install` wrote its record. */
  artifactsDir: string;
  /** `VERIFY_DERIVED_DATA` — the confinement root the staged product must resolve under. */
  derivedDataDir: string;
  /** The UDID of the device created for this request alone. */
  simUdid: string;
}

/** The record `mobile-install` writes; re-declared structurally so this module imports no driver code. */
interface MobileInstallRecordShape {
  builtPath: string;
  installedPath: string;
  builtSha256: string;
  installedSha256: string;
  bundleId: string;
  executable: string;
}

/** The file `mobile-install` writes under `VERIFY_ARTIFACTS_DIR`. */
export const MOBILE_INSTALL_RECORD_FILE = 'mobile-install.json';

/** Per-`simctl` deadline for the container lookup. */
export const MOBILE_ATTEST_EXEC_TIMEOUT_MS = 30_000;

/**
 * The two-part residual §9.2 requires on every `bundle-identity` verdict,
 * verified or not. Exported so the runner's tests and any future health-panel
 * copy key on ONE string rather than re-spelling a guarantee.
 */
export const BUNDLE_IDENTITY_RESIDUAL =
  'staged-artifact identity; does not prove compilation from the snapshot, nor that the screenshots were of this app in the foreground';

/** The detail a `bundle-identity` probe answers with when the driver never installed anything. */
export const BUNDLE_IDENTITY_NO_RECORD_DETAIL =
  'nothing was installed through the driver — mobile-install never ran';

function isRecordShape(value: unknown): value is MobileInstallRecordShape {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.builtPath === 'string' &&
    typeof v.installedPath === 'string' &&
    typeof v.builtSha256 === 'string' &&
    typeof v.installedSha256 === 'string' &&
    typeof v.bundleId === 'string' &&
    typeof v.executable === 'string'
  );
}

/** Is `child` the confinement root itself, or genuinely inside it? */
function isUnder(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The `bundle-identity` probe (§9): is the app installed on the leased
 * simulator byte-identical to the exactly-one product staged under THIS
 * request's private DerivedData, and does it carry the declared bundle id?
 *
 * WHAT IT TRUSTS AND WHAT IT RE-DERIVES. The driver's `mobile-install.json` is
 * agent-adjacent — it sits under `VERIFY_ARTIFACTS_DIR` — so it is read as a
 * CLAIM, exactly like `.driver/serve.pid` in the serve-identity binding. Three
 * things are checked against it rather than taken from it: the staged product
 * must still realpath-resolve UNDER `$VERIFY_DERIVED_DATA` (a symlink or `..`
 * escape is how a prebuilt bundle outside the request dir would otherwise be
 * reachable), the installed container is located by asking `simctl` rather than
 * by reading `installedPath`, and the installed executable is RE-HASHED here.
 * A forged record can therefore only make this probe FAIL, never pass.
 *
 * The executable ONLY is hashed — never `Info.plist` — per §9.1: the byte
 * preservation `simctl install` gives was proven for the Mach-O, and folding in
 * a plist adds a normalization failure mode for no identity gain.
 */
async function probeBundleIdentity(
  spec: Extract<AttestationSpec, { kind: 'bundle-identity' }>,
  mobile: MobileAttestationContext | undefined,
  deps: HarnessAttestationDeps,
): Promise<{ verified: boolean; detail: string }> {
  const fail = (detail: string): { verified: boolean; detail: string } => ({
    verified: false,
    detail: `bundle-identity: ${detail} (${BUNDLE_IDENTITY_RESIDUAL})`,
  });
  const { readTextFile, realpath, sha256File, exec } = deps;
  if (mobile === undefined || !readTextFile || !realpath || !sha256File || !exec) {
    return fail(
      'the harness holds no simulator context for this request, so there is no installed app to interrogate',
    );
  }

  const recordPath = join(mobile.artifactsDir, MOBILE_INSTALL_RECORD_FILE);
  let record: MobileInstallRecordShape;
  try {
    const parsed: unknown = JSON.parse(await readTextFile(recordPath));
    if (!isRecordShape(parsed)) return fail(`${BUNDLE_IDENTITY_NO_RECORD_DETAIL} (${recordPath} is not a v1 install record)`);
    record = parsed;
  } catch {
    return fail(`${BUNDLE_IDENTITY_NO_RECORD_DETAIL} (${recordPath})`);
  }

  if (record.bundleId !== spec.bundleId) {
    return fail(
      `the driver installed "${record.bundleId}" but this task declared "${spec.bundleId}" — the app on the device is not the one being verified`,
    );
  }

  // Confinement, re-derived. Both sides go through realpath so a symlink
  // ANYWHERE in the intermediate path is caught, not just a linked leaf.
  let builtReal: string;
  let rootReal: string;
  try {
    builtReal = await realpath(record.builtPath);
    rootReal = await realpath(mobile.derivedDataDir);
  } catch (err) {
    return fail(
      `the staged product ${record.builtPath} is gone — it must still be present under ${mobile.derivedDataDir} for its identity to mean anything: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isUnder(builtReal, rootReal)) {
    return fail(
      `the staged product escapes this request's DerivedData: ${record.builtPath} resolves to ${builtReal}, which is outside ${rootReal}`,
    );
  }

  const container = await exec(
    'xcrun',
    ['simctl', 'get_app_container', mobile.simUdid, spec.bundleId, 'app'],
    MOBILE_ATTEST_EXEC_TIMEOUT_MS,
  );
  const installedPath = container.stdout.trim();
  if (container.code !== 0 || installedPath.length === 0) {
    return fail(
      `simctl get_app_container exited ${String(container.code)} with no container for "${spec.bundleId}" on ${mobile.simUdid}: ${truncate(container.stderr.trim() || container.stdout.trim())}`,
    );
  }

  let liveSha: string;
  const liveExecutable = join(installedPath, record.executable);
  try {
    liveSha = await sha256File(liveExecutable);
  } catch (err) {
    return fail(
      `could not re-hash the installed executable ${liveExecutable}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const where = `staged ${builtReal} → installed ${installedPath} (${record.executable})`;
  if (record.builtSha256 !== record.installedSha256) {
    return fail(
      `the driver's own record disagrees with itself — ${where}: staged sha256 ${record.builtSha256}, recorded installed sha256 ${record.installedSha256}`,
    );
  }
  if (liveSha !== record.builtSha256) {
    return fail(
      `the app on the device is NOT the product staged for this request — ${where}: staged sha256 ${record.builtSha256}, live installed sha256 ${liveSha}`,
    );
  }

  return {
    verified: true,
    detail: `bundle-identity: ${where} — sha256 ${liveSha} agrees on all three readings (staged, recorded, re-hashed live) for "${spec.bundleId}" (${BUNDLE_IDENTITY_RESIDUAL})`,
  };
}

/**
 * How many times a channel is asked before the harness accepts "no". The §5.4
 * flakiness guard: the probe fires seconds after the agent finished driving a
 * surface it had just screenshotted, so a single refused connect is far more
 * likely to be a dev server mid-reload than a genuinely absent deliverable —
 * and an attestation that flaps is worse than useless, because a false negative
 * here BLOCKS a lane on a verification that actually happened.
 */
export const HARNESS_ATTEST_ATTEMPTS = 3;

/** The gap between attempts (see {@link HARNESS_ATTEST_ATTEMPTS}). */
export const HARNESS_ATTEST_RETRY_DELAY_MS = 1_000;

/** Per-probe deadline — mirrors driverCore's `ATTEST_HTTP_TIMEOUT_MS`. */
export const HARNESS_ATTEST_PROBE_TIMEOUT_MS = 10_000;

/**
 * Everything ONE attestation needs. `driverPort` is nullable because a `mobile`
 * request is leased no ports at all: the two CDP-mediated channels answer
 * `verified:false` with a plain reason rather than dialling port `0`, which is
 * the honest reading — a task that declared a channel its own shape cannot
 * support has an unproven identity, not a broken probe.
 */
export interface HarnessAttestationArgs {
  verifyPort: number | null;
  driverPort: number | null;
  nonce: string;
  /** Present only for a `mobile` request — the `bundle-identity` channel's whole world. */
  mobile?: MobileAttestationContext;
  deps: HarnessAttestationDeps;
}

/** The verdict a CDP-mediated channel gets when this request holds no driver port. */
function noDriverPort(kind: 'dom-marker' | 'cdp-token'): { verified: boolean; detail: string } {
  return {
    verified: false,
    detail: `${kind}: no driver port was leased for this request, so there is no DevTools endpoint to evaluate against — the task declared a channel its own shape cannot support`,
  };
}

/** Bound a value echoed into a detail so a huge evaluate() result cannot bloat the terminal message. */
function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The JS the `dom-marker` channel evaluates in the page. Reads BOTH the
 * element's text and its `data-verify-nonce` attribute — a deliverable that
 * cannot render the nonce as visible copy can still stamp it on an attribute —
 * and returns them joined, so the caller's single `includes(nonce)` covers both.
 * A missing element returns the empty string rather than throwing, which reads
 * as "the marker is not there" instead of "the probe broke".
 *
 * The selector is embedded via `JSON.stringify` so a selector containing quotes
 * cannot terminate the literal and change what is being asked — the same class
 * of quiet mismatch the driver's exact-arity attest parsing exists to prevent.
 */
function domMarkerExpression(selector: string): string {
  return (
    '(() => { const el = document.querySelector(' +
    JSON.stringify(selector) +
    "); if (!el) return ''; return [el.textContent || '', el.getAttribute('data-verify-nonce') || ''].join(' '); })()"
  );
}

/**
 * Ask ONE channel once. Returns the verdict; THROWS only when the probe itself
 * could not run (the caller folds that into the same `verified: false`).
 */
async function probeOnce(
  spec: AttestationSpec,
  args: HarnessAttestationArgs,
): Promise<{ verified: boolean; detail: string }> {
  const { verifyPort, driverPort, nonce, deps } = args;
  switch (spec.kind) {
    case 'file-identity':
      // Unreachable via performHarnessAttestation (which short-circuits before
      // probing), kept so this switch stays exhaustive over the union.
      return { verified: true, detail: 'file-identity: identity holds by construction' };
    case 'http-endpoint': {
      if (verifyPort === null) {
        return {
          verified: false,
          detail:
            'http-endpoint: no server port was leased for this request, so there is no endpoint to ask — the task declared a channel its own shape cannot support',
        };
      }
      const path = spec.urlPath.startsWith('/') ? spec.urlPath : `/${spec.urlPath}`;
      const url = `http://127.0.0.1:${verifyPort}${path}`;
      const body = await deps.httpGetBody(url, HARNESS_ATTEST_PROBE_TIMEOUT_MS);
      if (!body.includes(nonce)) {
        return {
          verified: false,
          detail: `http-endpoint ${url} answered but its body does not carry this request's nonce — the surface on that port is NOT this deliverable`,
        };
      }
      return { verified: true, detail: `http-endpoint ${url} returned this request's nonce` };
    }
    case 'dom-marker': {
      if (driverPort === null) return noDriverPort('dom-marker');
      const value = await deps.cdpEvaluate(
        driverPort,
        domMarkerExpression(spec.selector),
        HARNESS_ATTEST_PROBE_TIMEOUT_MS,
      );
      if (!value.includes(nonce)) {
        return {
          verified: false,
          detail: `dom-marker "${spec.selector}": neither its text nor its data-verify-nonce attribute carries this request's nonce`,
        };
      }
      return { verified: true, detail: `dom-marker "${spec.selector}" carries this request's nonce` };
    }
    case 'cdp-token': {
      if (driverPort === null) return noDriverPort('cdp-token');
      const actual = await deps.cdpEvaluate(driverPort, spec.expression, HARNESS_ATTEST_PROBE_TIMEOUT_MS);
      if (actual !== spec.expected) {
        return {
          verified: false,
          detail: `cdp-token: ${spec.expression} evaluated to "${truncate(actual)}", expected "${truncate(spec.expected)}"`,
        };
      }
      return { verified: true, detail: `cdp-token: ${spec.expression} matched "${truncate(spec.expected)}"` };
    }
    case 'window-identity': {
      const titles = await deps.listNativeWindows(spec.app);
      const matcher = compileTitleMatcher(spec.titlePattern);
      const matched = titles.find((t) => matcher(t));
      if (matched === undefined) {
        return {
          verified: false,
          detail: `window-identity (weakest channel): no window title matching /${spec.titlePattern}/ among ${titles.length} window(s) of "${spec.app}"`,
        };
      }
      return {
        verified: true,
        detail: `window-identity (weakest channel): matched window title "${truncate(matched)}"`,
      };
    }
    case 'bundle-identity':
      return probeBundleIdentity(spec, args.mobile, deps);
  }
}

/**
 * Probe the declared channel against the LIVE surface and return the harness's
 * own identity verdict — the ONLY attestation evidence §7.1's floor accepts.
 *
 * `file-identity` short-circuits without any probe: the runner itself owns the
 * `htmlPath` it asked the agent to open, so there is no live process, no port,
 * and nothing for a stale server or the user's own running app to race.
 *
 * RETRIES ARE UNCONDITIONAL across {@link HARNESS_ATTEST_ATTEMPTS}, including
 * after an apparently definitive disagreement ("the body has no nonce"). From
 * outside, a mid-reload dev server, a page between navigations, and a genuinely
 * foreign surface are the same observation, so the honest reading of one
 * negative is "not yet". The cost of being wrong is asymmetric: a spurious
 * `false` blocks a lane whose verification really happened, while a few extra
 * seconds cost nothing on a path that already ran a full agent session.
 */
export async function performHarnessAttestation(
  spec: AttestationSpec,
  args: HarnessAttestationArgs,
): Promise<HarnessAttestationResult> {
  if (spec.kind === 'file-identity') {
    return {
      verified: true,
      kind: 'file-identity',
      detail: 'file-identity: the runner owns the opened path, so identity holds by construction',
    };
  }

  const sleep = args.deps.sleep ?? realSleep;
  let last: { verified: boolean; detail: string } = {
    verified: false,
    detail: `${spec.kind}: never probed`,
  };

  for (let attempt = 1; attempt <= HARNESS_ATTEST_ATTEMPTS; attempt++) {
    try {
      last = await probeOnce(spec, args);
    } catch (err) {
      // A probe that could not RUN is a failed attestation, not an error: the
      // floor above decides what an unproven identity costs, and it needs an
      // answer, not a stack trace.
      last = {
        verified: false,
        detail: `${spec.kind}: probe failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (last.verified) {
      return { verified: true, kind: spec.kind, detail: last.detail };
    }
    args.deps.logger?.debug('[harnessAttestation] attestation attempt did not verify', {
      kind: spec.kind,
      attempt,
      attempts: HARNESS_ATTEST_ATTEMPTS,
      detail: last.detail,
    });
    if (attempt < HARNESS_ATTEST_ATTEMPTS) await sleep(HARNESS_ATTEST_RETRY_DELAY_MS);
  }

  return {
    verified: false,
    kind: spec.kind,
    detail: `${last.detail} (harness probed ${HARNESS_ATTEST_ATTEMPTS}×)`,
  };
}
