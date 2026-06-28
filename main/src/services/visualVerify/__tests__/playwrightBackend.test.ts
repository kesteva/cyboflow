/**
 * PlaywrightBackend (Rung 1) unit tests.
 *
 * NO real browser launches: a FAKE BrowserFactory is dependency-injected (and a
 * fake PlaywrightInstaller that reports chromium present without spawning npx). The
 * fake browser/context/page drive the real backend orchestration — the per-viewport
 * newContext loop, interaction playback IN ORDER, the deterministic-first verdict
 * channel (FAIL on nav/interaction errors, PASS on all-pass explicit assertions,
 * undefined otherwise), PNG writes into a temp artifactsDir, and healthCheck soft
 * failure when chromium is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import {
  PlaywrightBackend,
  type BrowserFactory,
} from '../playwrightBackend';
import { PlaywrightInstaller } from '../playwrightInstaller';
import type {
  CaptureContext,
  DeliverableAssertion,
  VerificationRequestInput,
} from '../../../../../shared/types/visualVerification';
import { VERIFY_PORT_ANY } from '../../../../../shared/types/visualVerification';

// The smallest valid PNG (the fake page.screenshot returns it).
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A recorded interaction/assertion call against the fake page. */
interface FakeCalls {
  gotos: string[];
  interactions: Array<{ kind: string; selector?: string; value?: string }>;
  newContexts: Array<{ width: number; height: number }>;
  screenshots: number;
  closed: number;
  browserClosed: number;
}

/** Per-test behaviour knobs for the fake browser. */
interface FakeOpts {
  /** A selector that, when clicked/filled/located, throws "not found". */
  missingTarget?: string;
  /** Emit a pageerror after goto. */
  pageError?: string;
  /** goto returns a non-ok HTTP response. */
  navStatus?: number;
  /** Map of selector -> isVisible result for assertions/locators. */
  visibility?: Record<string, boolean>;
  /** Map of selector -> textContent for text assertions. */
  text?: Record<string, string>;
}

function makeFakeFactory(opts: FakeOpts, calls: FakeCalls): BrowserFactory {
  const makeLocator = (selector: string) => ({
    async click(): Promise<void> {
      calls.interactions.push({ kind: 'click', selector });
      if (opts.missingTarget && selector === opts.missingTarget) {
        throw new Error(`locator.click: Timeout exceeded — "${selector}" not found`);
      }
    },
    async fill(value: string): Promise<void> {
      calls.interactions.push({ kind: 'type', selector, value });
      if (opts.missingTarget && selector === opts.missingTarget) {
        throw new Error(`locator.fill: "${selector}" not found`);
      }
    },
    async waitFor(): Promise<void> {
      calls.interactions.push({ kind: 'wait', selector });
      if (opts.missingTarget && selector === opts.missingTarget) {
        throw new Error(`locator.waitFor: "${selector}" not found`);
      }
    },
    first() {
      return makeLocator(selector);
    },
    async isVisible(): Promise<boolean> {
      return opts.visibility?.[selector] ?? true;
    },
    async count(): Promise<number> {
      return opts.visibility && selector in opts.visibility ? 1 : 0;
    },
    async textContent(): Promise<string | null> {
      return opts.text?.[selector] ?? null;
    },
  });

  const makePage = () => {
    let errHandler: ((e: Error) => void) | null = null;
    return {
      setDefaultTimeout(): void {},
      setDefaultNavigationTimeout(): void {},
      on(event: string, handler: (e: Error) => void): void {
        if (event === 'pageerror') errHandler = handler;
      },
      async goto(url: string): Promise<{ ok: () => boolean; status: () => number } | null> {
        calls.gotos.push(url);
        if (opts.pageError && errHandler) errHandler(new Error(opts.pageError));
        if (opts.navStatus && opts.navStatus >= 400) {
          return { ok: () => false, status: () => opts.navStatus as number };
        }
        return { ok: () => true, status: () => 200 };
      },
      locator(selector: string) {
        return makeLocator(selector);
      },
      async waitForTimeout(): Promise<void> {
        calls.interactions.push({ kind: 'wait' });
      },
      async screenshot(): Promise<Buffer> {
        calls.screenshots += 1;
        return ONE_PX_PNG;
      },
    };
  };

  const fakeBrowser = {
    async newContext(o: { viewport: { width: number; height: number } }) {
      calls.newContexts.push({ width: o.viewport.width, height: o.viewport.height });
      return {
        async newPage() {
          return makePage();
        },
        async close(): Promise<void> {
          calls.closed += 1;
        },
      };
    },
    async close(): Promise<void> {
      calls.browserClosed += 1;
    },
  };

  // The fake satisfies only the narrow slice of Browser the backend uses; the cast
  // is confined to this test seam (the production factory returns a real Browser).
  return async () => fakeBrowser as unknown as Browser;
}

/** An installer that reports chromium present without spawning npx. */
function installedInstaller(): PlaywrightInstaller {
  return new PlaywrightInstaller({
    executablePath: () => '/fake/chromium',
    pathExists: () => true,
    runInstall: async () => true,
  });
}

/** An installer whose chromium is absent and whose install fails. */
function absentInstaller(): PlaywrightInstaller {
  return new PlaywrightInstaller({
    executablePath: () => null,
    pathExists: () => false,
    runInstall: async () => false,
  });
}

let artifactsDir: string;

beforeEach(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-pw-'));
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

function freshCalls(): FakeCalls {
  return {
    gotos: [],
    interactions: [],
    newContexts: [],
    screenshots: 0,
    closed: 0,
    browserClosed: 0,
  };
}

function ctx(over: Partial<VerificationRequestInput> = {}): CaptureContext {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    artifactsDir,
    type: 'interactive-web-behavior',
    input: { intent: 'looks right', url: 'http://localhost:5173', ...over },
  };
}

describe('PlaywrightBackend', () => {
  it('has the rung-1 contract', () => {
    const b = new PlaywrightBackend({ installer: installedInstaller() });
    expect(b.id).toBe('playwright');
    expect(b.rung).toBe(1);
  });

  it('requiredLease returns the VERIFY_PORT_ANY sentinel ONLY when the deliverable declares a start', () => {
    const b = new PlaywrightBackend({ installer: installedInstaller() });
    // No start -> static url -> no lease.
    expect(b.requiredLease({ intent: 'x', url: 'http://x' })).toBeNull();
    // start present -> needs SOME pooled port lease (the sentinel, NOT a phantom
    // 'verify:port:0' the scheduler would append as an extra always-free slot).
    const lease = b.requiredLease({ intent: 'x', url: 'http://x', start: 'npm run dev' });
    expect(lease).toBe(VERIFY_PORT_ANY);
    expect(lease).not.toBe('verify:port:0');
    // blank start -> no lease.
    expect(b.requiredLease({ intent: 'x', url: 'http://x', start: '   ' })).toBeNull();
  });

  it('multi-viewport produces N PNGs (one per viewport, sanitized unique stems)', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({}, calls),
    });
    const res = await b.capture(
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
    expect(calls.newContexts).toEqual([
      { width: 375, height: 812 },
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
    ]);
    const onDisk = (await readdir(artifactsDir)).sort();
    expect(onDisk).toEqual(['2.png', 'desktop-wide.png', 'mobile.png']);
    // No assertions declared -> deterministicVerdict undefined (VLM will run).
    expect(res.deterministicVerdict).toBeUndefined();
  });

  it('plays interactions IN ORDER before the screenshot', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({}, calls),
    });
    const res = await b.capture(
      ctx({
        interactions: [
          { action: 'click', target: '#a' },
          { action: 'type', target: '#b', value: 'hello' },
          { action: 'wait', target: '#c' },
        ],
      }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(true);
    expect(calls.interactions).toEqual([
      { kind: 'click', selector: '#a' },
      { kind: 'type', selector: '#b', value: 'hello' },
      { kind: 'wait', selector: '#c' },
    ]);
    // Interactions all happened BEFORE the (single) screenshot.
    expect(calls.screenshots).toBe(1);
  });

  it('sets a FAIL deterministicVerdict when an interaction target is missing', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({ missingTarget: '#gone' }, calls),
    });
    const res = await b.capture(
      ctx({ interactions: [{ action: 'click', target: '#gone' }] }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(true); // a judged outcome, not a fall-forward failure
    expect(res.deterministicVerdict?.status).toBe('fail');
    expect(res.deterministicVerdict?.feedback).toMatch(/click.*#gone.*failed/i);
    // No screenshot was taken for that viewport (we bailed before it).
    expect(calls.screenshots).toBe(0);
  });

  it('sets a FAIL deterministicVerdict on a navigation error (non-ok HTTP)', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({ navStatus: 500 }, calls),
    });
    const res = await b.capture(ctx(), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.deterministicVerdict?.status).toBe('fail');
    expect(res.deterministicVerdict?.feedback).toMatch(/HTTP 500/);
  });

  it('sets a FAIL deterministicVerdict on an uncaught page error', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({ pageError: 'boom in app' }, calls),
    });
    const res = await b.capture(ctx(), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.deterministicVerdict?.status).toBe('fail');
    expect(res.deterministicVerdict?.feedback).toMatch(/uncaught page error.*boom in app/i);
  });

  it('sets a PASS deterministicVerdict when ALL explicit assertions pass', async () => {
    const calls = freshCalls();
    const assertions: DeliverableAssertion[] = [
      { kind: 'visible', selector: '#ok' },
      { kind: 'hidden', selector: '#spinner' },
      { kind: 'text', selector: '#title', text: 'Welcome' },
    ];
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory(
        {
          visibility: { '#ok': true /* #spinner absent => hidden */ },
          text: { '#title': 'Welcome back' },
        },
        calls,
      ),
    });
    const res = await b.capture(ctx({ assertions }), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.deterministicVerdict?.status).toBe('pass');
    expect(res.deterministicVerdict?.model).toBe('playwright-deterministic');
  });

  it('sets a FAIL deterministicVerdict when an explicit assertion fails', async () => {
    const calls = freshCalls();
    const assertions: DeliverableAssertion[] = [{ kind: 'visible', selector: '#missing' }];
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({ visibility: { '#missing': false } }, calls),
    });
    const res = await b.capture(ctx({ assertions }), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.deterministicVerdict?.status).toBe('fail');
    expect(res.deterministicVerdict?.feedback).toMatch(/#missing.*not visible/i);
  });

  it('sets a FAIL deterministicVerdict when a hidden assertion targets a PRESENT visible element', async () => {
    // The other hidden test covers the absent-element path (count===0 ⇒ pass). This
    // exercises the present-but-visible FAIL branch: count>0 AND isVisible→true.
    const calls = freshCalls();
    const assertions: DeliverableAssertion[] = [{ kind: 'hidden', selector: '#shown' }];
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({ visibility: { '#shown': true } }, calls),
    });
    const res = await b.capture(ctx({ assertions }), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.deterministicVerdict?.status).toBe('fail');
    expect(res.deterministicVerdict?.feedback).toMatch(/visible \(expected hidden\)/);
  });

  it('leaves deterministicVerdict undefined on structural success WITHOUT assertions (VLM runs)', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({}, calls),
    });
    const res = await b.capture(ctx(), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(res.fileNames.length).toBe(1);
    expect(res.deterministicVerdict).toBeUndefined();
  });

  it('healthCheck is false when chromium is absent (no throw, no hang)', async () => {
    const b = new PlaywrightBackend({ installer: absentInstaller() });
    await expect(b.healthCheck()).resolves.toBe(false);
  });

  it('capture soft-fails (ok:false) when chromium is unavailable', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: absentInstaller(),
      browserFactory: makeFakeFactory({}, calls),
    });
    const res = await b.capture(ctx(), new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/chromium unavailable/i);
    // never launched a browser.
    expect(calls.browserClosed).toBe(0);
  });

  it('returns ok:false when no url is provided', async () => {
    const calls = freshCalls();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({}, calls),
    });
    const res = await b.capture(ctx({ url: undefined }), new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no url/i);
  });

  it('aborts before launching when the signal is already aborted', async () => {
    const calls = freshCalls();
    const ac = new AbortController();
    ac.abort();
    const b = new PlaywrightBackend({
      installer: installedInstaller(),
      browserFactory: makeFakeFactory({}, calls),
    });
    const res = await b.capture(ctx(), ac.signal);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/aborted/i);
  });
});

/**
 * BLOCKER regression: `playwright` is a ROOT devDependency that electron-builder
 * prunes when packaging, so the production .app may NOT have it. Both service files
 * therefore load it LAZILY (`await import('playwright')`); an absent MODULE must
 * soft-fail (healthCheck/ensureChromium → false, default browserFactory → caught)
 * exactly like a missing chromium BINARY — never an eager top-level require that
 * MODULE_NOT_FOUND-crashes the boot path. We simulate the pruned package by mocking
 * the dynamic import to throw, then drive the REAL default code paths (no DI fakes).
 */
describe('PlaywrightBackend — missing `playwright` module soft-fails (packaging BLOCKER)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('playwright');
  });

  it('healthCheck()/ensureChromium() resolve false (no throw) when the module is absent', async () => {
    vi.resetModules();
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright'");
    });
    const { PlaywrightInstaller: Installer } = await import('../playwrightInstaller');
    const { PlaywrightBackend: Backend } = await import('../playwrightBackend');

    // DEFAULT installer (its default executablePath lazy-imports the absent module).
    const installer = new Installer();
    await expect(installer.ensureChromium()).resolves.toBe(false);

    // DEFAULT backend wired with that installer: healthCheck is false, never throws.
    const backend = new Backend({ installer });
    await expect(backend.healthCheck()).resolves.toBe(false);
  });

  it('capture() with the DEFAULT browserFactory soft-fails (ok:false) when the module is absent', async () => {
    vi.resetModules();
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright'");
    });
    const { PlaywrightInstaller: Installer } = await import('../playwrightInstaller');
    const { PlaywrightBackend: Backend } = await import('../playwrightBackend');

    // An installer that REPORTS chromium present (so we reach the default factory),
    // but the default browserFactory still lazy-imports the absent module → throws →
    // caught by capture()'s try/catch → ok:false (no crash, no hang).
    const installer = new Installer({
      executablePath: () => '/fake/chromium',
      pathExists: () => true,
      runInstall: async () => true,
    });
    const backend = new Backend({ installer }); // DEFAULT browserFactory (no DI)
    const dir = await mkdtemp(join(tmpdir(), 'cvv-pw-nomod-'));
    try {
      const res = await backend.capture(
        {
          requestId: 'r',
          runId: 'run',
          artifactsDir: dir,
          type: 'interactive-web-behavior',
          input: { intent: 'x', url: 'http://localhost:5173' },
        },
        new AbortController().signal,
      );
      expect(res.ok).toBe(false);
      expect(res.fileNames).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
