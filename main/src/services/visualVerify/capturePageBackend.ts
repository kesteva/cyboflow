/**
 * CapturePageBackend — Rung 0 of the layered visual-verification capability
 * ladder (see docs/visual-verification-design.md §5). It renders a deliverable
 * (a localhost URL or a built HTML file) in an OFFSCREEN Electron BrowserWindow
 * and snapshots it with `webContents.capturePage()` → PNG, one PNG per requested
 * viewport. Zero external deps, zero OS permissions, CPU-parallel, NO lease — the
 * cheapest rung and the default first hop of the static-render / responsive
 * chains.
 *
 * This file lives under main/src/services/* and MAY import 'electron' — it is the
 * concrete, electron-backed half injected into the (electron-free) scheduler as a
 * VerificationBackend. The scheduler never imports this; index.ts wires it in.
 *
 * Limits (MVP): render-only. It cannot click/navigate/wait-for, so it is absent
 * from the interactive-web chain by construction (BACKEND_CAPABILITIES). For
 * cyboflow's OWN renderer it would fail identically to playwright (the renderer
 * needs the preload-injected electronTRPC), which is why native-desktop routes to
 * Peekaboo instead — capturePage is for plain web deliverables only.
 *
 * S9 companions (purely additive — never change control flow or the PNG bytes
 * produced): (A) untrusted capture diagnostics collected from page console
 * `error` output plus capture-side notes (the file:// CORS breadcrumb, fold
 * truncation) and surfaced on CaptureResult.diagnostics for HUMAN surfaces only
 * — this text is page-controlled and MUST NEVER reach the VlmJudge; (B) a
 * pixel-budget fold clamp for the lone default viewport on the
 * static-render-snapshot path, so a tall page doesn't blow memory in an
 * offscreen window sized purely by page-controlled scrollHeight.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import { BrowserWindow } from 'electron';
import type { Event as ElectronEvent, WebContentsConsoleMessageEventParams } from 'electron';
import type {
  CaptureContext,
  CaptureResult,
  VerificationRequestInput,
  VisualBackend,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';

/** Default viewport when the request declares none — a common desktop size. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800, label: 'default' } as const;

/**
 * How long to wait for a single page to finish loading before giving up on that
 * viewport. The per-request AbortSignal (timeout / cancelForRun / teardown) also
 * short-circuits the wait; this is the fallback ceiling for a page that never
 * fires 'did-finish-load' (e.g. a hung dev server).
 */
const LOAD_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a single `webContents.capturePage()` to resolve before
 * giving up on that viewport. An offscreen renderer can WEDGE (GPU/compositor
 * stall) so the raw capturePage() promise may never settle; without this ceiling
 * the scheduler's detached capture work leaks a wedged BrowserWindow forever. The
 * per-request AbortSignal (deadline / cancelForRun) also short-circuits the wait.
 * Injectable via CapturePageBackendOptions so tests can drive it fast.
 */
const CAPTURE_PAGE_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the fold-height probe (`document.documentElement.scrollHeight`,
 * Companion B) before giving up on it. This is a BEST-EFFORT measurement — unlike
 * LOAD_TIMEOUT_MS / CAPTURE_PAGE_TIMEOUT_MS a timeout here never fails the capture,
 * it just falls back to DEFAULT_VIEWPORT.height (see measureFoldHeight). Kept short
 * relative to those ceilings since a hung page has already been given LOAD_TIMEOUT_MS
 * to settle by the time this probe runs.
 */
const FOLD_MEASURE_TIMEOUT_MS = 5_000;

/**
 * Hard ceiling on the fold-clamped default-viewport height (Companion B). Even on
 * a narrow viewport where the pixel-budget clamp below would allow more, we never
 * capture past this many px tall — a sane upper bound on "how much of one page is
 * worth one screenshot".
 */
const MAX_FOLD_HEIGHT = 4_000;

/**
 * Hard ceiling on total offscreen-window pixels (width × height) for the fold-clamped
 * default viewport (Companion B). `document.documentElement.scrollHeight` is fully
 * PAGE-CONTROLLED — a hostile or buggy deliverable could report an enormous height,
 * and a naive flat-height clamp alone still lets a WIDE viewport blow memory (e.g. a
 * declared-width-but-default-viewport case). Clamping by AREA (not just height) is
 * the actual memory guard; see clampFoldHeight.
 */
const MAX_CAPTURE_PIXELS = 12_000_000;

/**
 * Cap on the number of diagnostic lines kept per capture attempt (Companion A).
 * Diagnostics are page-controlled/best-effort notes for HUMAN surfaces, not a log
 * stream — a runaway console.error loop must not grow CaptureResult unboundedly.
 */
const MAX_DIAGNOSTIC_ENTRIES = 10;

/**
 * Cap on the TOTAL characters across all diagnostic lines per capture attempt
 * (Companion A), enforced independently of MAX_DIAGNOSTIC_ENTRIES — a handful of
 * huge console messages must not blow the budget any more than a flood of small
 * ones. The entry that would cross the budget is truncated to fit exactly, then
 * further pushes are dropped silently (see DiagnosticsSink.push).
 */
const MAX_DIAGNOSTIC_CHARS = 2_000;

/**
 * The actionable breadcrumb pushed whenever resolveTarget falls back to the
 * legacy file:// load path (Companion A / Codex finding 7). Chromium CORS-blocks
 * ES-module `<script type="module">` fetches from a file:// origin, so bundler
 * output renders as a blank styled shell with NO thrown error — this line is the
 * one thing that was missing when that silent failure cost two paid judge
 * rounds. The scheduler now normally rewrites htmlPath to an http URL (S9) before
 * this backend ever sees it, so in steady state this path is rarely hit; it
 * remains the fallback for callers that construct a request directly.
 */
const FILE_URL_DIAGNOSTIC =
  'loaded over file:// — Chromium CORS-blocks ES-module scripts from file origins, ' +
  'so bundler output renders blank; pass a url or let the scheduler serve the htmlPath (S9)';

/**
 * Accumulates the untrusted, human-facing capture diagnostics for ONE capture
 * attempt (Companion A). Two independent caps apply — MAX_DIAGNOSTIC_ENTRIES and
 * MAX_DIAGNOSTIC_CHARS — because page console output is attacker/dev-controlled
 * text: a flood of tiny messages is bounded by the entry cap, a handful of huge
 * ones by the char cap. Once either cap is reached, further push() calls are
 * dropped silently (no error, no truncation marker beyond the clipped text
 * itself) — this sink NEVER influences control flow, only what ships on
 * CaptureResult.diagnostics for human/review surfaces.
 */
class DiagnosticsSink {
  private readonly entries: string[] = [];
  private totalChars = 0;

  push(line: string): void {
    if (this.entries.length >= MAX_DIAGNOSTIC_ENTRIES) return;
    if (this.totalChars >= MAX_DIAGNOSTIC_CHARS) return;
    const budget = MAX_DIAGNOSTIC_CHARS - this.totalChars;
    const clipped = line.length > budget ? line.slice(0, budget) : line;
    this.entries.push(clipped);
    this.totalChars += clipped.length;
  }

  /** Returns the collected lines, or undefined when empty (per CaptureResult contract). */
  toArray(): string[] | undefined {
    return this.entries.length > 0 ? [...this.entries] : undefined;
  }
}

/** Attach `diagnostics` to a CaptureResult only when non-empty — kept out-of-line so every return site stays terse. */
function withDiagnostics<T extends CaptureResult>(result: T, diagnostics: DiagnosticsSink): T {
  const arr = diagnostics.toArray();
  return arr ? { ...result, diagnostics: arr } : result;
}

/**
 * Bound an arbitrary promise by BOTH the per-request AbortSignal and a hard
 * timeout ceiling, mirroring captureViewportPng's abort/timeout shape. Used by
 * the fold-height probe (Companion B) below — that probe is best-effort (its
 * caller fails soft on any rejection), so unlike captureViewportPng this helper
 * does NOT destroy any window on abort/timeout; it only rejects.
 */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const settleResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = (): void => settleReject(new Error('capture aborted'));
    const timer = setTimeout(
      () => settleReject(new Error(`fold-height probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    if (signal.aborted) {
      settleReject(new Error('capture aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(settleResolve, (err: unknown) =>
      settleReject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/**
 * Pure clamp math for the default-viewport fold height (Companion B / Codex
 * finding 8), exported so it can be unit-tested directly for widths the fake
 * BrowserWindow harness can't easily drive end-to-end. `measuredHeight` is
 * PAGE-CONTROLLED (document.documentElement.scrollHeight) and must never be
 * trusted directly, so the result is the min of THREE bounds:
 *  - a floor at DEFAULT_VIEWPORT.height (never shrink below the normal default),
 *  - MAX_FOLD_HEIGHT (a flat ceiling),
 *  - floor(MAX_CAPTURE_PIXELS / width) — an AREA budget. This is the one that
 *    actually protects memory: a flat height ceiling alone still permits a huge
 *    pixel count on a wide viewport, so the effective height must shrink as
 *    width grows.
 */
export function clampFoldHeight(measuredHeight: number, width: number): number {
  const areaBound = Math.floor(MAX_CAPTURE_PIXELS / width);
  return Math.min(Math.max(DEFAULT_VIEWPORT.height, measuredHeight), MAX_FOLD_HEIGHT, areaBound);
}

/** Invoke the fold-height probe script against a loaded page. Isolated to one line so its return type is pinned to `unknown` (never `any`) regardless of the installed Electron types' own `executeJavaScript` signature. */
function readScrollHeight(win: BrowserWindow): Promise<unknown> {
  return win.webContents.executeJavaScript(
    '(document.documentElement && document.documentElement.scrollHeight) || 0',
  );
}

/**
 * Measure the loaded page's content height for the DEFAULT-viewport
 * static-render-snapshot path only (Companion B) so a tall deliverable isn't
 * needlessly cropped to a fixed 800px — but the raw measurement is NEVER used
 * as-is; it is always passed through clampFoldHeight first. Bounded by both the
 * request signal and FOLD_MEASURE_TIMEOUT_MS; on ANY failure (rejection,
 * timeout, abort, or a non-numeric result) this fails SOFT to
 * DEFAULT_VIEWPORT.height with a diagnostic note — a botched probe must never
 * fail the whole capture.
 */
async function measureFoldHeight(
  win: BrowserWindow,
  signal: AbortSignal,
  diagnostics: DiagnosticsSink,
): Promise<number> {
  try {
    const raw = await withDeadline(readScrollHeight(win), signal, FOLD_MEASURE_TIMEOUT_MS);
    const measured = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const effective = clampFoldHeight(measured, DEFAULT_VIEWPORT.width);
    if (measured > effective) {
      diagnostics.push(
        `page content height ${measured}px exceeds capture clamp ${effective}px — captured top region only`,
      );
    }
    return effective;
  } catch {
    diagnostics.push('fold-height measurement failed — using default viewport height');
    return DEFAULT_VIEWPORT.height;
  }
}

/** Constructor options for CapturePageBackend (test-injectable timeouts). */
export interface CapturePageBackendOptions {
  /** Per-viewport capturePage() ceiling in ms. Defaults to CAPTURE_PAGE_TIMEOUT_MS. */
  capturePageTimeoutMs?: number;
}

/**
 * Snapshot the offscreen window's current frame, but bounded by BOTH the per-request
 * AbortSignal AND a capture-side timeout. On abort OR timeout we DESTROY the window
 * (which unblocks/rejects the underlying capture and frees the wedged renderer) and
 * reject — capture()'s catch then returns ok:false and the scheduler records the
 * request terminal instead of hanging. Resolves the PNG bytes on success.
 */
function captureViewportPng(
  win: BrowserWindow,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const destroyWin = (): void => {
      if (!win.isDestroyed()) win.destroy();
    };
    const settleResolve = (png: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(png);
    };
    const settleReject = (err: Error, tearDown: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (tearDown) destroyWin();
      reject(err);
    };
    const onAbort = (): void => settleReject(new Error('capture aborted'), true);
    const timer = setTimeout(
      () => settleReject(new Error(`capturePage timed out after ${timeoutMs}ms`), true),
      timeoutMs,
    );

    if (signal.aborted) {
      settleReject(new Error('capture aborted'), true);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    win.webContents.capturePage().then(
      (image) => settleResolve(image.toPNG()),
      (err: unknown) => settleReject(err instanceof Error ? err : new Error(String(err)), false),
    );
  });
}

/**
 * Sanitize a viewport label into a safe PNG basename stem. Strips path separators
 * and odd characters so a malicious/strange label can never escape artifactsDir.
 * Falls back to the index when the label sanitizes to empty.
 */
function viewportFileStem(label: string | undefined, index: number): string {
  const cleaned = (label ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : String(index);
}

/**
 * Resolve the deliverable target. A URL is loaded as-is; an htmlPath is resolved
 * against the run worktree (artifactsDir's owning run cwd is not known here, so a
 * relative htmlPath is resolved against artifactsDir's parent expectation — but
 * since the scheduler passes an absolute artifactsDir and the input htmlPath is
 * the agent-declared path, we resolve a relative htmlPath against the process cwd
 * the same way loadFile would; an absolute path is used verbatim). Returns either
 * { url } or { filePath }, or null when neither is provided.
 */
function resolveTarget(
  input: VerificationRequestInput,
): { kind: 'url'; value: string } | { kind: 'file'; value: string } | null {
  if (input.url && input.url.trim().length > 0) {
    return { kind: 'url', value: input.url.trim() };
  }
  if (input.htmlPath && input.htmlPath.trim().length > 0) {
    const p = input.htmlPath.trim();
    return { kind: 'file', value: isAbsolute(p) ? p : join(process.cwd(), p) };
  }
  return null;
}

/**
 * Load a target into the offscreen window's webContents and resolve once the page
 * has finished loading (or reject on did-fail-load / the load timeout). The
 * AbortSignal aborts the wait early — the caller then closes the window.
 */
function loadTarget(
  win: BrowserWindow,
  target: { kind: 'url'; value: string } | { kind: 'file'; value: string },
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wc = win.webContents;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('did-fail-load', onFail);
      signal.removeEventListener('abort', onAbort);
    };
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onFinish = (): void => settleResolve();
    const onFail = (
      _e: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
    ): void => {
      // -3 is ERR_ABORTED, which Electron also fires on benign in-page redirects;
      // ignore it and let did-finish-load (or the timeout) decide.
      if (errorCode === -3) return;
      settleReject(new Error(`page load failed (${errorCode} ${errorDescription}) for ${validatedURL}`));
    };
    const onAbort = (): void => settleReject(new Error('capture aborted'));
    const timer = setTimeout(
      () => settleReject(new Error(`page load timed out after ${LOAD_TIMEOUT_MS}ms`)),
      LOAD_TIMEOUT_MS,
    );

    if (signal.aborted) {
      settleReject(new Error('capture aborted'));
      return;
    }
    wc.on('did-finish-load', onFinish);
    wc.on('did-fail-load', onFail);
    signal.addEventListener('abort', onAbort, { once: true });

    const loadPromise =
      target.kind === 'url' ? wc.loadURL(target.value) : wc.loadFile(target.value);
    // loadURL/loadFile reject on hard navigation failure; surface that too.
    loadPromise.catch((err: unknown) => {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export class CapturePageBackend implements VisualBackend {
  readonly id: VisualBackendId = 'capturePage';
  readonly rung = 0;

  /** Per-viewport capturePage() ceiling — injectable so tests drive it fast. */
  private readonly capturePageTimeoutMs: number;

  constructor(opts: CapturePageBackendOptions = {}) {
    this.capturePageTimeoutMs = opts.capturePageTimeoutMs ?? CAPTURE_PAGE_TIMEOUT_MS;
  }

  /** Rung 0 needs no scarce resource — fully parallel. */
  requiredLease(_input: VerificationRequestInput): string | null {
    return null;
  }

  /**
   * Health is unconditional in a packaged/dev Electron main process — the
   * BrowserWindow API is always present. (The resolver still intersects the chain
   * with the registry, so an absent backend is simply not registered.)
   */
  async healthCheck(): Promise<boolean> {
    return typeof BrowserWindow === 'function';
  }

  async capture(ctx: CaptureContext, signal: AbortSignal): Promise<CaptureResult> {
    const target = resolveTarget(ctx.input);
    if (!target) {
      return { ok: false, fileNames: [], error: 'no url or htmlPath provided' };
    }
    if (signal.aborted) {
      return { ok: false, fileNames: [], error: 'capture aborted' };
    }

    const viewports =
      ctx.input.viewports && ctx.input.viewports.length > 0
        ? ctx.input.viewports
        : [DEFAULT_VIEWPORT];

    // Companion B applies ONLY to the lone default viewport of a
    // static-render-snapshot request — a request with declared viewports (the
    // responsive-multi-viewport chain) or any other VerificationType must stay
    // byte-identical to pre-S9 behavior.
    const isDefaultViewportFoldPath =
      ctx.type === 'static-render-snapshot' && (!ctx.input.viewports || ctx.input.viewports.length === 0);

    // Companion A: untrusted, human-facing capture diagnostics for this attempt.
    // Populated additively below and attached to every return via withDiagnostics —
    // never read for control flow, never passed to the VlmJudge.
    const diagnostics = new DiagnosticsSink();
    if (target.kind === 'file') {
      diagnostics.push(FILE_URL_DIAGNOSTIC);
    }

    let win: BrowserWindow | null = null;
    let removeConsoleListener: (() => void) | null = null;
    try {
      await mkdir(ctx.artifactsDir, { recursive: true });

      win = new BrowserWindow({
        show: false,
        width: viewports[0].width,
        height: viewports[0].height,
        webPreferences: {
          offscreen: true,
          // Render the deliverable in isolation — no node, no preload bleed.
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      // Collect ERROR-level page console output for the lifetime of this window
      // (Companion A). Attached before loadTarget so console output during load
      // itself is captured, not just output emitted after did-finish-load.
      const onConsoleMessage = (event: ElectronEvent<WebContentsConsoleMessageEventParams>): void => {
        if (event.level !== 'error') return;
        diagnostics.push(`${event.sourceId}:${event.lineNumber} ${event.message}`);
      };
      win.webContents.on('console-message', onConsoleMessage);
      const winForCleanup = win;
      removeConsoleListener = () => winForCleanup.webContents.removeListener('console-message', onConsoleMessage);

      await loadTarget(win, target, signal);

      // Companion B: measure + clamp the fold height ONLY on the default-viewport
      // static-render-snapshot path, once, before the (single-iteration) capture
      // loop below applies it via the existing setContentSize call.
      const defaultFoldHeight = isDefaultViewportFoldPath
        ? await measureFoldHeight(win, signal, diagnostics)
        : DEFAULT_VIEWPORT.height;

      const fileNames: string[] = [];
      const usedStems = new Set<string>();
      for (let i = 0; i < viewports.length; i++) {
        if (signal.aborted) {
          return withDiagnostics({ ok: false, fileNames, error: 'capture aborted' }, diagnostics);
        }
        const vp = viewports[i];
        const height = isDefaultViewportFoldPath ? defaultFoldHeight : vp.height;
        // setContentSize sizes the renderable area (not incl. chrome — there is
        // none on an offscreen window, but this is the documented sizing call).
        win.setContentSize(vp.width, height);

        // Abort/timeout-bounded so a wedged offscreen renderer can never leave this
        // await (and the scheduler's detached work) hanging with a leaked window.
        const png = await captureViewportPng(win, signal, this.capturePageTimeoutMs);
        if (png.length === 0) {
          // A blank/zero-byte snapshot is a runtime failure for this viewport;
          // surface it so the scheduler records the request as failed.
          return withDiagnostics(
            {
              ok: false,
              fileNames,
              error: `capturePage produced an empty image for viewport ${vp.label ?? i}`,
            },
            diagnostics,
          );
        }

        let stem = viewportFileStem(vp.label, i);
        // Guarantee uniqueness if two viewports share a label.
        if (usedStems.has(stem)) stem = `${stem}-${i}`;
        usedStems.add(stem);

        const fileName = `${stem}.png`;
        await writeFile(join(ctx.artifactsDir, fileName), png);
        fileNames.push(basename(fileName));
      }

      return withDiagnostics({ ok: true, fileNames }, diagnostics);
    } catch (err) {
      return withDiagnostics(
        {
          ok: false,
          fileNames: [],
          error: err instanceof Error ? err.message : String(err),
        },
        diagnostics,
      );
    } finally {
      removeConsoleListener?.();
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
  }
}
