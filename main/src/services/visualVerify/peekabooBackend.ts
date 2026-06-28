/**
 * PeekabooBackend — Rung 2 of the layered visual-verification capability ladder
 * (see docs/visual-verification-design.md §5 + §L3). It is the ONLY backend that
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
 *  - healthCheck() probes (a) the `peekaboo` binary on PATH and (b) the two
 *    required macOS TCC grants (Screen Recording + Accessibility) on the host
 *    binary. A missing binary OR a declined grant ⇒ healthCheck returns false ⇒
 *    the resolver / scheduler drops peekaboo and emits SKIPPED — never FAIL, never
 *    hang. A missing TCC grant must NEVER wedge a sprint. EVERY error path
 *    soft-fails (capture errors ⇒ CaptureResult ok:false fall-forward; probes ⇒
 *    false), never throws.
 */
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type {
  CaptureContext,
  CaptureResult,
  VerificationRequestInput,
  VisualBackend,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import { VERIFY_SCREEN_LEASE } from '../../orchestrator/verify/verificationScheduler';
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
   * Probe the two required macOS TCC grants (Screen Recording + Accessibility) on
   * the host binary. Returns true ONLY when BOTH are granted; false (never throws)
   * when either is declined / unknown — the second gate of healthCheck (a missing
   * grant must degrade to SKIPPED, never wedge a sprint).
   */
  permissionsGranted(): Promise<boolean>;
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

  constructor(opts: { logger?: LoggerLike; captureTimeoutMs?: number } = {}) {
    this.logger = opts.logger;
    this.captureTimeoutMs = opts.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
  }

  async binaryAvailable(): Promise<boolean> {
    try {
      // `peekaboo --version` resolves only when the binary is on PATH; a missing
      // binary throws ENOENT (caught → false). Short timeout so a wedged binary
      // never blocks the probe.
      await this.run('peekaboo', ['--version'], 5_000);
      return true;
    } catch (err) {
      this.logger?.info('[PeekabooBackend] binary not available', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async permissionsGranted(): Promise<boolean> {
    try {
      // `peekaboo permissions --json` reports the two required TCC grants. We
      // require BOTH Screen Recording AND Accessibility; a declined/unknown grant
      // ⇒ false (degrade to SKIPPED, never wedge). The JSON shape is tolerated
      // loosely (the CLI's exact schema varies by version) — any field that is not
      // an explicit `true` for both grants fails the probe.
      const stdout = await this.run('peekaboo', ['permissions', '--json'], 5_000);
      return parsePermissionsJson(stdout);
    } catch (err) {
      this.logger?.info('[PeekabooBackend] permissions probe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async capture(
    args: { appTarget: string; outPath: string },
    signal: AbortSignal,
  ): Promise<void> {
    // `peekaboo image --app <target> --path <out.png>` screenshots the running
    // app. A non-zero exit / missing PNG rejects (caught by the backend ⇒
    // ok:false). The signal aborts a hung capture.
    await this.run(
      'peekaboo',
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
      const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Parse the `peekaboo permissions --json` output, requiring BOTH the Screen
 * Recording AND Accessibility grants to be explicitly `true`. The CLI's exact
 * JSON schema varies by version, so this reads it defensively: any shape that does
 * not present both grants as `true` ⇒ false (degrade to SKIPPED). Never throws —
 * a parse error returns false.
 */
function parsePermissionsJson(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    // Tolerate either a flat shape ({ screenRecording, accessibility }) or a
    // nested { permissions: {...} } wrapper.
    const grants =
      typeof record.permissions === 'object' && record.permissions !== null
        ? (record.permissions as Record<string, unknown>)
        : record;
    return isGranted(grants, ['screenRecording', 'screen_recording', 'screenCapture']) &&
      isGranted(grants, ['accessibility']);
  } catch {
    return false;
  }
}

/** True iff ANY of the candidate keys on `grants` is the boolean `true`. */
function isGranted(grants: Record<string, unknown>, keys: string[]): boolean {
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
   * Health = the `peekaboo` binary is on PATH AND BOTH required TCC grants (Screen
   * Recording + Accessibility) are held by the host binary. A missing binary OR a
   * declined grant ⇒ false (the resolver / scheduler drops peekaboo ⇒ SKIPPED,
   * never FAIL, never hang — the recurring SPRINT-031..039 gotcha). Never throws.
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!(await this.client.binaryAvailable())) {
        return false;
      }
      return await this.client.permissionsGranted();
    } catch (err) {
      this.logger?.warn('[PeekabooBackend] healthCheck threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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
      return {
        ok: false,
        fileNames: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
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
