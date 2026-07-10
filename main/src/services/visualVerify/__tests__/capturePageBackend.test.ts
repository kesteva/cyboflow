/**
 * CapturePageBackend (Rung 0) unit tests.
 *
 * The host-Node test environment has no GPU / real Electron, so `electron` is
 * mocked with a FAKE offscreen BrowserWindow that drives the real load lifecycle
 * (fires 'did-finish-load') and returns a real PNG buffer from
 * capturePage().toPNG(). This exercises the backend's actual orchestration —
 * mkdir, the per-viewport setContentSize loop, writeFile, basename sanitization,
 * abort handling, and window teardown — and asserts a PNG lands in a temp
 * artifactsDir, per the P7 spec. The render itself is the only thing faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureContext } from '../../../../../shared/types/visualVerification';

// Knobs + the 1x1 PNG the fake window uses. Hoisted so the (hoisted) vi.mock
// factory and the test body share the same object reference — a plain top-level
// const would be referenced before initialization inside the hoisted factory.
const fakeWindowControls = vi.hoisted(() => ({
  failLoad: false,
  emptyPng: false,
  neverFinish: false,
  neverCapture: false,
  setContentSizeCalls: [] as Array<[number, number]>,
  destroyed: 0,
  // The smallest valid PNG, as bytes capturePage().toPNG() returns.
  onePxPng: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
  // S9 companion A: console-message events the fake emits right after a
  // successful load, so tests can drive the error-level diagnostics collector.
  consoleMessages: [] as Array<{ level: string; message: string; lineNumber: number; sourceId: string }>,
  // S9 companion B: the fold-height probe's fake executeJavaScript() result/behavior.
  foldHeight: 800,
  foldHeightReject: false,
  execJsCallCount: 0,
}));

// The fake classes live INSIDE the mock factory because vi.mock is hoisted above
// all module-level class declarations — a top-level class would be referenced
// before initialization. The factory closes over the hoisted controls object.
vi.mock('electron', () => {
  // `require` inside the hoisted factory: vi.mock is hoisted above all top-level
  // imports, so a top-level `import { EventEmitter }` is in the TDZ when this
  // factory's class is defined. The factory-local require is the vitest-idiomatic
  // way to reach a builtin from inside a hoisted mock.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
  class FakeWebContents extends EE {
    async loadURL(): Promise<void> {
      if (fakeWindowControls.neverFinish) return; // never emits did-finish-load
      queueMicrotask(() => {
        if (fakeWindowControls.failLoad) {
          this.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_REFUSED', 'http://x');
        } else {
          // Emit any test-configured console-message events BEFORE did-finish-load
          // — mirrors real pages that can log during the load itself.
          for (const msg of fakeWindowControls.consoleMessages) {
            this.emit('console-message', {
              level: msg.level,
              message: msg.message,
              lineNumber: msg.lineNumber,
              sourceId: msg.sourceId,
            });
          }
          this.emit('did-finish-load');
        }
      });
    }
    async loadFile(): Promise<void> {
      return this.loadURL();
    }
    async capturePage(): Promise<{ toPNG: () => Buffer }> {
      // A wedged offscreen renderer: capturePage() never resolves. Exercises the
      // backend's abort/timeout bound (the window must be destroyed, not leaked).
      if (fakeWindowControls.neverCapture) return new Promise<{ toPNG: () => Buffer }>(() => {});
      return {
        toPNG: () => (fakeWindowControls.emptyPng ? Buffer.alloc(0) : fakeWindowControls.onePxPng),
      };
    }
    // S9 companion B: fakes the fold-height probe script's result. Counts calls
    // so tests can assert the probe was (or was not) invoked at all.
    async executeJavaScript(): Promise<unknown> {
      fakeWindowControls.execJsCallCount++;
      if (fakeWindowControls.foldHeightReject) {
        throw new Error('executeJavaScript failed');
      }
      return fakeWindowControls.foldHeight;
    }
  }
  class FakeBrowserWindow {
    webContents = new FakeWebContents();
    private _destroyed = false;
    constructor(_opts: unknown) {}
    setContentSize(w: number, h: number): void {
      fakeWindowControls.setContentSizeCalls.push([w, h]);
    }
    isDestroyed(): boolean {
      return this._destroyed;
    }
    destroy(): void {
      this._destroyed = true;
      fakeWindowControls.destroyed++;
    }
  }
  return { BrowserWindow: FakeBrowserWindow };
});

// Imported AFTER the mock so the backend binds to the fake BrowserWindow.
import { CapturePageBackend, clampFoldHeight } from '../capturePageBackend';

let artifactsDir: string;

beforeEach(async () => {
  fakeWindowControls.failLoad = false;
  fakeWindowControls.emptyPng = false;
  fakeWindowControls.neverFinish = false;
  fakeWindowControls.neverCapture = false;
  fakeWindowControls.setContentSizeCalls = [];
  fakeWindowControls.destroyed = 0;
  fakeWindowControls.consoleMessages = [];
  // Matches DEFAULT_VIEWPORT.height so pre-existing tests that don't care about
  // the fold probe see setContentSize called with the SAME height as before S9.
  fakeWindowControls.foldHeight = 800;
  fakeWindowControls.foldHeightReject = false;
  fakeWindowControls.execJsCallCount = 0;
  artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-capture-'));
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

function ctx(over: Partial<CaptureContext['input']> = {}): CaptureContext {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    artifactsDir,
    type: 'static-render-snapshot',
    input: { intent: 'looks right', url: 'http://localhost:5173', ...over },
  };
}

describe('CapturePageBackend', () => {
  it('has the rung-0 contract and no lease', () => {
    const b = new CapturePageBackend();
    expect(b.id).toBe('capturePage');
    expect(b.rung).toBe(0);
    expect(b.requiredLease({ intent: 'x', url: 'http://x' })).toBeNull();
  });

  it('healthCheck is true when BrowserWindow is present', async () => {
    expect(await new CapturePageBackend().healthCheck()).toBe(true);
  });

  it('writes a default-viewport PNG into a (created) artifactsDir', async () => {
    // Use a nested, not-yet-created dir to prove mkdir runs.
    const nested = join(artifactsDir, 'runs', 'run-1');
    const res = await new CapturePageBackend().capture(
      { ...ctx(), artifactsDir: nested },
      new AbortController().signal,
    );
    expect(res.ok).toBe(true);
    expect(res.fileNames).toEqual(['default.png']);
    const bytes = await readFile(join(nested, 'default.png'));
    expect(bytes.length).toBeGreaterThan(0);
    expect(fakeWindowControls.destroyed).toBe(1); // window closed in finally
  });

  it('loads from htmlPath when no url is given', async () => {
    const html = join(artifactsDir, 'index.html');
    await writeFile(html, '<!doctype html><h1>hi</h1>');
    const res = await new CapturePageBackend().capture(
      ctx({ url: undefined, htmlPath: html }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(true);
    expect(res.fileNames).toEqual(['default.png']);
  });

  it('captures one PNG per viewport with sanitized, unique basenames', async () => {
    const res = await new CapturePageBackend().capture(
      ctx({
        viewports: [
          { width: 375, height: 812, label: 'mobile' },
          { width: 1280, height: 800, label: 'desktop/wide' },
          { width: 768, height: 1024 },
        ],
      }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(true);
    expect(res.fileNames).toEqual(['mobile.png', 'desktop-wide.png', '2.png']);
    const onDisk = (await readdir(artifactsDir)).sort();
    expect(onDisk).toEqual(['2.png', 'desktop-wide.png', 'mobile.png']);
    // setContentSize called once per viewport, in order.
    expect(fakeWindowControls.setContentSizeCalls).toEqual([
      [375, 812],
      [1280, 800],
      [768, 1024],
    ]);
  });

  it('returns ok:false when neither url nor htmlPath is provided', async () => {
    const res = await new CapturePageBackend().capture(
      ctx({ url: undefined, htmlPath: undefined }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(false);
    expect(res.fileNames).toEqual([]);
    expect(res.error).toMatch(/no url or htmlPath/i);
  });

  it('returns ok:false (and closes the window) on a page load failure', async () => {
    fakeWindowControls.failLoad = true;
    const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/page load failed/i);
    expect(fakeWindowControls.destroyed).toBe(1);
  });

  it('returns ok:false on an empty (zero-byte) snapshot', async () => {
    fakeWindowControls.emptyPng = true;
    const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty image/i);
  });

  it('aborts before starting when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await new CapturePageBackend().capture(ctx(), ac.signal);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/aborted/i);
  });

  it('aborts mid-capture (capturePage never resolves): destroys the window and returns ok:false (R1 #1b)', async () => {
    // A wedged renderer whose capturePage() never settles + ignores the signal. The
    // backend must destroy the window on abort and settle ok:false — never hang.
    fakeWindowControls.neverCapture = true;
    const ac = new AbortController();
    const p = new CapturePageBackend({ capturePageTimeoutMs: 10_000 }).capture(ctx(), ac.signal);
    // Let the page load finish + capturePage() start and hang, then abort.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/aborted/i);
    expect(fakeWindowControls.destroyed).toBe(1); // window torn down on abort (not leaked)
  });

  it('times out a wedged capturePage (never resolves) and returns ok:false + destroys the window (R1 #1b)', async () => {
    fakeWindowControls.neverCapture = true;
    const res = await new CapturePageBackend({ capturePageTimeoutMs: 20 }).capture(
      ctx(),
      new AbortController().signal,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/i);
    expect(fakeWindowControls.destroyed).toBe(1); // wedged window destroyed on timeout
  });

  describe('S9 companion A: capture diagnostics', () => {
    it('collects error-level page console output onto CaptureResult.diagnostics', async () => {
      fakeWindowControls.consoleMessages = [
        { level: 'error', message: 'boom', lineNumber: 3, sourceId: 'app.js' },
      ];
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(res.diagnostics).toContain('app.js:3 boom');
    });

    it('ignores non-error console levels', async () => {
      fakeWindowControls.consoleMessages = [
        { level: 'warning', message: 'meh', lineNumber: 1, sourceId: 'app.js' },
        { level: 'info', message: 'fyi', lineNumber: 2, sourceId: 'app.js' },
        { level: 'debug', message: 'trace', lineNumber: 4, sourceId: 'app.js' },
      ];
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(res.diagnostics).toBeUndefined();
    });

    it('caps collected diagnostics at MAX_DIAGNOSTIC_ENTRIES (10)', async () => {
      fakeWindowControls.consoleMessages = Array.from({ length: 15 }, (_, i) => ({
        level: 'error',
        message: `err${i}`,
        lineNumber: i,
        sourceId: 'app.js',
      }));
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(res.diagnostics).toHaveLength(10);
    });

    it('caps collected diagnostics at MAX_DIAGNOSTIC_CHARS (2000), truncating the overflowing entry and dropping the rest', async () => {
      // Three ~1204-char entries: 1st fits whole (1204), 2nd is clipped to fill
      // the remaining 796-char budget exactly (total 2000), 3rd is dropped.
      fakeWindowControls.consoleMessages = Array.from({ length: 3 }, () => ({
        level: 'error',
        message: 'x'.repeat(1200),
        lineNumber: 1,
        sourceId: 's',
      }));
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(res.diagnostics).toHaveLength(2);
      const totalChars = (res.diagnostics ?? []).reduce((sum, line) => sum + line.length, 0);
      expect(totalChars).toBe(2000);
      expect(res.diagnostics?.[1].length).toBe(796);
    });

    it('pushes the file:// CORS breadcrumb when loaded from htmlPath', async () => {
      const html = join(artifactsDir, 'index.html');
      await writeFile(html, '<!doctype html><h1>hi</h1>');
      const res = await new CapturePageBackend().capture(
        ctx({ url: undefined, htmlPath: html }),
        new AbortController().signal,
      );
      expect(res.ok).toBe(true);
      expect(res.diagnostics?.some((d) => d.includes('loaded over file://'))).toBe(true);
    });

    it('omits diagnostics entirely when loaded from a url (no breadcrumb, no console errors)', async () => {
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(res.diagnostics).toBeUndefined();
    });

    it('attaches diagnostics on an ok:false result too', async () => {
      fakeWindowControls.consoleMessages = [
        { level: 'error', message: 'boom', lineNumber: 1, sourceId: 'app.js' },
      ];
      fakeWindowControls.emptyPng = true;
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(false);
      expect(res.diagnostics).toContain('app.js:1 boom');
    });
  });

  describe('S9 companion B: default-viewport fold clamp', () => {
    it('clampFoldHeight: measured height within bounds passes through unchanged', () => {
      expect(clampFoldHeight(3000, 1280)).toBe(3000);
    });

    it('clampFoldHeight: never shrinks below the default viewport height', () => {
      expect(clampFoldHeight(100, 1280)).toBe(800);
    });

    it('clampFoldHeight: flat MAX_FOLD_HEIGHT ceiling wins on a narrow/default-width viewport', () => {
      expect(clampFoldHeight(20_000, 1280)).toBe(4_000);
    });

    it('clampFoldHeight: the pixel-AREA budget clamps tighter than the flat height ceiling on a wide viewport', () => {
      // floor(12_000_000 / 4000) = 3000, which is < MAX_FOLD_HEIGHT (4000).
      expect(clampFoldHeight(5_000, 4_000)).toBe(3_000);
    });

    it('measures + applies the fold height for the default viewport (no clamp needed)', async () => {
      fakeWindowControls.foldHeight = 3000;
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(fakeWindowControls.setContentSizeCalls).toEqual([[1280, 3000]]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('clamps an oversized measured height to MAX_FOLD_HEIGHT and pushes a truncation diagnostic', async () => {
      fakeWindowControls.foldHeight = 20_000;
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(fakeWindowControls.setContentSizeCalls).toEqual([[1280, 4_000]]);
      expect(res.diagnostics?.some((d) => /exceeds capture clamp/i.test(d))).toBe(true);
    });

    it('does NOT measure fold height when viewports are explicitly declared', async () => {
      const res = await new CapturePageBackend().capture(
        ctx({ viewports: [{ width: 1024, height: 768, label: 'custom' }] }),
        new AbortController().signal,
      );
      expect(res.ok).toBe(true);
      expect(fakeWindowControls.execJsCallCount).toBe(0);
      expect(fakeWindowControls.setContentSizeCalls).toEqual([[1024, 768]]);
    });

    it('does NOT measure fold height for a non-static-render-snapshot type', async () => {
      const res = await new CapturePageBackend().capture(
        { ...ctx(), type: 'responsive-multi-viewport' },
        new AbortController().signal,
      );
      expect(res.ok).toBe(true);
      expect(fakeWindowControls.execJsCallCount).toBe(0);
      expect(fakeWindowControls.setContentSizeCalls).toEqual([[1280, 800]]);
    });

    it('fails soft to the default viewport height when the probe rejects, with a diagnostic', async () => {
      fakeWindowControls.foldHeightReject = true;
      const res = await new CapturePageBackend().capture(ctx(), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(fakeWindowControls.setContentSizeCalls).toEqual([[1280, 800]]);
      expect(res.diagnostics?.some((d) => /measurement failed/i.test(d))).toBe(true);
    });
  });
});
