/**
 * PeekabooBackend — Rung 2 of the layered visual-verification capability ladder
 * (see docs/proposals/visual-verification-design.md §5 + §L3). It is the ONLY backend that
 * can see cyboflow's OWN renderer: it SCREENSHOTS the already-running app via the
 * `peekaboo` CLI rather than bootstrapping a renderer (capturePage / playwright
 * both fail identically on cyboflow's own window — the renderer needs the
 * preload-injected electronTRPC). It is the sole member of the native-desktop
 * fall-forward chain.
 *
 * This file lives under main/src/services/* and MAY shell out to the `peekaboo`
 * CLI via node:child_process (the PRODUCTION PeekabooClient) — but the binary is
 * invoked behind an INJECTED PeekabooClient interface so the backend is fully
 * unit-testable (tests inject a fake client + a fake availability/TCC probe: no
 * real binary, no real capture). The main process is NOT an MCP protocol client
 * of peekaboo — `mcp__peekaboo__*` tools are for AGENTS; the main process shells
 * out to the CLI. The scheduler never imports this; index.ts wires it in.
 *
 * Physics + leasing (S4):
 *  - requiredLease ALWAYS returns the count-1 VERIFY_SCREEN_LEASE — there is one
 *    display / focus / input on the host, so the scheduler (Peekaboo's SOLE
 *    client) serializes ALL native-desktop captures app-wide through the shared
 *    mutex (composes with PanelManager / WorktreeManager holders of named leases).
 *
 * TCC + availability (the recurring SPRINT-031..039 gotcha):
 *  - probeGrants() asks (a) whether the `peekaboo` binary runs and (b) which of
 *    the two required macOS TCC grants (Screen Recording + Accessibility) the
 *    host binary holds — SEPARATELY, and distinguishing "declined" from "could
 *    not ask". healthCheck() is that same probe folded to one boolean for the
 *    scheduler gate: anything short of both grants observed ⇒ false ⇒ the
 *    resolver drops peekaboo and emits SKIPPED — never FAIL, never hang. A
 *    missing TCC grant must NEVER wedge a sprint. EVERY error path soft-fails
 *    (capture errors ⇒ CaptureResult ok:false fall-forward; probes ⇒ a
 *    NativeGrantProbe), never throws past the backend.
 *
 * @cyboflow-hidden: this backend is retired-in-place by the verification-agent
 * redesign (docs/proposals/verification-agent-redesign.md §3/§5.8) — NOT dead
 * code. It stays LIVE for two reachable paths only: (1) a pre-upgrade run whose
 * `verify_chain` stamp still names a legacy backend (immutable per run, drained
 * by VerificationScheduler until it finishes), and (2) any NEW run started with
 * the `CYBOFLOW_VERIFY_LEGACY=1` rollback kill switch (see §5.8), which stamps
 * legacy chains going forward and boot-terminalizes any stranded agent-chain
 * request. The default v1 engine (verify_chain=['agent']) never reaches this
 * file — VerificationScheduler.processRow's isAgentStampedRun dispatch routes
 * those requests to VerificationAgentRunner instead. `native-desktop`/
 * `mobile-flow` verify types remain out of scope for the agent engine (§5.14),
 * so this stays the only live backend for those types on the legacy chain.
 * Re-enable as the default by reverting the isAgentStampedRun dispatch
 * (verificationScheduler.ts) or by leaving the kill switch set.
 *
 * SCOPE OF THE MARKER: the CAPTURE surface, not the whole class.
 * {@link PeekabooBackend.healthCheck} and {@link PeekabooBackend.probeGrants}
 * are live on the DEFAULT engine — index.ts wires them as the agent preflight's
 * `nativeCaptureProbe` and the §6 health panel's two TCC grant rows
 * (docs/proposals/verification-setup-flow.md §4/§6), which is the point: the
 * gate and the panel must read the grants from the same source, and this is the
 * one implementation that asks the OS. Keep them working when changing anything
 * above.
 */
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type {
  CaptureContext,
  CaptureResult,
  NativeGrantProbe,
  NativeGrants,
  VerificationRequestInput,
  VisualBackend,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import { VERIFY_SCREEN_LEASE } from '../../orchestrator/verify/verificationScheduler';
import { PEEKABOO_PATH_FALLBACK } from './peekabooExecutablePath';
import type { LoggerLike } from '../../orchestrator/types';

/**
 * The default app target Peekaboo screenshots when the request declares none.
 * 'Cyboflow' is the packaged app's window owner; in `pnpm dev` the app runs under
 * 'Electron'. Both names resolve to cyboflow's OWN renderer (the native-desktop
 * deliverable). Override at construction (PeekabooBackendOptions.appTarget) for a
 * dev build or to capture a different running app.
 */
const DEFAULT_APP_TARGET = 'Cyboflow';

/** How long a single peekaboo CLI invocation may run before it is aborted. */
const CAPTURE_TIMEOUT_MS = 30_000;

/**
 * The narrow, INJECTED transport seam over the `peekaboo` CLI. The production
 * implementation (DefaultPeekabooClient) shells out via node:child_process; tests
 * inject a fake so NO real binary runs. Keeping the binary behind this interface
 * is what keeps the backend unit-testable AND keeps the only child_process code in
 * one small, swappable place.
 */
export interface PeekabooClient {
  /**
   * Probe whether the `peekaboo` binary is present on PATH. Returns false (never
   * throws) when it is absent — the first gate of healthCheck.
   */
  binaryAvailable(): Promise<boolean>;
  /**
   * Read the two required macOS TCC grants (Screen Recording + Accessibility)
   * off the host binary, SEPARATELY.
   *
   * REJECTS when the CLI could not answer — a bad exit, unparseable output, a
   * timeout. That is deliberately not the same as "denied": the caller decides
   * what an unanswerable probe means. {@link PeekabooBackend.healthCheck} folds
   * it to `false` (degrade to SKIPPED, never wedge a sprint);
   * {@link PeekabooBackend.probeGrants} reports it as `'inconclusive'` so the
   * §6 panel never tells a user to re-grant a permission they already hold.
   */
  permissions(): Promise<NativeGrants>;
  /**
   * Capture a screenshot of `appTarget` into `outPath` (an absolute PNG path). The
   * production impl runs `peekaboo image --app <appTarget> --path <outPath>`. The
   * AbortSignal cancels a hung capture (per-request timeout / cancelForRun /
   * teardown). Resolves on success; REJECTS on any failure (the backend catches it
   * and returns ok:false — soft fall-forward, never a throw past capture()).
   */
  capture(args: { appTarget: string; outPath: string }, signal: AbortSignal): Promise<void>;
}

/** Construction-time deps (all optional; tests inject fakes). */
export interface PeekabooBackendOptions {
  logger?: LoggerLike;
  /**
   * The injected CLI transport. Defaults to DefaultPeekabooClient (shells out to
   * the real `peekaboo` binary). Tests inject a fake — no real binary/capture.
   */
  client?: PeekabooClient;
  /**
   * The app whose window Peekaboo screenshots. Defaults to DEFAULT_APP_TARGET
   * ('Cyboflow') — cyboflow's OWN renderer. Set to 'Electron' for a `pnpm dev`
   * build.
   */
  appTarget?: string;
  /** Per-capture timeout (ms). Defaults to CAPTURE_TIMEOUT_MS. */
  captureTimeoutMs?: number;
  /**
   * The `peekaboo` binary to run. Defaults to the bare name (PATH lookup);
   * `index.ts` passes the copy bundled in the app, whose stable path is what
   * keeps the macOS TCC grants from being revoked on every version bump — see
   * `peekabooExecutablePath.ts`.
   */
  executablePath?: string;
}

/**
 * The PRODUCTION PeekabooClient: shells out to the `peekaboo` CLI via
 * node:child_process. Lives behind the injected interface so it is the ONLY
 * child_process code in this slice and is fully swappable in tests. EVERY method
 * soft-fails (probes ⇒ false; capture ⇒ reject, caught by the backend ⇒ ok:false)
 * so a missing binary / declined TCC grant degrades to SKIPPED, never throws past
 * the backend and never hangs a sprint.
 */
export class DefaultPeekabooClient implements PeekabooClient {
  private readonly logger?: LoggerLike;
  private readonly captureTimeoutMs: number;
  private readonly executablePath: string;

  constructor(
    opts: { logger?: LoggerLike; captureTimeoutMs?: number; executablePath?: string } = {},
  ) {
    this.logger = opts.logger;
    this.captureTimeoutMs = opts.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
    // Defaults to the bare name (resolved off PATH) so a caller that does not
    // care keeps the pre-bundling behaviour. index.ts passes the bundled path.
    this.executablePath = opts.executablePath ?? PEEKABOO_PATH_FALLBACK;
  }

  async binaryAvailable(): Promise<boolean> {
    try {
      // `peekaboo --version` resolves only when the binary is on PATH; a missing
      // binary throws ENOENT (caught → false). Short timeout so a wedged binary
      // never blocks the probe.
      await this.run(this.executablePath, ['--version'], 5_000);
      return true;
    } catch (err) {
      this.logger?.info('[PeekabooBackend] binary not available', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async permissions(): Promise<NativeGrants> {
    // `peekaboo permissions --json-output` reports the two required TCC grants.
    //
    // The FLAG IS LOAD-BEARING: `--json` is not a synonym, it is an unknown
    // option, and peekaboo exits 64 on it. This read `--json` until 2026-08-05,
    // which meant every probe rejected and native-screen could never be
    // available on ANY host — including one holding both grants.
    //
    // Deliberately no catch: an unanswerable probe propagates so the caller can
    // tell "declined" from "could not ask".
    const stdout = await this.run(this.executablePath, ['permissions', '--json-output'], 5_000);
    return parsePermissionsJson(stdout);
  }

  async capture(
    args: { appTarget: string; outPath: string },
    signal: AbortSignal,
  ): Promise<void> {
    // `peekaboo image --app <target> --path <out.png>` screenshots the running
    // app. A non-zero exit / missing PNG rejects (caught by the backend ⇒
    // ok:false). The signal aborts a hung capture.
    await this.run(
      this.executablePath,
      ['image', '--app', args.appTarget, '--path', args.outPath],
      this.captureTimeoutMs,
      signal,
    );
  }

  /**
   * Spawn a child process, resolve its stdout on a clean (code 0) exit, reject on
   * a non-zero exit / spawn error / timeout / abort. node:child_process is
   * imported LAZILY here so this service file carries no eager child_process
   * require at module load (and the import lives ONLY in this concrete client,
   * never in the electron-free orchestrator).
   */
  private async run(
    cmd: string,
    cmdArgs: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const { spawn } = await import('node:child_process');
    return await new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('peekaboo capture aborted'));
        return;
      }
      const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settleResolve = (value: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Best-effort kill of the child so a wedged binary never lingers.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(err);
      };

      const timer = setTimeout(
        () => settleReject(new Error(`peekaboo timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const onAbort = (): void => settleReject(new Error('peekaboo capture aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err: Error) => settleReject(err));
      child.on('close', (code: number | null) => {
        if (code === 0) {
          settleResolve(stdout);
        } else {
          settleReject(
            new Error(`peekaboo exited ${code ?? 'null'}${stderr ? `: ${stderr.trim()}` : ''}`),
          );
        }
      });
    });
  }
}

/** Accepted spellings of each grant, across peekaboo CLI versions. */
const SCREEN_RECORDING_KEYS = ['screen_recording', 'screenRecording', 'screenCapture'] as const;
const ACCESSIBILITY_KEYS = ['accessibility'] as const;

/**
 * Parse `peekaboo permissions --json-output` into the two grants, SEPARATELY.
 *
 * THROWS on any output it cannot read. That is the point: a shape this does not
 * recognise means the probe did not answer, and answering "both denied" on its
 * behalf is how a healthy host gets told to go fix permissions it already has.
 * Only the caller knows whether an unanswerable probe should degrade (the
 * scheduler gate) or be shown as unknown (the §6 panel).
 *
 * Within a recognised object, an absent or non-`true` grant IS a denial — that
 * much peekaboo does report faithfully.
 */
export function parsePermissionsJson(stdout: string): NativeGrants {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `peekaboo permissions output was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const grants = locateGrants(parsed);
  if (grants === null) {
    throw new Error('peekaboo permissions output carried no recognisable permissions object');
  }
  return {
    screenRecording: isGranted(grants, SCREEN_RECORDING_KEYS),
    accessibility: isGranted(grants, ACCESSIBILITY_KEYS),
  };
}

/**
 * Find the object carrying the grant keys, tolerating the CLI's nesting.
 *
 * v2.x wraps its whole payload in an envelope — `{ success, data: { permissions:
 * {...} }, debug_logs }` — so a reader that only knew `{ permissions }` and a
 * flat shape found nothing and silently reported both grants denied. Rather
 * than pin one version's schema, try each known nesting OUTSIDE-IN and accept
 * the first that actually carries a grant key; anything else is `null`, i.e. an
 * output we do not understand, which the caller turns into a throw.
 *
 * v3 replaced the keyed object with a LIST of named grants, so a list is
 * normalised into the keyed shape first. Reading it here rather than at the
 * version bump keeps that bump a one-line change in
 * `peekabooExecutablePath.ts`.
 */
function locateGrants(parsed: unknown): Record<string, unknown> | null {
  const root = asRecord(parsed);
  if (root === null) return null;
  const data = asRecord(root.data);
  const candidates = [
    asRecord(data?.permissions) ?? fromGrantList(data?.permissions),
    asRecord(root.permissions) ?? fromGrantList(root.permissions),
    data,
    root,
  ];
  return candidates.find((c) => c !== null && carriesGrantKey(c)) ?? null;
}

/**
 * Normalise v3's `[{ name: 'Screen Recording', isGranted: true }, …]` into the
 * keyed shape the rest of this reader expects.
 *
 * Names are lowercased and de-spaced so 'Screen Recording' meets
 * `screen_recording`. Grants beyond the two we require (v3 also reports Event
 * Synthesizing, among others) fall through harmlessly — an unrecognised key
 * simply never gets read.
 *
 * An entry whose grant is not a BOOLEAN is dropped rather than stored. Storing
 * it would satisfy {@link carriesGrantKey} while carrying nothing readable, so
 * a payload spelling the field some other way would parse "successfully" into
 * both grants denied — a confident denial invented from output we did not
 * understand, which is the exact outcome {@link parsePermissionsJson} throws to
 * prevent. Dropping it instead lets the whole list read as unrecognised, and an
 * unrecognised shape becomes `inconclusive`, not `missing`.
 */
function fromGrantList(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const grants: Record<string, unknown> = {};
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null || typeof record.name !== 'string') continue;
    if (typeof record.isGranted !== 'boolean') continue;
    grants[record.name.toLowerCase().replace(/\s+/g, '_')] = record.isGranted;
  }
  return Object.keys(grants).length > 0 ? grants : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Whether an object mentions either grant AT ALL — the marker that it is the grants object. */
function carriesGrantKey(candidate: Record<string, unknown>): boolean {
  return [...SCREEN_RECORDING_KEYS, ...ACCESSIBILITY_KEYS].some((k) => k in candidate);
}

/** True iff ANY of the candidate keys on `grants` is the boolean `true`. */
function isGranted(grants: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((k) => grants[k] === true);
}

export class PeekabooBackend implements VisualBackend {
  readonly id: VisualBackendId = 'peekaboo';
  readonly rung = 2;

  private readonly logger?: LoggerLike;
  private readonly client: PeekabooClient;
  private readonly appTarget: string;

  constructor(opts: PeekabooBackendOptions = {}) {
    this.logger = opts.logger;
    this.client =
      opts.client ??
      new DefaultPeekabooClient({
        logger: opts.logger,
        captureTimeoutMs: opts.captureTimeoutMs,
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      });
    this.appTarget = opts.appTarget ?? DEFAULT_APP_TARGET;
  }

  /**
   * ALWAYS the count-1 VERIFY_SCREEN_LEASE — physics: one display / focus / input.
   * The scheduler (Peekaboo's SOLE client) serializes all native-desktop captures
   * app-wide through the shared mutex. The lease is request-independent (every
   * Peekaboo capture contends for the one screen), so the input is unused.
   */
  requiredLease(_input: VerificationRequestInput): string | null {
    return VERIFY_SCREEN_LEASE;
  }

  /**
   * The FULL native-grant picture: which of the two grants is held, or why the
   * host could not be asked. This is the reporting surface (§6 health panel) —
   * {@link healthCheck} is the gate that folds the same probe to one boolean.
   *
   * Never throws. The three outcomes are distinct on purpose: `'binary-missing'`
   * and `'inconclusive'` both mean "no grant was observed", but only a denial
   * justifies pointing a user at System Settings.
   */
  async probeGrants(): Promise<NativeGrantProbe> {
    let present: boolean;
    try {
      present = await this.client.binaryAvailable();
    } catch (err) {
      return { kind: 'inconclusive', detail: errorText(err) };
    }
    if (!present) {
      return { kind: 'binary-missing', detail: 'the peekaboo binary could not be run' };
    }
    try {
      const grants = await this.client.permissions();
      return { kind: 'ok', ...grants };
    } catch (err) {
      this.logger?.info('[PeekabooBackend] permissions probe could not answer', {
        error: errorText(err),
      });
      return { kind: 'inconclusive', detail: errorText(err) };
    }
  }

  /**
   * Health = the `peekaboo` binary is runnable AND BOTH required TCC grants
   * (Screen Recording + Accessibility) are held by the host binary. A missing
   * binary, a declined grant, OR a probe that could not answer ⇒ false (the
   * resolver / scheduler drops peekaboo ⇒ SKIPPED, never FAIL, never hang — the
   * recurring SPRINT-031..039 gotcha). Never throws.
   *
   * The gate collapses `'inconclusive'` into `false` where the panel does not:
   * proceeding on an unverified grant would hang a sprint on a permission
   * dialog, and a skip is recoverable where a wedge is not.
   */
  async healthCheck(): Promise<boolean> {
    const probe = await this.probeGrants();
    return probe.kind === 'ok' && probe.screenRecording && probe.accessibility;
  }

  /**
   * Screenshot the running app target into artifactsDir as `<appTarget>.png`. EVERY
   * error path soft-fails (ok:false) — a CLI failure / missing binary / declined
   * TCC at dispatch is a fall-forward, never a throw. Native-desktop has no
   * viewports (it captures the one real window), so this writes a single PNG.
   */
  async capture(ctx: CaptureContext, signal: AbortSignal): Promise<CaptureResult> {
    if (signal.aborted) {
      return { ok: false, fileNames: [], error: 'capture aborted' };
    }
    const fileName = `${fileStem(this.appTarget)}.png`;
    const outPath = join(ctx.artifactsDir, fileName);
    try {
      await mkdir(ctx.artifactsDir, { recursive: true });
      await this.client.capture({ appTarget: this.appTarget, outPath }, signal);
      return { ok: true, fileNames: [basename(fileName)] };
    } catch (err) {
      return { ok: false, fileNames: [], error: errorText(err) };
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sanitize an app target into a safe PNG basename stem (same rule as the other
 * backends' viewport stems). Falls back to 'app' when it sanitizes to empty so a
 * strange target name can never escape artifactsDir or produce a nameless file.
 */
function fileStem(target: string): string {
  const cleaned = target.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'app';
}
