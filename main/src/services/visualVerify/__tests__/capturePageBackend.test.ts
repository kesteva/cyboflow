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
import { CapturePageBackend } from '../capturePageBackend';

let artifactsDir: string;

beforeEach(async () => {
  fakeWindowControls.failLoad = false;
  fakeWindowControls.emptyPng = false;
  fakeWindowControls.neverFinish = false;
  fakeWindowControls.neverCapture = false;
  fakeWindowControls.setContentSizeCalls = [];
  fakeWindowControls.destroyed = 0;
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
});
