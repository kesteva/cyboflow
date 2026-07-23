/**
 * driverCore unit tests — NO real browser is ever launched. `connectOverCDP` /
 * `spawnDetachedChromium` / `waitForCdpReady` / `closeBrowser` are all
 * dependency-injected fakes; the fake browser/context/page objects drive the
 * real command dispatch (connect-first-then-launch fallback, one-page reuse
 * across separate invocations, arg parsing, screenshot name sanitization,
 * pid-file plumbing, and stop's CDP-then-SIGKILL fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import {
  createDefaultDriverDeps,
  parseArgv,
  pidFilePath,
  runDriverCommand,
  sanitizeScreenshotName,
  USAGE,
  type DriverDeps,
} from '../driverCore';

// ---------------------------------------------------------------------------
// Fake browser/context/page — the "playwright-like object" injected in place
// of a real browser. The cast to `Browser` is confined to this test seam
// (mirrors playwrightBackend.test.ts's fakeBrowser).
// ---------------------------------------------------------------------------

interface FakeCalls {
  newContexts: number;
  newPages: number;
  gotos: string[];
  clicks: string[];
  fills: Array<{ selector: string; text: string }>;
  viewports: Array<{ width: number; height: number }>;
  screenshots: string[];
  browserClosed: number;
}

function freshCalls(): FakeCalls {
  return {
    newContexts: 0,
    newPages: 0,
    gotos: [],
    clicks: [],
    fills: [],
    viewports: [],
    screenshots: [],
    browserClosed: 0,
  };
}

function makeFakePage(calls: FakeCalls) {
  return {
    async goto(url: string): Promise<{ ok: () => boolean; status: () => number } | null> {
      calls.gotos.push(url);
      return { ok: () => true, status: () => 200 };
    },
    locator(selector: string) {
      return {
        async click(): Promise<void> {
          calls.clicks.push(selector);
        },
        async fill(text: string): Promise<void> {
          calls.fills.push({ selector, text });
        },
      };
    },
    async setViewportSize(size: { width: number; height: number }): Promise<void> {
      calls.viewports.push(size);
    },
    async screenshot(opts: { path: string }): Promise<Buffer> {
      calls.screenshots.push(opts.path);
      return Buffer.from('');
    },
  };
}

/** A browser whose contexts/pages persist for the LIFETIME of this object — the
 * fixture that lets a test assert "one living page" is reused across two
 * SEPARATE runDriverCommand() calls that share a CDP connection. */
function makeFakeBrowser(calls: FakeCalls) {
  const contexts: Array<{ pages: () => unknown[]; newPage: () => Promise<unknown> }> = [];
  return {
    contexts: () => contexts,
    async newContext() {
      calls.newContexts += 1;
      const pages: unknown[] = [];
      const context = {
        pages: () => pages,
        async newPage() {
          calls.newPages += 1;
          const page = makeFakePage(calls);
          pages.push(page);
          return page;
        },
      };
      contexts.push(context);
      return context;
    },
    async close(): Promise<void> {
      calls.browserClosed += 1;
    },
  };
}

function makeDeps(calls: FakeCalls, overrides: Partial<DriverDeps> = {}): DriverDeps {
  const browser = makeFakeBrowser(calls);
  return {
    connectOverCDP: vi.fn(async () => browser as unknown as Browser),
    resolveChromiumExecutable: vi.fn(async () => '/fake/chromium'),
    spawnDetachedChromium: vi.fn(async () => ({ pid: 4242 })),
    waitForCdpReady: vi.fn(async () => {}),
    closeBrowser: vi.fn(async () => {}),
    readPidFile: vi.fn(async () => null),
    writePidFile: vi.fn(async () => {}),
    removePidFile: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    isProcessAlive: vi.fn(() => true),
    killPid: vi.fn(() => {}),
    stdout: () => {},
    stderr: () => {},
    ...overrides,
  };
}

const ENV = { VERIFY_DRIVER_PORT: '9333', VERIFY_ARTIFACTS_DIR: '/tmp/verify-artifacts' };

// ---------------------------------------------------------------------------
// parseArgv — all five commands + bad args
// ---------------------------------------------------------------------------

describe('parseArgv', () => {
  it('parses goto', () => {
    expect(parseArgv(['goto', 'https://example.com'])).toEqual({
      ok: true,
      command: { kind: 'goto', url: 'https://example.com' },
    });
  });

  it('rejects goto with no url', () => {
    expect(parseArgv(['goto'])).toMatchObject({ ok: false });
  });

  it('rejects goto with extra args', () => {
    expect(parseArgv(['goto', 'https://example.com', 'extra'])).toMatchObject({ ok: false });
  });

  it('parses click', () => {
    expect(parseArgv(['click', '#submit'])).toEqual({
      ok: true,
      command: { kind: 'click', selector: '#submit' },
    });
  });

  it('rejects click with no selector', () => {
    expect(parseArgv(['click'])).toMatchObject({ ok: false });
  });

  it('parses type, joining trailing words into the text', () => {
    expect(parseArgv(['type', '#input', 'hello', 'world'])).toEqual({
      ok: true,
      command: { kind: 'type', selector: '#input', text: 'hello world' },
    });
  });

  it('rejects type with only a selector', () => {
    expect(parseArgv(['type', '#input'])).toMatchObject({ ok: false });
  });

  it('parses screenshot with a viewport flag', () => {
    expect(parseArgv(['screenshot', 'home', '--viewport', '1280x800'])).toEqual({
      ok: true,
      command: { kind: 'screenshot', name: 'home.png', viewport: { width: 1280, height: 800 } },
    });
  });

  it('parses screenshot without a viewport flag', () => {
    expect(parseArgv(['screenshot', 'home'])).toEqual({
      ok: true,
      command: { kind: 'screenshot', name: 'home.png', viewport: undefined },
    });
  });

  it('rejects a malformed viewport', () => {
    expect(parseArgv(['screenshot', 'home', '--viewport', 'big'])).toMatchObject({ ok: false });
  });

  it('rejects an unknown flag', () => {
    expect(parseArgv(['screenshot', 'home', '--bogus'])).toMatchObject({ ok: false });
  });

  it('sanitizes path traversal in the screenshot name', () => {
    expect(parseArgv(['screenshot', '../evil'])).toEqual({
      ok: true,
      command: { kind: 'screenshot', name: 'evil.png', viewport: undefined },
    });
  });

  it('parses stop', () => {
    expect(parseArgv(['stop'])).toEqual({ ok: true, command: { kind: 'stop' } });
  });

  it('rejects stop with extra args', () => {
    expect(parseArgv(['stop', 'now'])).toMatchObject({ ok: false });
  });

  it('rejects an unknown command', () => {
    expect(parseArgv(['frobnicate'])).toMatchObject({ ok: false });
  });

  it('rejects empty argv', () => {
    expect(parseArgv([])).toMatchObject({ ok: false });
  });
});

describe('sanitizeScreenshotName', () => {
  it('strips a directory component and appends .png', () => {
    expect(sanitizeScreenshotName('../evil')).toBe('evil.png');
  });

  it('strips a nested traversal path', () => {
    expect(sanitizeScreenshotName('../../etc/passwd')).toBe('passwd.png');
  });

  it('keeps an existing .png extension as-is', () => {
    expect(sanitizeScreenshotName('home.png')).toBe('home.png');
  });

  it('rejects a name that sanitizes to nothing usable', () => {
    expect(sanitizeScreenshotName('..')).toBeNull();
    expect(sanitizeScreenshotName('/')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runDriverCommand — usage + missing env
// ---------------------------------------------------------------------------

describe('runDriverCommand — bad args and missing env', () => {
  it('prints USAGE and exits non-zero on bad args', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, { stderr: (l) => stderrLines.push(l) });
    const exitCode = await runDriverCommand(['goto'], ENV, deps);
    expect(exitCode).toBe(1);
    expect(stderrLines.join('\n')).toContain(USAGE);
  });

  it('exits non-zero with a clear error when VERIFY_DRIVER_PORT is missing', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, { stderr: (l) => stderrLines.push(l) });
    const exitCode = await runDriverCommand(
      ['goto', 'https://example.com'],
      { VERIFY_ARTIFACTS_DIR: '/tmp/x' },
      deps,
    );
    expect(exitCode).toBe(1);
    expect(stderrLines.join('\n')).toMatch(/VERIFY_DRIVER_PORT/);
  });

  it('exits non-zero with a clear error when VERIFY_ARTIFACTS_DIR is missing', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, { stderr: (l) => stderrLines.push(l) });
    const exitCode = await runDriverCommand(['screenshot', 'home'], { VERIFY_DRIVER_PORT: '9333' }, deps);
    expect(exitCode).toBe(1);
    expect(stderrLines.join('\n')).toMatch(/VERIFY_ARTIFACTS_DIR/);
  });

  it('exits non-zero when VERIFY_DRIVER_PORT is not numeric', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(
      ['click', '#x'],
      { VERIFY_DRIVER_PORT: 'not-a-port', VERIFY_ARTIFACTS_DIR: '/tmp/x' },
      deps,
    );
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// connect-first-then-launch fallback order
// ---------------------------------------------------------------------------

describe('runDriverCommand — connect-first-then-launch', () => {
  it('reuses an already-listening CDP endpoint without launching', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['goto', 'https://example.com'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(deps.spawnDetachedChromium).not.toHaveBeenCalled();
    expect(calls.gotos).toEqual(['https://example.com']);
  });

  it('launches chromium only after the first connectOverCDP fails, then reconnects', async () => {
    const calls = freshCalls();
    const browser = makeFakeBrowser(calls);
    const deps = makeDeps(calls);
    let attempts = 0;
    deps.connectOverCDP = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNREFUSED');
      return browser as unknown as Browser;
    });

    const exitCode = await runDriverCommand(['goto', 'https://example.com'], ENV, deps);

    expect(exitCode).toBe(0);
    expect(deps.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(deps.spawnDetachedChromium).toHaveBeenCalledTimes(1);
    expect(deps.waitForCdpReady).toHaveBeenCalledTimes(1);
    expect(deps.writePidFile).toHaveBeenCalledTimes(1);
    expect(deps.writePidFile).toHaveBeenCalledWith(pidFilePath(ENV.VERIFY_ARTIFACTS_DIR), 4242);
    // spawn happened strictly after the failed connect, and wait/reconnect happened after spawn.
    const spawnOrder = (deps.spawnDetachedChromium as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const waitOrder = (deps.waitForCdpReady as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const connectOrders = (deps.connectOverCDP as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(connectOrders[0]).toBeLessThan(spawnOrder);
    expect(spawnOrder).toBeLessThan(waitOrder);
    expect(waitOrder).toBeLessThan(connectOrders[1]);
  });

  it('fails clearly when chromium cannot be resolved for launch', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      connectOverCDP: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      resolveChromiumExecutable: vi.fn(async () => null),
    });
    const stderrLines: string[] = [];
    deps.stderr = (l) => stderrLines.push(l);

    const exitCode = await runDriverCommand(['goto', 'https://example.com'], ENV, deps);

    expect(exitCode).toBe(1);
    expect(deps.spawnDetachedChromium).not.toHaveBeenCalled();
    expect(stderrLines.join('\n')).toMatch(/chromium executable not found/);
  });

  it('reuses the same page across two SEPARATE invocations sharing a CDP connection', async () => {
    const calls = freshCalls();
    const browser = makeFakeBrowser(calls);
    const deps = makeDeps(calls, { connectOverCDP: vi.fn(async () => browser as unknown as Browser) });

    await runDriverCommand(['goto', 'https://example.com'], ENV, deps);
    await runDriverCommand(['click', '#button'], ENV, deps);

    expect(calls.newContexts).toBe(1);
    expect(calls.newPages).toBe(1);
    expect(calls.gotos).toEqual(['https://example.com']);
    expect(calls.clicks).toEqual(['#button']);
  });
});

// ---------------------------------------------------------------------------
// command execution (goto / click / type / screenshot)
// ---------------------------------------------------------------------------

describe('runDriverCommand — command execution', () => {
  it('runs click', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['click', '#submit'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(calls.clicks).toEqual(['#submit']);
  });

  it('runs type', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['type', '#input', 'hello', 'world'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(calls.fills).toEqual([{ selector: '#input', text: 'hello world' }]);
  });

  it('runs screenshot, resizing for an explicit viewport and writing under VERIFY_ARTIFACTS_DIR', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(
      ['screenshot', 'home', '--viewport', '1280x800'],
      ENV,
      deps,
    );
    expect(exitCode).toBe(0);
    expect(calls.viewports).toEqual([{ width: 1280, height: 800 }]);
    expect(calls.screenshots).toEqual([join(ENV.VERIFY_ARTIFACTS_DIR, 'home.png')]);
    expect(deps.ensureDir).toHaveBeenCalledWith(ENV.VERIFY_ARTIFACTS_DIR);
  });

  it('runs screenshot without a viewport flag (no resize)', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['screenshot', 'home'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(calls.viewports).toEqual([]);
    expect(calls.screenshots).toEqual([join(ENV.VERIFY_ARTIFACTS_DIR, 'home.png')]);
  });
});

// ---------------------------------------------------------------------------
// stop — CDP-then-SIGKILL fallback, always exits 0
// ---------------------------------------------------------------------------

describe('runDriverCommand — stop', () => {
  it('closes via CDP when reachable and skips the kill only when no pid is recorded', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['stop'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.closeBrowser).toHaveBeenCalledTimes(1);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removePidFile).toHaveBeenCalledTimes(1);
  });

  it('SIGKILLs the recorded pid even when the CDP close succeeds (disconnect-only close leak)', async () => {
    // Regression (live smoke 2026-07-22): playwright's close() on a
    // connectOverCDP browser only disconnects, so a "successful" CDP close used
    // to skip the pid kill and leak the spawned chromium + its bound port.
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      readPidFile: vi.fn(async () => 4242),
      isProcessAlive: vi.fn(() => true),
    });
    const exitCode = await runDriverCommand(['stop'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.closeBrowser).toHaveBeenCalledTimes(1);
    expect(deps.killPid).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(deps.removePidFile).toHaveBeenCalledTimes(1);
  });

  it('SIGKILLs the recorded pid when CDP is unreachable', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      connectOverCDP: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      readPidFile: vi.fn(async () => 4242),
      isProcessAlive: vi.fn(() => true),
    });
    const exitCode = await runDriverCommand(['stop'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.closeBrowser).not.toHaveBeenCalled();
    expect(deps.killPid).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(deps.removePidFile).toHaveBeenCalledTimes(1);
  });

  it('does not kill when the recorded pid is already gone', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      connectOverCDP: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      readPidFile: vi.fn(async () => 4242),
      isProcessAlive: vi.fn(() => false),
    });
    const exitCode = await runDriverCommand(['stop'], ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.killPid).not.toHaveBeenCalled();
  });

  it('always exits 0 even when env is entirely missing', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['stop'], {}, deps);
    expect(exitCode).toBe(0);
    expect(deps.connectOverCDP).not.toHaveBeenCalled();
    expect(deps.readPidFile).not.toHaveBeenCalled();
  });

  it('rejects stop with unexpected arguments before touching any deps', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['stop', 'extra'], ENV, deps);
    expect(exitCode).toBe(1);
    expect(deps.connectOverCDP).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pid-file write/read — real fs via createDefaultDriverDeps, still NO browser
// ---------------------------------------------------------------------------

describe('createDefaultDriverDeps — pid file + process helpers (no browser touched)', () => {
  let artifactsDir: string;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-driver-'));
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('pidFilePath is scoped under .driver/browser.pid', () => {
    expect(pidFilePath(artifactsDir)).toBe(join(artifactsDir, '.driver', 'browser.pid'));
  });

  it('round-trips a pid through write -> read -> remove -> read', async () => {
    const deps = createDefaultDriverDeps();
    const path = pidFilePath(artifactsDir);

    expect(await deps.readPidFile(path)).toBeNull();

    await deps.writePidFile(path, 4242);
    expect(await deps.readPidFile(path)).toBe(4242);

    await deps.removePidFile(path);
    expect(await deps.readPidFile(path)).toBeNull();
  });

  it('removePidFile is a no-op when the file never existed', async () => {
    const deps = createDefaultDriverDeps();
    await expect(deps.removePidFile(pidFilePath(artifactsDir))).resolves.toBeUndefined();
  });

  it('readPidFile returns null for garbage content', async () => {
    const deps = createDefaultDriverDeps();
    const path = pidFilePath(artifactsDir);
    await deps.writePidFile(path, 4242);
    // Overwrite with non-numeric content via the same real-fs path.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not-a-pid', 'utf8');
    expect(await deps.readPidFile(path)).toBeNull();
  });

  it('isProcessAlive/killPid operate on real pids without spawning a browser', () => {
    const deps = createDefaultDriverDeps();
    expect(deps.isProcessAlive(process.pid)).toBe(true);
    expect(deps.isProcessAlive(999_999_999)).toBe(false);
    expect(() => deps.killPid(999_999_999, 'SIGKILL')).not.toThrow();
  });
});
