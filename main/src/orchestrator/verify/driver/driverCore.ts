/**
 * driverCore — the logic behind `$VERIFY_DRIVER`, the bundled headless-browser
 * CLI the centrally-deployed verification agent drives from Bash (see
 * docs/proposals/verification-agent-redesign.md §5.4 step 4 + §8 question 1).
 * The agent's tool surface is `Bash`/`Read`/`Grep`/`Glob` only and its
 * `mcpServers` map is deliberately empty — this CLI is the auditable
 * replacement for a Playwright MCP server the agent would otherwise need.
 *
 * Each `goto` / `click` / `type` / `screenshot` / `stop` invocation is a
 * SEPARATE process, but they must all act on ONE living page. This module
 * solves that with CDP reconnection rather than any in-process state:
 *
 *   1. Try `chromium.connectOverCDP('http://127.0.0.1:<port>')`.
 *   2. On failure, resolve a chromium executable, spawn it DETACHED with
 *      `--remote-debugging-port=<port>` (so it outlives this CLI process),
 *      record its pid under `$VERIFY_ARTIFACTS_DIR/.driver/browser.pid`, wait
 *      for the CDP endpoint to accept connections, then connect.
 *   3. Reuse the browser's first context/page (create one if none).
 *   4. After the command runs, simply return — connectOverCDP's `Browser` is
 *      never `.close()`d for goto/click/type/screenshot, which leaves the
 *      real chromium process running (it was never owned by this process to
 *      begin with; we spawned it separately and detached it).
 *
 * ATTACH-ONLY mode (`VERIFY_DRIVER_ATTACH_ONLY=1`): step 2's launch fallback is
 * disabled — the driver connect-ONLY's, because the app under test (an Electron
 * or other web-view host launched by the task's `serve.cmd` with
 * `--remote-debugging-port="$VERIFY_DRIVER_PORT"`) IS the CDP endpoint. A failed
 * connect is a hard, actionable error rather than a blank-chromium launch that
 * would screenshot the wrong surface. No pid is ever recorded in this mode, so
 * `stop`'s SIGKILL path is a natural no-op (the graceful CDP `Browser.close`
 * still fires, closing the app the agent launched).
 *
 * `stop` closes the browser via CDP when the endpoint is still reachable,
 * else SIGKILLs the recorded pid, and always exits 0 (best-effort cleanup —
 * the harness's own sweeper is the backstop, per §5.4 step 6's port-probe /
 * lease-quarantine posture).
 *
 * Everything here is pure/injectable: `runDriverCommand(argv, env, deps)`
 * takes a `DriverDeps` bag so unit tests can fake connect/launch/page
 * operations with no real browser. `playwright` itself is imported ONLY as a
 * type (erased at compile time) plus lazily via `await import('playwright')`
 * inside `createDefaultDriverDeps()`'s helpers — the same pattern
 * `playwrightBackend.ts` / `playwrightInstaller.ts` use so a build that
 * pruned the devDependency soft-fails instead of MODULE_NOT_FOUND-crashing.
 * `createDefaultDriverDeps()` is the only export that touches a real browser,
 * real filesystem, or a real child process; `driverCli.ts` is its only
 * caller.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright';

/** Subdirectory (under VERIFY_ARTIFACTS_DIR) holding driver-owned state. */
const DRIVER_STATE_DIR = '.driver';

/** Filename (under DRIVER_STATE_DIR) recording the launched browser's pid. */
const PID_FILE_NAME = 'browser.pid';

/** Per-action timeout for click/type locator operations. */
export const ACTION_TIMEOUT_MS = 10_000;

/** Navigation timeout for goto. */
export const NAV_TIMEOUT_MS = 30_000;

/** How long to wait for a freshly-launched chromium's CDP endpoint to accept. */
export const LAUNCH_TIMEOUT_MS = 15_000;

export const USAGE = `Usage:
  goto <url>
  click <selector>
  type <selector> <text...>
  screenshot <name> [--viewport WxH]
  stop`;

// ---------------------------------------------------------------------------
// Command model
// ---------------------------------------------------------------------------

export type DriverCommand =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'screenshot'; name: string; viewport?: { width: number; height: number } }
  | { kind: 'stop' };

export type ParseArgvResult = { ok: true; command: DriverCommand } | { ok: false; message: string };

/**
 * Parse the driver CLI's argv (already stripped of the node/script path — the
 * five subcommands are the whole surface). Bad args never throw — they
 * return `{ ok: false }` so the caller can print USAGE and exit non-zero.
 */
export function parseArgv(argv: string[]): ParseArgvResult {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'goto': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return { ok: false, message: 'goto requires exactly one argument: <url>' };
      }
      return { ok: true, command: { kind: 'goto', url: rest[0] } };
    }
    case 'click': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return { ok: false, message: 'click requires exactly one argument: <selector>' };
      }
      return { ok: true, command: { kind: 'click', selector: rest[0] } };
    }
    case 'type': {
      if (rest.length < 2) {
        return { ok: false, message: 'type requires two arguments: <selector> <text>' };
      }
      const [selector, ...textParts] = rest;
      return { ok: true, command: { kind: 'type', selector, text: textParts.join(' ') } };
    }
    case 'screenshot': {
      if (rest.length < 1) {
        return { ok: false, message: 'screenshot requires at least one argument: <name>' };
      }
      const [rawName, ...flags] = rest;
      let viewport: { width: number; height: number } | undefined;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--viewport') {
          const raw = flags[i + 1];
          const parsed = raw ? parseViewport(raw) : null;
          if (!parsed) {
            return { ok: false, message: `invalid --viewport value: ${raw ?? '(missing)'}` };
          }
          viewport = parsed;
          i++;
        } else {
          return { ok: false, message: `unknown flag: ${flags[i]}` };
        }
      }
      const name = sanitizeScreenshotName(rawName);
      if (!name) {
        return { ok: false, message: `invalid screenshot name: ${rawName}` };
      }
      return { ok: true, command: { kind: 'screenshot', name, viewport } };
    }
    case 'stop': {
      if (rest.length !== 0) {
        return { ok: false, message: 'stop takes no arguments' };
      }
      return { ok: true, command: { kind: 'stop' } };
    }
    default:
      return { ok: false, message: cmd ? `unknown command: ${cmd}` : 'no command given' };
  }
}

/** Parses a `WIDTHxHEIGHT` viewport spec (e.g. "1280x800"); null when malformed. */
function parseViewport(raw: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * basename-only sanitization (mirrors `cyboflow_report_artifact`'s screenshot
 * fileName rule): strips any directory component so `../evil` -> `evil.png`,
 * then appends `.png` when absent. Returns null for a name that sanitizes to
 * nothing usable (e.g. "..", "/", "").
 */
export function sanitizeScreenshotName(raw: string): string | null {
  const base = basename(raw.trim());
  if (!base || base === '.' || base === '..') return null;
  return /\.png$/i.test(base) ? base : `${base}.png`;
}

// ---------------------------------------------------------------------------
// Dependency seam (the "playwright-like object" tests inject)
// ---------------------------------------------------------------------------

export interface DriverDeps {
  /** `chromium.connectOverCDP(endpointUrl)` — rejects when nothing is listening. */
  connectOverCDP(endpointUrl: string): Promise<Browser>;
  /** Resolve a real chromium binary path, or null when none is installed. */
  resolveChromiumExecutable(): Promise<string | null>;
  /** Launch chromium DETACHED with a CDP port; returns its pid. */
  spawnDetachedChromium(args: {
    executablePath: string;
    port: number;
    userDataDir: string;
  }): Promise<{ pid: number }>;
  /** Poll the CDP endpoint until it accepts connections or timeoutMs elapses. */
  waitForCdpReady(port: number, timeoutMs: number): Promise<void>;
  /** `browser.close()` — for a CDP-attached Browser this terminates it. */
  closeBrowser(browser: Browser): Promise<void>;
  readPidFile(path: string): Promise<number | null>;
  writePidFile(path: string, pid: number): Promise<void>;
  removePidFile(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  isProcessAlive(pid: number): boolean;
  killPid(pid: number, signal: NodeJS.Signals): void;
  stdout(line: string): void;
  stderr(line: string): void;
}

/** `$VERIFY_ARTIFACTS_DIR/.driver/browser.pid` — exported so tests can assert on it. */
export function pidFilePath(artifactsDir: string): string {
  return join(artifactsDir, DRIVER_STATE_DIR, PID_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

type EnvCheck =
  | { ok: true; port: number; artifactsDir: string; attachOnly: boolean }
  | { ok: false; message: string };

/** Validates VERIFY_DRIVER_PORT + VERIFY_ARTIFACTS_DIR for the browser-touching commands. */
function requireEnv(env: NodeJS.ProcessEnv): EnvCheck {
  const portRaw = env.VERIFY_DRIVER_PORT;
  if (!portRaw || portRaw.trim().length === 0) {
    return { ok: false, message: 'VERIFY_DRIVER_PORT is required but not set' };
  }
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return { ok: false, message: `VERIFY_DRIVER_PORT is not a valid port: ${portRaw}` };
  }
  const artifactsDir = env.VERIFY_ARTIFACTS_DIR;
  if (!artifactsDir || artifactsDir.trim().length === 0) {
    return { ok: false, message: 'VERIFY_ARTIFACTS_DIR is required but not set' };
  }
  // Attach-only (VERIFY_DRIVER_ATTACH_ONLY=1): the app under test is launched by
  // the task's serve.cmd exposing CDP on VERIFY_DRIVER_PORT, so the connect-or-
  // launch fallback becomes connect-ONLY — never launch a blank chromium (which
  // would let the agent screenshot the WRONG surface and mis-judge).
  const attachOnly = env.VERIFY_DRIVER_ATTACH_ONLY === '1';
  return { ok: true, port, artifactsDir, attachOnly };
}

/**
 * Entry point: parse argv, dispatch, return a process exit code. `stop` is
 * handled separately (it must always exit 0 — missing env there just means
 * "nothing recorded to clean up", not an error) and does not require env.
 */
export async function runDriverCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: DriverDeps,
): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    deps.stderr(parsed.message);
    deps.stderr(USAGE);
    return 1;
  }

  if (parsed.command.kind === 'stop') {
    return stopCommand(env, deps);
  }

  const envResult = requireEnv(env);
  if (!envResult.ok) {
    deps.stderr(envResult.message);
    return 1;
  }

  try {
    const page = await ensurePage(
      envResult.port,
      envResult.artifactsDir,
      envResult.attachOnly,
      deps,
    );
    return await executeCommand(parsed.command, page, envResult.artifactsDir, deps);
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/**
 * connect-first-then-launch: tries CDP reconnection before ever launching a
 * browser. In `attachOnly` mode the launch fallback is DISABLED — a failed
 * connect is a hard error (the app under test must already be listening on the
 * driver port), because launching a blank chromium there would screenshot the
 * wrong surface. Attach mode also prefers the first NON-devtools page: an
 * Electron target's CDP endpoint commonly exposes `devtools://` inspector
 * pages alongside the real app window.
 */
async function ensurePage(
  port: number,
  artifactsDir: string,
  attachOnly: boolean,
  deps: DriverDeps,
): Promise<Page> {
  const cdpUrl = `http://127.0.0.1:${port}`;
  let browser: Browser;
  try {
    browser = await deps.connectOverCDP(cdpUrl);
  } catch {
    if (attachOnly) {
      throw new Error(
        `CDP endpoint not reachable on port ${port} — in attach mode the app under test must already be listening (launch it with --remote-debugging-port="$VERIFY_DRIVER_PORT" and wait for it to boot)`,
      );
    }
    browser = await launchAndConnect(port, artifactsDir, deps);
  }

  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const usablePages = attachOnly ? pages.filter((p) => !isDevtoolsPage(p)) : pages;
  const page = usablePages.length > 0 ? usablePages[0] : await context.newPage();
  return page;
}

/**
 * True for a `devtools://` inspector page. Guards on `url` being a callable
 * (real Playwright `Page.url()`) so the test seam's fake page — which has no
 * `url()` — is simply never treated as a devtools page.
 */
function isDevtoolsPage(page: Page): boolean {
  if (typeof page.url !== 'function') return false;
  try {
    return page.url().startsWith('devtools://');
  } catch {
    return false;
  }
}

async function launchAndConnect(port: number, artifactsDir: string, deps: DriverDeps): Promise<Browser> {
  const executablePath = await deps.resolveChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      'chromium executable not found — run `npx playwright install chromium` in the app environment',
    );
  }
  await deps.ensureDir(join(artifactsDir, DRIVER_STATE_DIR));
  const { pid } = await deps.spawnDetachedChromium({
    executablePath,
    port,
    userDataDir: join(artifactsDir, DRIVER_STATE_DIR, 'profile'),
  });
  await deps.writePidFile(pidFilePath(artifactsDir), pid);
  await deps.waitForCdpReady(port, LAUNCH_TIMEOUT_MS);
  return deps.connectOverCDP(`http://127.0.0.1:${port}`);
}

async function executeCommand(
  command: Exclude<DriverCommand, { kind: 'stop' }>,
  page: Page,
  artifactsDir: string,
  deps: DriverDeps,
): Promise<number> {
  switch (command.kind) {
    case 'goto': {
      const response = await page.goto(command.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      if (response && !response.ok()) {
        deps.stderr(`goto failed: ${command.url} returned HTTP ${response.status()}`);
        return 1;
      }
      deps.stdout(`ok: navigated to ${command.url}`);
      return 0;
    }
    case 'click': {
      await page.locator(command.selector).click({ timeout: ACTION_TIMEOUT_MS });
      deps.stdout(`ok: clicked ${command.selector}`);
      return 0;
    }
    case 'type': {
      await page.locator(command.selector).fill(command.text, { timeout: ACTION_TIMEOUT_MS });
      deps.stdout(`ok: typed into ${command.selector}`);
      return 0;
    }
    case 'screenshot': {
      if (command.viewport) {
        await page.setViewportSize(command.viewport);
      }
      await deps.ensureDir(artifactsDir);
      await page.screenshot({ path: join(artifactsDir, command.name) });
      deps.stdout(`ok: screenshot ${command.name}`);
      return 0;
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`unhandled driver command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * `stop` is best-effort cleanup and ALWAYS exits 0 (§5.4 step 6 — the
 * harness's port probe + lease quarantine is the real backstop, this is just
 * hygiene). Attempts a graceful CDP close when the endpoint is reachable, then
 * ALWAYS SIGKILLs the recorded pid: playwright's `close()` on a connectOverCDP
 * browser only DISCONNECTS the client, so a "successful" CDP close can leave
 * the spawned chromium alive and the port bound (observed live: leaked process
 * + port quarantine). SIGKILL is uncatchable, so once issued the pid file is
 * safe to remove. Missing env / no pid file / an already-gone process are all
 * silently fine.
 */
async function stopCommand(env: NodeJS.ProcessEnv, deps: DriverDeps): Promise<number> {
  const artifactsDir = env.VERIFY_ARTIFACTS_DIR;
  const portRaw = env.VERIFY_DRIVER_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : NaN;

  // Graceful CDP close first — never trusted as the kill (see the doc above).
  if (Number.isFinite(port) && port > 0) {
    try {
      const browser = await deps.connectOverCDP(`http://127.0.0.1:${port}`);
      await deps.closeBrowser(browser);
    } catch {
      // unreachable — the pid kill below is the real teardown.
    }
  }

  if (artifactsDir) {
    try {
      const pid = await deps.readPidFile(pidFilePath(artifactsDir));
      if (pid !== null && deps.isProcessAlive(pid)) {
        deps.killPid(pid, 'SIGKILL');
      }
    } catch {
      // best-effort — stop never fails the process.
    }
    await deps.removePidFile(pidFilePath(artifactsDir)).catch(() => {});
  }

  deps.stdout('ok: stopped');
  return 0;
}

// ---------------------------------------------------------------------------
// Real deps (the only part of this module that touches a real browser / fs / child process)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `playwright` is loaded LAZILY here (never at module scope) — same
 * contract as `playwrightBackend.ts` / `playwrightInstaller.ts`: a packaged
 * build that pruned the devDependency soft-fails at call time instead of
 * MODULE_NOT_FOUND-crashing this CLI's boot.
 */
async function defaultConnectOverCDP(endpointUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(endpointUrl);
}

async function defaultResolveChromiumExecutable(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    if (typeof p !== 'string' || p.length === 0) return null;
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

async function defaultSpawnDetachedChromium(args: {
  executablePath: string;
  port: number;
  userDataDir: string;
}): Promise<{ pid: number }> {
  const child = spawn(
    args.executablePath,
    [
      `--remote-debugging-port=${args.port}`,
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${args.userDataDir}`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  if (!child.pid) {
    throw new Error('failed to spawn chromium: no pid assigned');
  }
  return { pid: child.pid };
}

async function defaultWaitForCdpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  const suffix = lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '';
  throw new Error(`CDP endpoint on port ${port} did not become ready within ${timeoutMs}ms${suffix}`);
}

async function defaultReadPidFile(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function defaultWritePidFile(path: string, pid: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, String(pid), 'utf8');
}

async function defaultRemovePidFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone — stop is best-effort.
  }
}

/** Builds the real DriverDeps used by driverCli.ts. Never used by tests. */
export function createDefaultDriverDeps(): DriverDeps {
  return {
    connectOverCDP: defaultConnectOverCDP,
    resolveChromiumExecutable: defaultResolveChromiumExecutable,
    spawnDetachedChromium: defaultSpawnDetachedChromium,
    waitForCdpReady: defaultWaitForCdpReady,
    closeBrowser: async (browser) => {
      // `browser.close()` on a connectOverCDP browser only disconnects the
      // client — the CDP protocol `Browser.close` command is what actually
      // terminates the browser process. Send it first (chromium-only API, which
      // is the only browser this driver ever spawns), then disconnect; either
      // half failing falls through to stop's unconditional pid SIGKILL.
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch {
        // endpoint already gone or non-chromium — the disconnect below still runs.
      }
      await browser.close().catch(() => {});
    },
    readPidFile: defaultReadPidFile,
    writePidFile: defaultWritePidFile,
    removePidFile: defaultRemovePidFile,
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    isProcessAlive: defaultIsProcessAlive,
    killPid: defaultKillPid,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}
