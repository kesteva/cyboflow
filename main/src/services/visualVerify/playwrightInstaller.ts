/**
 * playwrightInstaller — lazy, chromium-ONLY browser-binary provisioning for the
 * Rung-1 PlaywrightBackend (see docs/visual-verification-design.md §L2 +
 * "Open decision #3: Playwright bundling = lazy-install chromium-only"). The
 * `playwright` LIBRARY is a dependency, but its browser binaries are deliberately
 * NOT bundled into the packaged app (they are large + platform-specific). This
 * module ensures the chromium binary is present on FIRST use and at most ONCE per
 * process — never bundled, never re-installed.
 *
 * This file lives under main/src/services/* and MAY import node:child_process + the
 * 'playwright' package — but it imports the package LAZILY (`await import('playwright')`,
 * see the NOTE below) so a pruned-in-packaging devDependency soft-fails instead of
 * crashing the boot path. The backend imports this; the (electron-free,
 * child-process-free) scheduler never does.
 *
 * Strategy (idempotent + memoized):
 *  1. Probe whether chromium is already installed (chromium.executablePath()
 *     resolves to an EXISTING file). If so, nothing to do — the common case after
 *     the first run / in a dev checkout with browsers already downloaded.
 *  2. Otherwise run `npx playwright install chromium` ONCE, capturing the result in
 *     a memoized promise so concurrent lanes share the single install.
 *
 * Failure is SOFT: ensureChromium() resolves to false (never throws) when the
 * binary is absent AND the install fails — the backend's healthCheck() then
 * returns false, the resolver drops 'playwright' from the chain, and the request
 * falls forward / SKIPs per never-silently-pass (missing precondition ⇒ SKIPPED,
 * never FAIL, never hang).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { LoggerLike } from '../../orchestrator/types';

// NOTE: `playwright` is NOT imported eagerly at the top level. It is a ROOT
// devDependency (present for E2E) — electron-builder prunes devDependencies when
// packaging, and `main` is compiled with plain `tsc` (no bundler inlining), so an
// eager `import { chromium } from 'playwright'` would `require('playwright')` at
// RUNTIME against the packaged node_modules and MODULE_NOT_FOUND-crash the app on
// launch (invisible to `pnpm dev` + the unit gate, which have root devDeps). We
// therefore load it LAZILY via `await import('playwright')` inside the async paths
// below, wrapped so a missing MODULE soft-fails (ensureChromium → false) exactly
// like a missing chromium BINARY. The default browserFactory in playwrightBackend.ts
// does the same. (The long-term fix is to promote `playwright` to dependencies; this
// lazy guard keeps the boot path safe regardless.)

/** How long to wait for `npx playwright install chromium` before giving up. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Construction-time tunables (overridable in tests so they run fast / hermetic). */
export interface PlaywrightInstallerOptions {
  logger?: LoggerLike;
  /**
   * Resolves the chromium executable path (defaults to playwright's
   * chromium.executablePath(), loaded lazily). Returns null when playwright reports
   * none OR the `playwright` module itself is absent. May be sync or async so tests
   * can inject a plain `() => '/fake/chromium'`.
   */
  executablePath?: () => string | null | Promise<string | null>;
  /** Probe whether a resolved path exists on disk (defaults to fs.existsSync). */
  pathExists?: (p: string) => boolean;
  /**
   * Runs the actual install, resolving true on success. Defaults to spawning
   * `npx playwright install chromium`. Tests inject a fake so no real download runs.
   */
  runInstall?: (signal: AbortSignal) => Promise<boolean>;
  /** Install deadline (ms). Defaults to INSTALL_TIMEOUT_MS. */
  installTimeoutMs?: number;
}

/**
 * Default chromium-path resolver — LAZILY imports `playwright` and asks chromium for
 * its executable path. Returns null when the module is absent (packaged build that
 * pruned the devDependency) OR playwright reports no path. Never throws (soft-fail).
 */
async function defaultExecutablePath(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    // Missing `playwright` module OR a path-resolution error: treat as not installed.
    return null;
  }
}

/**
 * Default installer: `npx playwright install chromium` (chromium ONLY — never the
 * full browser set). Resolves true on exit code 0, false on any non-zero exit /
 * spawn error / timeout / abort. Never throws (soft-fail contract).
 */
function defaultRunInstall(signal: AbortSignal, timeoutMs: number, logger?: LoggerLike): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    logger?.info('[PlaywrightInstaller] installing chromium (npx playwright install chromium)');
    const child = spawn('npx', ['playwright', 'install', 'chromium'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish(false);
    };
    const timer = setTimeout(() => {
      logger?.warn('[PlaywrightInstaller] chromium install timed out', { timeoutMs });
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish(false);
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      logger?.warn('[PlaywrightInstaller] chromium install spawn error', {
        error: err instanceof Error ? err.message : String(err),
      });
      finish(false);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        logger?.info('[PlaywrightInstaller] chromium installed');
        finish(true);
      } else {
        logger?.warn('[PlaywrightInstaller] chromium install exited non-zero', { code });
        finish(false);
      }
    });
  });
}

/**
 * PlaywrightInstaller — memoized, idempotent chromium provisioning. ensureChromium()
 * returns the SAME promise on every call after the first (install at most once per
 * process). A failed install is NOT cached as a hard failure unless it failed
 * because the binary was genuinely unavailable — but for simplicity + the
 * never-hang contract the result (true/false) IS memoized so repeated requests in
 * a degraded host do not re-spawn npx N times. A later process restart re-probes.
 */
export class PlaywrightInstaller {
  private readonly logger?: LoggerLike;
  private readonly executablePath: () => string | null | Promise<string | null>;
  private readonly pathExists: (p: string) => boolean;
  private readonly runInstall: (signal: AbortSignal) => Promise<boolean>;
  private readonly installTimeoutMs: number;

  /** Memoized in-flight / settled ensure promise (install at most once per process). */
  private ensurePromise: Promise<boolean> | null = null;

  constructor(opts: PlaywrightInstallerOptions = {}) {
    this.logger = opts.logger;
    this.installTimeoutMs = opts.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
    this.executablePath = opts.executablePath ?? defaultExecutablePath;
    this.pathExists = opts.pathExists ?? existsSync;
    this.runInstall =
      opts.runInstall ??
      ((signal: AbortSignal) => defaultRunInstall(signal, this.installTimeoutMs, this.logger));
  }

  /**
   * True when chromium's executable already resolves to an existing file. Async
   * because the default resolver lazy-imports `playwright` (a sync test fake is also
   * accepted — `await` of a non-promise is a no-op).
   */
  async isInstalled(): Promise<boolean> {
    const p = await this.executablePath();
    return p !== null && this.pathExists(p);
  }

  /**
   * Ensure chromium is installed, returning true once it is available + false when
   * it is absent AND the install failed. Idempotent + memoized: the first call may
   * trigger an install; every subsequent call shares the SAME settled promise (no
   * re-spawn). Never throws — a degraded host yields false (the backend
   * healthCheck() then drops playwright from the chain).
   */
  ensureChromium(signal?: AbortSignal): Promise<boolean> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.doEnsure(signal ?? new AbortController().signal);
    return this.ensurePromise;
  }

  private async doEnsure(signal: AbortSignal): Promise<boolean> {
    if (await this.isInstalled()) return true;
    try {
      const ok = await this.runInstall(signal);
      // Re-probe: a "success" exit that left no binary is still a failure.
      if (ok && (await this.isInstalled())) return true;
      if (ok && !(await this.isInstalled())) {
        this.logger?.warn('[PlaywrightInstaller] install reported success but chromium still absent');
      }
      return false;
    } catch (err) {
      // The default installer never throws; an injected one might. Soft-fail.
      this.logger?.warn('[PlaywrightInstaller] ensureChromium failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Reset the memoized ensure result — intended for tests only. */
  _resetForTesting(): void {
    this.ensurePromise = null;
  }
}
