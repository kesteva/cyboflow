/**
 * PeekabooGrantProbe — the host's native-screen capability probe: is the
 * `peekaboo` binary runnable, and does the host hold the two macOS TCC grants
 * (Screen Recording + Accessibility) a native-screen verification needs?
 *
 * Two live consumers read it, and they must read the SAME instance so they can
 * never disagree about this host (docs/proposals/verification-setup-flow.md
 * §4/§6):
 *  - {@link PeekabooGrantProbe.healthCheck} is the scheduler's native-screen
 *    modality gate and the verification-agent preflight's `nativeCaptureProbe`
 *    — the probe folded to one never-throwing boolean.
 *  - {@link PeekabooGrantProbe.probeGrants} feeds the §6 health panel's two TCC
 *    grant rows, keeping "declined" apart from "could not ask".
 * verifyComposition.ts wires both.
 *
 * This file lives under main/src/services/* and MAY shell out to the `peekaboo`
 * CLI via node:child_process (the PRODUCTION {@link DefaultPeekabooProbeClient})
 * — but the binary is invoked behind an INJECTED {@link PeekabooProbeClient}
 * interface so the probe is fully unit-testable (tests inject a fake client: no
 * real binary runs). The main process is NOT an MCP protocol client of peekaboo;
 * the deployed verification driver runs the capture itself (driverCore.ts).
 *
 * TCC + availability (the recurring SPRINT-031..039 gotcha): a missing binary,
 * a declined grant, or a probe that could not answer must NEVER wedge a sprint.
 * EVERY error path soft-fails — healthCheck() ⇒ false, probeGrants() ⇒ a
 * {@link NativeGrantProbe} — never a throw past the probe.
 */
import type { NativeGrantProbe, NativeGrants } from '../../../../shared/types/visualVerification';
import { PEEKABOO_PATH_FALLBACK } from './peekabooExecutablePath';
import type { LoggerLike } from '../../orchestrator/types';

/** How long one probe invocation of the CLI may run before it is aborted. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The narrow, INJECTED transport seam over the `peekaboo` CLI. The production
 * implementation ({@link DefaultPeekabooProbeClient}) shells out via
 * node:child_process; tests inject a fake so NO real binary runs.
 */
export interface PeekabooProbeClient {
  /**
   * Probe whether the `peekaboo` binary runs. Returns false (never throws) when
   * it is absent — the first gate of healthCheck.
   */
  binaryAvailable(): Promise<boolean>;
  /**
   * Read the two required macOS TCC grants (Screen Recording + Accessibility)
   * off the host binary, SEPARATELY.
   *
   * REJECTS when the CLI could not answer — a bad exit, unparseable output, a
   * timeout. That is deliberately not the same as "denied": the caller decides
   * what an unanswerable probe means. {@link PeekabooGrantProbe.healthCheck}
   * folds it to `false` (degrade to SKIPPED, never wedge a sprint);
   * {@link PeekabooGrantProbe.probeGrants} reports it as `'inconclusive'` so the
   * §6 panel never tells a user to re-grant a permission they already hold.
   */
  permissions(): Promise<NativeGrants>;
}

/** Construction-time deps (all optional; tests inject fakes). */
export interface PeekabooGrantProbeOptions {
  logger?: LoggerLike;
  /**
   * The injected CLI transport. Defaults to {@link DefaultPeekabooProbeClient}
   * (shells out to the real `peekaboo` binary).
   */
  client?: PeekabooProbeClient;
  /**
   * The `peekaboo` binary to run. Defaults to the bare name (PATH lookup);
   * verifyComposition.ts passes the copy bundled in the app — the SAME path the
   * deployed driver is handed, so the gate and the driver measure one binary
   * (see `peekabooExecutablePath.ts`).
   */
  executablePath?: string;
}

/**
 * The PRODUCTION PeekabooProbeClient: shells out to the `peekaboo` CLI via
 * node:child_process. Lives behind the injected interface so it is the ONLY
 * child_process code here and is fully swappable in tests.
 */
export class DefaultPeekabooProbeClient implements PeekabooProbeClient {
  private readonly logger?: LoggerLike;
  private readonly executablePath: string;

  constructor(opts: { logger?: LoggerLike; executablePath?: string } = {}) {
    this.logger = opts.logger;
    // Defaults to the bare name (resolved off PATH) so a caller that does not
    // care keeps the pre-bundling behaviour. verifyComposition.ts passes the
    // bundled path.
    this.executablePath = opts.executablePath ?? PEEKABOO_PATH_FALLBACK;
  }

  async binaryAvailable(): Promise<boolean> {
    try {
      // `peekaboo --version` resolves only when the binary runs; a missing
      // binary throws ENOENT (caught → false). Short timeout so a wedged binary
      // never blocks the probe.
      await this.run(['--version']);
      return true;
    } catch (err) {
      this.logger?.info('[PeekabooGrantProbe] binary not available', {
        error: errorText(err),
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
    const stdout = await this.run(['permissions', '--json-output']);
    return parsePermissionsJson(stdout);
  }

  /**
   * Spawn the CLI, resolve its stdout on a clean (code 0) exit, reject on a
   * non-zero exit / spawn error / timeout. node:child_process is imported LAZILY
   * so this service file carries no eager child_process require at module load.
   */
  private async run(cmdArgs: string[]): Promise<string> {
    const { spawn } = await import('node:child_process');
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.executablePath, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const settleResolve = (value: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Best-effort kill of the child so a wedged binary never lingers.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(err);
      };

      const timer = setTimeout(
        () => settleReject(new Error(`peekaboo timed out after ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS,
      );

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
    throw new Error(`peekaboo permissions output was not JSON: ${errorText(err)}`);
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

export class PeekabooGrantProbe {
  private readonly logger?: LoggerLike;
  private readonly client: PeekabooProbeClient;

  constructor(opts: PeekabooGrantProbeOptions = {}) {
    this.logger = opts.logger;
    this.client =
      opts.client ??
      new DefaultPeekabooProbeClient({
        logger: opts.logger,
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      });
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
      this.logger?.info('[PeekabooGrantProbe] permissions probe could not answer', {
        error: errorText(err),
      });
      return { kind: 'inconclusive', detail: errorText(err) };
    }
  }

  /**
   * Health = the `peekaboo` binary is runnable AND BOTH required TCC grants
   * (Screen Recording + Accessibility) are held by the host binary. A missing
   * binary, a declined grant, OR a probe that could not answer ⇒ false (the
   * native-screen gate skips the request — never FAIL, never hang). Never
   * throws.
   *
   * The gate collapses `'inconclusive'` into `false` where the panel does not:
   * proceeding on an unverified grant would hang a sprint on a permission
   * dialog, and a skip is recoverable where a wedge is not.
   */
  async healthCheck(): Promise<boolean> {
    const probe = await this.probeGrants();
    return probe.kind === 'ok' && probe.screenRecording && probe.accessibility;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
