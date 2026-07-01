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
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import { BrowserWindow } from 'electron';
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

    let win: BrowserWindow | null = null;
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

      await loadTarget(win, target, signal);

      const fileNames: string[] = [];
      const usedStems = new Set<string>();
      for (let i = 0; i < viewports.length; i++) {
        if (signal.aborted) {
          return { ok: false, fileNames, error: 'capture aborted' };
        }
        const vp = viewports[i];
        // setContentSize sizes the renderable area (not incl. chrome — there is
        // none on an offscreen window, but this is the documented sizing call).
        win.setContentSize(vp.width, vp.height);

        // Abort/timeout-bounded so a wedged offscreen renderer can never leave this
        // await (and the scheduler's detached work) hanging with a leaked window.
        const png = await captureViewportPng(win, signal, this.capturePageTimeoutMs);
        if (png.length === 0) {
          // A blank/zero-byte snapshot is a runtime failure for this viewport;
          // surface it so the scheduler records the request as failed.
          return {
            ok: false,
            fileNames,
            error: `capturePage produced an empty image for viewport ${vp.label ?? i}`,
          };
        }

        let stem = viewportFileStem(vp.label, i);
        // Guarantee uniqueness if two viewports share a label.
        if (usedStems.has(stem)) stem = `${stem}-${i}`;
        usedStems.add(stem);

        const fileName = `${stem}.png`;
        await writeFile(join(ctx.artifactsDir, fileName), png);
        fileNames.push(basename(fileName));
      }

      return { ok: true, fileNames };
    } catch (err) {
      return {
        ok: false,
        fileNames: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
  }
}
