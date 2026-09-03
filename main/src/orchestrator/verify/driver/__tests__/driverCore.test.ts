/**
 * driverCore unit tests — NO real browser is ever launched. `connectOverCDP` /
 * `spawnDetachedChromium` / `waitForCdpReady` / `closeBrowser` are all
 * dependency-injected fakes; the fake browser/context/page objects drive the
 * real command dispatch (connect-first-then-launch fallback, one-page reuse
 * across separate invocations, arg parsing, screenshot name sanitization,
 * pid-file plumbing, and stop's CDP-then-SIGKILL fallback).
 *
 * The attestation (§7.1) and native-screen (§4 fn.²) suites extend the same
 * seam: `httpGet` / `runPeekaboo` / `writeAttestFile` are fakes too, so no
 * socket is dialled and no peekaboo binary is spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import {
  attestFilePath,
  createDefaultDriverDeps,
  extractWindowTitles,
  NATIVE_SCREEN_DRIVE_REFUSAL,
  parseArgv,
  pidFilePath,
  runDriverCommand,
  sanitizeScreenshotName,
  serveLogPath,
  servePidFilePath,
  USAGE,
  type DriverAttestRecord,
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
  httpGets: string[];
  peekaboo: Array<{ bin: string; args: string[] }>;
  attestWrites: Array<{ path: string; record: DriverAttestRecord }>;
  textContents: string[];
  attributes: Array<{ selector: string; name: string }>;
  evaluates: string[];
  shells: Array<{ command: string; logPath: string }>;
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
    httpGets: [],
    peekaboo: [],
    attestWrites: [],
    textContents: [],
    attributes: [],
    evaluates: [],
    shells: [],
  };
}

/** What the fake page reports back for the DOM/CDP attestation channels. */
interface FakePageData {
  text?: string | null;
  attr?: string | null;
  evaluateResult?: unknown;
}

function makeFakePage(calls: FakeCalls, data: FakePageData = {}) {
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
        async textContent(): Promise<string | null> {
          calls.textContents.push(selector);
          return data.text ?? null;
        },
        async getAttribute(name: string): Promise<string | null> {
          calls.attributes.push({ selector, name });
          return data.attr ?? null;
        },
      };
    },
    async evaluate(expression: string): Promise<unknown> {
      calls.evaluates.push(expression);
      return data.evaluateResult;
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
function makeFakeBrowser(calls: FakeCalls, data: FakePageData = {}) {
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
          const page = makeFakePage(calls, data);
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

function makeDeps(
  calls: FakeCalls,
  overrides: Partial<DriverDeps> = {},
  data: FakePageData = {},
): DriverDeps {
  const browser = makeFakeBrowser(calls, data);
  return {
    connectOverCDP: vi.fn(async () => browser as unknown as Browser),
    resolveChromiumExecutable: vi.fn(async () => '/fake/chromium'),
    spawnDetachedChromium: vi.fn(async () => ({ pid: 4242 })),
    spawnDetachedShell: vi.fn(async (args: { command: string; logPath: string }) => {
      calls.shells.push(args);
      return { pid: 5150 };
    }),
    waitForCdpReady: vi.fn(async () => {}),
    closeBrowser: vi.fn(async () => {}),
    readPidFile: vi.fn(async () => null),
    writePidFile: vi.fn(async () => {}),
    removePidFile: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    isProcessAlive: vi.fn(() => true),
    killPid: vi.fn(() => {}),
    httpGet: vi.fn(async (url: string) => {
      calls.httpGets.push(url);
      return { status: 200, body: '' };
    }),
    runPeekaboo: vi.fn(async (bin: string, args: string[]) => {
      calls.peekaboo.push({ bin, args });
      return '[]';
    }),
    writeAttestFile: vi.fn(async (path: string, record: DriverAttestRecord) => {
      calls.attestWrites.push({ path, record });
    }),
    platform: 'darwin',
    stdout: () => {},
    stderr: () => {},
    ...overrides,
  };
}

const ENV = { VERIFY_DRIVER_PORT: '9333', VERIFY_ARTIFACTS_DIR: '/tmp/verify-artifacts' };

/** The per-request identity secret the runner exports; every attest channel checks for it. */
const NONCE = 'nonce-abc-123';
const ATTEST_ENV = { ...ENV, VERIFY_PORT: '29260', VERIFY_ATTEST_NONCE: NONCE };
const NATIVE_ENV = { ...ENV, VERIFY_MODALITY: 'native-screen' };

/** The single attest record written by the run under test (exactly one is expected). */
function soleAttestRecord(calls: FakeCalls): DriverAttestRecord {
  expect(calls.attestWrites).toHaveLength(1);
  return calls.attestWrites[0].record;
}

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

  it('parses serve, joining trailing words into ONE shell command line', () => {
    // Both callable forms must mean the same thing: the quoted single-argument
    // form the harness contract prescribes, and the bare form a shell would
    // split. Anything else would make `serve pnpm dev --port 1` run `pnpm`.
    expect(parseArgv(['serve', 'pnpm dev --port 29260'])).toEqual({
      ok: true,
      command: { kind: 'serve', command: 'pnpm dev --port 29260' },
    });
    expect(parseArgv(['serve', 'pnpm', 'dev', '--port', '29260'])).toEqual({
      ok: true,
      command: { kind: 'serve', command: 'pnpm dev --port 29260' },
    });
  });

  it('rejects serve with no command (or only whitespace)', () => {
    expect(parseArgv(['serve'])).toMatchObject({ ok: false });
    expect(parseArgv(['serve', '   '])).toMatchObject({ ok: false });
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
// attach-only mode (VERIFY_DRIVER_ATTACH_ONLY=1) — connect-ONLY, never launch
// ---------------------------------------------------------------------------

const ATTACH_ENV = { ...ENV, VERIFY_DRIVER_ATTACH_ONLY: '1' };

describe('runDriverCommand — attach-only mode', () => {
  it('attaches to a listening CDP endpoint and never launches chromium', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['goto', 'https://example.com'], ATTACH_ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(deps.resolveChromiumExecutable).not.toHaveBeenCalled();
    expect(deps.spawnDetachedChromium).not.toHaveBeenCalled();
    expect(calls.gotos).toEqual(['https://example.com']);
  });

  it('fails with an attach-mode error (naming the port) when the endpoint is unreachable, never launching', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, {
      connectOverCDP: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      stderr: (l) => stderrLines.push(l),
    });
    const exitCode = await runDriverCommand(['goto', 'https://example.com'], ATTACH_ENV, deps);
    expect(exitCode).toBe(1);
    expect(deps.resolveChromiumExecutable).not.toHaveBeenCalled();
    expect(deps.spawnDetachedChromium).not.toHaveBeenCalled();
    expect(deps.writePidFile).not.toHaveBeenCalled();
    const err = stderrLines.join('\n');
    expect(err).toMatch(/attach mode/);
    expect(err).toContain('9333');
  });

  it('prefers the first NON-devtools page when attaching to an Electron target', async () => {
    const gotos: string[] = [];
    const makePage = (url: string) => ({
      url: () => url,
      async goto(u: string): Promise<{ ok: () => boolean; status: () => number }> {
        gotos.push(`${url} => ${u}`);
        return { ok: () => true, status: () => 200 };
      },
      locator: () => ({ async click(): Promise<void> {}, async fill(): Promise<void> {} }),
      async setViewportSize(): Promise<void> {},
      async screenshot(): Promise<Buffer> {
        return Buffer.from('');
      },
    });
    const devtools = makePage('devtools://devtools/bundled/inspector.html');
    const app = makePage('http://localhost:3000/');
    const context = {
      pages: () => [devtools, app],
      async newPage(): Promise<never> {
        throw new Error('attach mode must reuse an existing page, not create one');
      },
    };
    const browser = {
      contexts: () => [context],
      async newContext(): Promise<never> {
        throw new Error('attach mode must reuse the existing context');
      },
      async close(): Promise<void> {},
    };
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      connectOverCDP: vi.fn(async () => browser as unknown as Browser),
    });
    const exitCode = await runDriverCommand(['goto', 'https://example.com'], ATTACH_ENV, deps);
    expect(exitCode).toBe(0);
    // Only the app page's goto ran — the devtools:// page was filtered out.
    expect(gotos).toEqual(['http://localhost:3000/ => https://example.com']);
  });

  it('stop in attach mode still closes via CDP and is harmless with no recorded pid', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['stop'], ATTACH_ENV, deps);
    expect(exitCode).toBe(0);
    expect(deps.closeBrowser).toHaveBeenCalledTimes(1);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removePidFile).toHaveBeenCalledTimes(1);
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
// parseArgv — the attestation + native-screen surface (§7.1 / §4 fn.²)
// ---------------------------------------------------------------------------

describe('parseArgv — attest', () => {
  it('parses each channel with its exact arity', () => {
    expect(parseArgv(['attest', 'http', '/__cyboflow_verify__'])).toEqual({
      ok: true,
      command: { kind: 'attest', channel: 'http', urlPath: '/__cyboflow_verify__' },
    });
    expect(parseArgv(['attest', 'dom', '#verify-marker'])).toEqual({
      ok: true,
      command: { kind: 'attest', channel: 'dom', selector: '#verify-marker' },
    });
    expect(parseArgv(['attest', 'cdp', 'window.__BUILD__', 'sha-1'])).toEqual({
      ok: true,
      command: { kind: 'attest', channel: 'cdp', expression: 'window.__BUILD__', expected: 'sha-1' },
    });
    expect(parseArgv(['attest', 'window', 'Cyboflow.*', 'Cyboflow'])).toEqual({
      ok: true,
      command: { kind: 'attest', channel: 'window', titlePattern: 'Cyboflow.*', app: 'Cyboflow' },
    });
  });

  it('rejects wrong arity per channel — an attest argument is a comparison target, never joined free text', () => {
    expect(parseArgv(['attest', 'http'])).toMatchObject({ ok: false });
    expect(parseArgv(['attest', 'http', '/a', '/b'])).toMatchObject({ ok: false });
    expect(parseArgv(['attest', 'dom'])).toMatchObject({ ok: false });
    expect(parseArgv(['attest', 'cdp', 'window.__BUILD__'])).toMatchObject({ ok: false });
    expect(parseArgv(['attest', 'cdp', 'a', 'b', 'c'])).toMatchObject({ ok: false });
    expect(parseArgv(['attest', 'window'])).toMatchObject({ ok: false });
  });

  it('rejects a missing or unknown channel', () => {
    expect(parseArgv(['attest'])).toMatchObject({ ok: false });
    expect(parseArgv(['attest', 'telepathy', 'x'])).toMatchObject({ ok: false });
  });
});

describe('parseArgv — native-screenshot', () => {
  it('parses a bare name and sanitizes it like the CDP screenshot does', () => {
    expect(parseArgv(['native-screenshot', '../evil'])).toEqual({
      ok: true,
      command: { kind: 'native-screenshot', name: 'evil.png', appTarget: undefined },
    });
  });

  it('parses an --app target', () => {
    expect(parseArgv(['native-screenshot', 'window', '--app', 'Cyboflow'])).toEqual({
      ok: true,
      command: { kind: 'native-screenshot', name: 'window.png', appTarget: 'Cyboflow' },
    });
  });

  it('rejects a missing name, a valueless --app, and an unknown flag', () => {
    expect(parseArgv(['native-screenshot'])).toMatchObject({ ok: false });
    expect(parseArgv(['native-screenshot', 'x', '--app'])).toMatchObject({ ok: false });
    expect(parseArgv(['native-screenshot', 'x', '--bogus'])).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// attest http — the `web` channel (§7.1): the serve step's injected route must
// hand back THIS request's nonce.
// ---------------------------------------------------------------------------

describe('runDriverCommand — attest http', () => {
  it('passes when the endpoint returns the nonce: exit 0, attest.json ok:true, no browser touched', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      httpGet: vi.fn(async (url: string) => {
        calls.httpGets.push(url);
        return { status: 200, body: `{"nonce":"${NONCE}"}` };
      }),
    });
    const exitCode = await runDriverCommand(['attest', 'http', '/__cyboflow_verify__'], ATTEST_ENV, deps);

    expect(exitCode).toBe(0);
    expect(calls.httpGets).toEqual(['http://127.0.0.1:29260/__cyboflow_verify__']);
    expect(calls.attestWrites[0].path).toBe(attestFilePath(ENV.VERIFY_ARTIFACTS_DIR));
    const record = soleAttestRecord(calls);
    expect(record).toMatchObject({ ok: true, kind: 'http-endpoint' });
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The identity check never needs a page — an attach-mode deliverable has none.
    expect(deps.connectOverCDP).not.toHaveBeenCalled();
  });

  it('normalizes a urlPath given without a leading slash', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      httpGet: vi.fn(async (url: string) => {
        calls.httpGets.push(url);
        return { status: 200, body: NONCE };
      }),
    });
    await runDriverCommand(['attest', 'http', '__verify__'], ATTEST_ENV, deps);
    expect(calls.httpGets).toEqual(['http://127.0.0.1:29260/__verify__']);
  });

  it('FAILS when the endpoint answers but the body does not carry the nonce (the false-ready case)', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, {
      httpGet: vi.fn(async () => ({ status: 200, body: 'some other app' })),
      stderr: (l) => stderrLines.push(l),
    });
    const exitCode = await runDriverCommand(['attest', 'http', '/__verify__'], ATTEST_ENV, deps);

    expect(exitCode).toBe(1);
    expect(soleAttestRecord(calls)).toMatchObject({ ok: false, kind: 'http-endpoint' });
    expect(stderrLines.join('\n')).toMatch(/does not carry this request's nonce/);
  });

  it('FAILS on a non-2xx response', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, { httpGet: vi.fn(async () => ({ status: 404, body: NONCE })) });
    const exitCode = await runDriverCommand(['attest', 'http', '/__verify__'], ATTEST_ENV, deps);
    expect(exitCode).toBe(1);
    expect(soleAttestRecord(calls)).toMatchObject({ ok: false });
    expect(soleAttestRecord(calls).detail).toMatch(/HTTP 404/);
  });

  it('records a THROWN probe as ok:false rather than exiting with no file at all', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      httpGet: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const exitCode = await runDriverCommand(['attest', 'http', '/__verify__'], ATTEST_ENV, deps);
    expect(exitCode).toBe(1);
    const record = soleAttestRecord(calls);
    expect(record.ok).toBe(false);
    expect(record.detail).toMatch(/probe failed/);
    expect(record.detail).toMatch(/ECONNREFUSED/);
  });

  it('FAILS (with a record) when VERIFY_ATTEST_NONCE or VERIFY_PORT is missing', async () => {
    const noNonce = freshCalls();
    expect(
      await runDriverCommand(['attest', 'http', '/x'], { ...ENV, VERIFY_PORT: '29260' }, makeDeps(noNonce)),
    ).toBe(1);
    expect(soleAttestRecord(noNonce).detail).toMatch(/VERIFY_ATTEST_NONCE/);

    const noPort = freshCalls();
    expect(
      await runDriverCommand(['attest', 'http', '/x'], { ...ENV, VERIFY_ATTEST_NONCE: NONCE }, makeDeps(noPort)),
    ).toBe(1);
    expect(soleAttestRecord(noPort).detail).toMatch(/VERIFY_PORT/);
  });
});

// ---------------------------------------------------------------------------
// attest dom — the `web` fallback channel: the nonce lives in the rendered DOM.
// ---------------------------------------------------------------------------

describe('runDriverCommand — attest dom', () => {
  it('passes when the element TEXT carries the nonce', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {}, { text: `build ${NONCE}` });
    const exitCode = await runDriverCommand(['attest', 'dom', '#marker'], ATTEST_ENV, deps);
    expect(exitCode).toBe(0);
    expect(soleAttestRecord(calls)).toMatchObject({ ok: true, kind: 'dom-marker' });
    expect(calls.textContents).toEqual(['#marker']);
  });

  it('passes when only the data-verify-nonce ATTRIBUTE carries it', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {}, { text: 'nothing useful', attr: NONCE });
    const exitCode = await runDriverCommand(['attest', 'dom', '#marker'], ATTEST_ENV, deps);
    expect(exitCode).toBe(0);
    expect(calls.attributes).toEqual([{ selector: '#marker', name: 'data-verify-nonce' }]);
    expect(soleAttestRecord(calls).ok).toBe(true);
  });

  it('FAILS when neither text nor attribute carries the nonce', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {}, { text: 'some other app', attr: 'stale-nonce' });
    const exitCode = await runDriverCommand(['attest', 'dom', '#marker'], ATTEST_ENV, deps);
    expect(exitCode).toBe(1);
    expect(soleAttestRecord(calls)).toMatchObject({ ok: false, kind: 'dom-marker' });
  });

  it('records ok:false (never a bare crash) when the page cannot be reached at all', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      connectOverCDP: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const exitCode = await runDriverCommand(['attest', 'dom', '#marker'], { ...ATTEST_ENV, VERIFY_DRIVER_ATTACH_ONLY: '1' }, deps);
    expect(exitCode).toBe(1);
    expect(soleAttestRecord(calls)).toMatchObject({ ok: false, kind: 'dom-marker' });
  });
});

// ---------------------------------------------------------------------------
// attest cdp — the `cdp-app` channel: the ONLY one that covers attach mode.
// ---------------------------------------------------------------------------

describe('runDriverCommand — attest cdp', () => {
  it('passes when the evaluated expression stringifies to the expected token, in ATTACH mode', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {}, { evaluateResult: 'sha-deadbeef' });
    const exitCode = await runDriverCommand(
      ['attest', 'cdp', 'window.__CYBOFLOW_BUILD__', 'sha-deadbeef'],
      { ...ATTEST_ENV, VERIFY_DRIVER_ATTACH_ONLY: '1' },
      deps,
    );
    expect(exitCode).toBe(0);
    expect(calls.evaluates).toEqual(['window.__CYBOFLOW_BUILD__']);
    expect(soleAttestRecord(calls)).toMatchObject({ ok: true, kind: 'cdp-token' });
    // Attach mode: attached, never launched.
    expect(deps.spawnDetachedChromium).not.toHaveBeenCalled();
  });

  it('FAILS on a mismatched token', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {}, { evaluateResult: 'sha-other' });
    const exitCode = await runDriverCommand(
      ['attest', 'cdp', 'window.__CYBOFLOW_BUILD__', 'sha-deadbeef'],
      ATTEST_ENV,
      deps,
    );
    expect(exitCode).toBe(1);
    const record = soleAttestRecord(calls);
    expect(record).toMatchObject({ ok: false, kind: 'cdp-token' });
    expect(record.detail).toMatch(/sha-other/);
  });

  it('FAILS when the expression evaluates to undefined (no build stamp exposed)', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {}, { evaluateResult: undefined });
    const exitCode = await runDriverCommand(['attest', 'cdp', 'window.__X__', 'sha-1'], ATTEST_ENV, deps);
    expect(exitCode).toBe(1);
    expect(soleAttestRecord(calls).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attest window — the `native-screen` channel (weakest, per §7.1).
// ---------------------------------------------------------------------------

describe('runDriverCommand — attest window', () => {
  // The shape the bundled binary actually emits (smoked): the app's own name
  // rides along in `target_application_info`, which is exactly what must NOT be
  // read as a window title.
  const listing = JSON.stringify({
    success: true,
    data: {
      target_application_info: { app_name: 'SomeOtherApp', bundle_id: 'com.x', pid: 1 },
      windows: [{ window_index: 0, window_title: 'Finder' }, { window_index: 1, window_title: 'Cyboflow — main' }],
    },
  });

  it('passes on a matching window title, shells the peekaboo bin from env, never touches CDP', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      runPeekaboo: vi.fn(async (bin: string, args: string[]) => {
        calls.peekaboo.push({ bin, args });
        return listing;
      }),
    });
    const exitCode = await runDriverCommand(
      ['attest', 'window', 'Cyboflow', 'Cyboflow'],
      { ...NATIVE_ENV, VERIFY_PEEKABOO_BIN: '/opt/peekaboo' },
      deps,
    );

    expect(exitCode).toBe(0);
    // SMOKED argv: `--json` is not a flag (exit 64) and `--app` is mandatory.
    expect(calls.peekaboo).toEqual([
      { bin: '/opt/peekaboo', args: ['list', 'windows', '--app', 'Cyboflow', '--json-output'] },
    ]);
    const record = soleAttestRecord(calls);
    expect(record).toMatchObject({ ok: true, kind: 'window-identity' });
    // §7.1 requires the weakness to be recorded on the verdict, not implied.
    expect(record.detail).toContain('window-identity (weakest channel)');
    expect(deps.connectOverCDP).not.toHaveBeenCalled();
  });

  it('falls back to the bare `peekaboo` PATH name when VERIFY_PEEKABOO_BIN is unset', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      runPeekaboo: vi.fn(async (bin: string, args: string[]) => {
        calls.peekaboo.push({ bin, args });
        return listing;
      }),
    });
    await runDriverCommand(['attest', 'window', 'Cyboflow', 'Cyboflow'], NATIVE_ENV, deps);
    expect(calls.peekaboo[0].bin).toBe('peekaboo');
  });

  it('FAILS when no listed window title matches, and still records the weakest-channel detail', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, { runPeekaboo: vi.fn(async () => listing) });
    const exitCode = await runDriverCommand(
      ['attest', 'window', 'NoSuchTitle', 'Cyboflow'],
      NATIVE_ENV,
      deps,
    );
    expect(exitCode).toBe(1);
    const record = soleAttestRecord(calls);
    expect(record).toMatchObject({ ok: false, kind: 'window-identity' });
    expect(record.detail).toContain('window-identity (weakest channel)');
  });

  it('records a missing/failing peekaboo binary as ok:false', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      runPeekaboo: vi.fn(async () => {
        throw new Error('spawn peekaboo ENOENT');
      }),
    });
    const exitCode = await runDriverCommand(
      ['attest', 'window', 'Cyboflow', 'Cyboflow'],
      NATIVE_ENV,
      deps,
    );
    expect(exitCode).toBe(1);
    expect(soleAttestRecord(calls).detail).toMatch(/ENOENT/);
  });
});

describe('extractWindowTitles', () => {
  it('reads the shape the bundled binary emits, and ONLY its windows', () => {
    // The app's own name must never be read as a window title: on the weakest
    // channel we have, a `titlePattern` matching the APPLICATION would
    // otherwise attest against an entry that is not a window at all.
    const stdout = JSON.stringify({
      success: true,
      data: {
        target_application_info: { app_name: 'Cyboflow', pid: 1 },
        windows: [{ window_title: 'A' }, { window_title: 'B' }],
      },
    });
    expect(extractWindowTitles(stdout)).toEqual(['A', 'B']);
  });

  it('reports an app with NO windows as no titles, rather than falling through', () => {
    // "That app is running and has no windows" is a real answer; falling
    // through to the tolerant walk would let app_name back in the side door.
    const stdout = JSON.stringify({
      success: true,
      data: { target_application_info: { app_name: 'Cyboflow' }, windows: [] },
    });
    expect(extractWindowTitles(stdout)).toEqual([]);
  });

  it('still walks an UNKNOWN json shape (a future peekaboo)', () => {
    const stdout = JSON.stringify({ result: { items: [{ title: 'A' }, { windowTitle: 'B' }] } });
    expect(extractWindowTitles(stdout)).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('falls back to one title per line when the output is not JSON', () => {
    expect(extractWindowTitles('Finder\n  Cyboflow — main  \n\n')).toEqual(['Finder', 'Cyboflow — main']);
  });
});

// ---------------------------------------------------------------------------
// native-screenshot — the only OBSERVE path for native-screen (§4 fn.²)
// ---------------------------------------------------------------------------

describe('runDriverCommand — native-screenshot', () => {
  it('captures into VERIFY_ARTIFACTS_DIR with peekaboo image --path, no --app when none is named', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['native-screenshot', 'home'], NATIVE_ENV, deps);
    expect(exitCode).toBe(0);
    expect(calls.peekaboo).toEqual([
      { bin: 'peekaboo', args: ['image', '--path', join(ENV.VERIFY_ARTIFACTS_DIR, 'home.png')] },
    ]);
    expect(deps.ensureDir).toHaveBeenCalledWith(ENV.VERIFY_ARTIFACTS_DIR);
    expect(deps.connectOverCDP).not.toHaveBeenCalled();
  });

  it('passes an --app target through in peekabooBackend\'s own flag order', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    await runDriverCommand(['native-screenshot', 'app', '--app', 'Cyboflow'], NATIVE_ENV, deps);
    expect(calls.peekaboo[0].args).toEqual([
      'image',
      '--app',
      'Cyboflow',
      '--path',
      join(ENV.VERIFY_ARTIFACTS_DIR, 'app.png'),
    ]);
  });

  it('is allowed regardless of attach mode (it never touches the browser)', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['native-screenshot', 'home'], { ...ATTACH_ENV, VERIFY_MODALITY: 'native-screen' }, deps);
    expect(exitCode).toBe(0);
    expect(calls.peekaboo).toHaveLength(1);
  });

  it('exits non-zero with the peekaboo error when the capture fails', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, {
      runPeekaboo: vi.fn(async () => {
        throw new Error('peekaboo exited 1: screen recording not granted');
      }),
      stderr: (l) => stderrLines.push(l),
    });
    const exitCode = await runDriverCommand(['native-screenshot', 'home'], NATIVE_ENV, deps);
    expect(exitCode).toBe(1);
    expect(stderrLines.join('\n')).toMatch(/screen recording not granted/);
  });

  it('requires VERIFY_ARTIFACTS_DIR but NOT a driver port (no CDP surface exists)', async () => {
    const withoutPort = freshCalls();
    const okDeps = makeDeps(withoutPort);
    expect(
      await runDriverCommand(
        ['native-screenshot', 'home'],
        { VERIFY_ARTIFACTS_DIR: ENV.VERIFY_ARTIFACTS_DIR, VERIFY_MODALITY: 'native-screen' },
        okDeps,
      ),
    ).toBe(0);

    const withoutDir = freshCalls();
    const failDeps = makeDeps(withoutDir);
    expect(await runDriverCommand(['native-screenshot', 'home'], { VERIFY_MODALITY: 'native-screen' }, failDeps)).toBe(1);
    expect(withoutDir.peekaboo).toEqual([]);
  });

  it('win32: captures via the PowerShell stand-in instead of peekaboo, notes the --app deviation', async () => {
    const calls = freshCalls();
    const captures: string[] = [];
    const deps = makeDeps(calls, {
      platform: 'win32',
      runWindowsCapture: vi.fn(async (outPath: string) => {
        captures.push(outPath);
      }),
    });

    const exitCode = await runDriverCommand(['native-screenshot', 'home', '--app', 'Cyboflow'], NATIVE_ENV, deps);

    expect(exitCode).toBe(0);
    expect(captures).toEqual([join(ENV.VERIFY_ARTIFACTS_DIR, 'home.png')]);
    // The macOS peekaboo ladder must NOT run.
    expect(calls.peekaboo).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// serve — the harness-owned surface lifetime
//
// The command exists so the RUNNER, not the agent, owns when the deliverable
// dies: the harness attests against the live surface after the session ends and
// tears it down itself. These pin the two facts that makes possible — the
// process group is recorded where the reaper looks, and the CLI returns without
// waiting on readiness (which stays the agent's job).
// ---------------------------------------------------------------------------

describe('runDriverCommand — serve', () => {
  it('spawns the command detached, records its process group at .driver/serve.pid, and returns immediately', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const stdoutLines: string[] = [];
    const withStdout = { ...deps, stdout: (l: string) => stdoutLines.push(l) };

    const exitCode = await runDriverCommand(['serve', 'pnpm dev --port 29260'], ENV, withStdout);

    expect(exitCode).toBe(0);
    expect(calls.shells).toEqual([
      { command: 'pnpm dev --port 29260', logPath: serveLogPath(ENV.VERIFY_ARTIFACTS_DIR) },
    ]);
    expect(deps.writePidFile).toHaveBeenCalledWith(servePidFilePath(ENV.VERIFY_ARTIFACTS_DIR), 5150);
    // Nothing waited on: no readiness poll, no CDP connect, no browser.
    expect(deps.waitForCdpReady).not.toHaveBeenCalled();
    expect(deps.connectOverCDP).not.toHaveBeenCalled();
    expect(stdoutLines.join('\n')).toContain('serve started');
  });

  it('needs VERIFY_ARTIFACTS_DIR but NOT a driver port (it starts a process, it does not drive one)', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    expect(
      await runDriverCommand(['serve', 'pnpm dev'], { VERIFY_ARTIFACTS_DIR: ENV.VERIFY_ARTIFACTS_DIR }, deps),
    ).toBe(0);

    const noDir = freshCalls();
    const noDirDeps = makeDeps(noDir);
    expect(await runDriverCommand(['serve', 'pnpm dev'], { VERIFY_DRIVER_PORT: '9333' }, noDirDeps)).toBe(1);
    expect(noDir.shells).toEqual([]);
  });

  it('is ALLOWED under native-screen — bringing the app up is not driving it', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    const exitCode = await runDriverCommand(['serve', 'electron .'], NATIVE_ENV, deps);
    expect(exitCode).toBe(0);
    expect(calls.shells).toHaveLength(1);
  });

  it('exits non-zero with the spawn error when the command cannot start (the agent reports launch_failed)', async () => {
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, {
      spawnDetachedShell: vi.fn(async () => {
        throw new Error('failed to spawn the serve command: no pid assigned');
      }),
      stderr: (l) => stderrLines.push(l),
    });
    const exitCode = await runDriverCommand(['serve', 'pnpm dev'], ENV, deps);
    expect(exitCode).toBe(1);
    expect(stderrLines.join('\n')).toContain('no pid assigned');
    expect(deps.writePidFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Lifecycle (round-3 finding 6): serve is called more than once in a real
  // session — a first attempt binds the wrong port, a build fix needs a restart.
  // Overwriting serve.pid leaked the earlier group entirely: the reaper reads
  // ONE pid, so every superseded server outlived the request still holding a
  // leased port, which the scheduler's teardown probe then quarantined.
  // -------------------------------------------------------------------------

  it('REPLACES a still-live previous serve: the old group is SIGKILLed before the new one starts', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      readPidFile: vi.fn(async () => 4200),
      isProcessAlive: vi.fn(() => true),
    });

    expect(await runDriverCommand(['serve', 'pnpm dev --port 29260'], ENV, deps)).toBe(0);

    expect(deps.readPidFile).toHaveBeenCalledWith(servePidFilePath(ENV.VERIFY_ARTIFACTS_DIR));
    // NEGATIVE pid = the whole process group, which is the unit that matters:
    // killing only the leader orphans the children actually holding the port.
    expect(deps.killPid).toHaveBeenCalledWith(-4200, 'SIGKILL');
    // …and the replacement still started and was recorded.
    expect(calls.shells).toHaveLength(1);
    expect(deps.writePidFile).toHaveBeenCalledWith(servePidFilePath(ENV.VERIFY_ARTIFACTS_DIR), 5150);
  });

  it('does NOT kill a recorded group that is already gone (a recycled pid is not ours to signal)', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      readPidFile: vi.fn(async () => 4200),
      isProcessAlive: vi.fn(() => false),
    });
    expect(await runDriverCommand(['serve', 'pnpm dev'], ENV, deps)).toBe(0);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(calls.shells).toHaveLength(1);
  });

  it('an unreadable previous pid file is not fatal — there is simply nothing to replace', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, {
      readPidFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    expect(await runDriverCommand(['serve', 'pnpm dev'], ENV, deps)).toBe(0);
    expect(calls.shells).toHaveLength(1);
  });

  it('kills the JUST-SPAWNED group and exits non-zero when its pid cannot be recorded', async () => {
    // A serve nobody can reap is strictly worse than a serve that never started:
    // the agent can retry the second one, while the first outlives the request
    // holding the leased port with no durable record of its existence.
    const calls = freshCalls();
    const stderrLines: string[] = [];
    const deps = makeDeps(calls, {
      writePidFile: vi.fn(async () => {
        throw new Error('ENOSPC');
      }),
      stderr: (l) => stderrLines.push(l),
    });

    expect(await runDriverCommand(['serve', 'pnpm dev'], ENV, deps)).toBe(1);

    expect(calls.shells).toHaveLength(1);
    expect(deps.killPid).toHaveBeenCalledWith(-5150, 'SIGKILL');
    expect(stderrLines.join('\n')).toContain('ENOSPC');
    expect(stderrLines.join('\n')).toContain('killed rather than left running untracked');
  });
});

// ---------------------------------------------------------------------------
// native-screen DRIVE GUARD (§4 fn.²) — observe-only, refused loudly
// ---------------------------------------------------------------------------

describe('runDriverCommand — native-screen drive guard', () => {
  const driveCommands: string[][] = [
    ['goto', 'https://example.com'],
    ['click', '#submit'],
    ['type', '#input', 'hello'],
    ['screenshot', 'home'],
  ];

  for (const argv of driveCommands) {
    it(`refuses \`${argv[0]}\` under VERIFY_MODALITY=native-screen, before any CDP connect`, async () => {
      const calls = freshCalls();
      const stderrLines: string[] = [];
      const deps = makeDeps(calls, { stderr: (l) => stderrLines.push(l) });
      const exitCode = await runDriverCommand(argv, NATIVE_ENV, deps);

      expect(exitCode).toBe(1);
      expect(stderrLines.join('\n')).toContain(NATIVE_SCREEN_DRIVE_REFUSAL);
      expect(deps.connectOverCDP).not.toHaveBeenCalled();
      expect(deps.spawnDetachedChromium).not.toHaveBeenCalled();
      expect(calls.gotos).toEqual([]);
      expect(calls.clicks).toEqual([]);
      expect(calls.fills).toEqual([]);
      expect(calls.screenshots).toEqual([]);
    });
  }

  it('leaves the same commands working on every OTHER modality', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    expect(await runDriverCommand(['goto', 'https://example.com'], { ...ENV, VERIFY_MODALITY: 'web' }, deps)).toBe(0);
    expect(calls.gotos).toEqual(['https://example.com']);
  });

  it('still permits attest window and native-screenshot — the native-screen surface', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls, { runPeekaboo: vi.fn(async () => JSON.stringify([{ title: 'Cyboflow' }])) });
    expect(await runDriverCommand(['attest', 'window', 'Cyboflow', 'Cyboflow'], NATIVE_ENV, deps)).toBe(0);
    expect(await runDriverCommand(['native-screenshot', 'home'], NATIVE_ENV, deps)).toBe(0);
  });

  it('stop is unaffected (teardown must always run)', async () => {
    const calls = freshCalls();
    const deps = makeDeps(calls);
    expect(await runDriverCommand(['stop'], NATIVE_ENV, deps)).toBe(0);
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

  it('attestFilePath sits beside browser.pid in the SAME driver dotdir', () => {
    expect(attestFilePath(artifactsDir)).toBe(join(artifactsDir, '.driver', 'attest.json'));
  });

  it('writeAttestFile creates the dotdir and writes a record the runner can parse back', async () => {
    const deps = createDefaultDriverDeps();
    const record: DriverAttestRecord = {
      ok: true,
      kind: 'cdp-token',
      detail: 'matched',
      at: '2026-07-30T00:00:00.000Z',
    };
    await deps.writeAttestFile(attestFilePath(artifactsDir), record);
    const { readFile } = await import('node:fs/promises');
    expect(JSON.parse(await readFile(attestFilePath(artifactsDir), 'utf8'))).toEqual(record);
  });

  it('isProcessAlive/killPid operate on real pids without spawning a browser', () => {
    const deps = createDefaultDriverDeps();
    expect(deps.isProcessAlive(process.pid)).toBe(true);
    expect(deps.isProcessAlive(999_999_999)).toBe(false);
    expect(() => deps.killPid(999_999_999, 'SIGKILL')).not.toThrow();
  });
});
