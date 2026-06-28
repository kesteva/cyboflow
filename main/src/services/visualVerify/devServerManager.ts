/**
 * DevServerManager — the concrete dev-server spawner for layered visual
 * verification (see docs/visual-verification-design.md §"Locked decisions" #1 +
 * the S2 slice). The scheduler OWNS the dev server: per a deliverable's
 * `.cyboflow/verify.json` `build` / `start` / `readyWhen` / `${PORT}` contract it
 * stands the deliverable up on a leased `verify:port:<p>`, waits for readiness,
 * threads the resulting baseUrl into capture, and tears the process tree down
 * after. Centralizing this here (one spawner over the count-1 port pool) is what
 * serializes port collisions — lanes never start their own dev servers.
 *
 * This file lives under main/src/services/* and MAY import node:child_process —
 * it is the concrete, child-process-backed half INJECTED into the (electron-free,
 * child-process-free) scheduler as a DevServerProvider. The scheduler imports the
 * DevServerProvider / DevServerHandle TYPES from orchestrator/verify (a
 * services->orchestrator import is allowed); it never imports this module
 * (orchestrator->services is forbidden — standalone-typecheck invariant). index.ts
 * wires the concrete instance in, exactly like CapturePageBackend + VlmJudge.
 *
 * Spawn pattern mirrors AbstractCliManager.spawnPtyProcess / killProcessTree:
 *  - optional `build` runs first, awaited to completion (a non-zero exit aborts).
 *  - `start` is spawned long-lived with `${PORT}` interpolated + the PORT env var
 *    set, in its OWN process group (detached) so the whole tree can be signalled.
 *  - readiness = the `readyWhen` token appearing in stdout/stderr (default
 *    fallback: a basic HTTP poll on baseUrl) — whichever resolves first.
 *  - teardown (release()) = graceful SIGTERM on the process GROUP, then a SIGKILL
 *    fallback after a grace window (the killProcessTree shape, minus the pty path).
 *  - the per-request AbortSignal interrupts an in-flight build/start/readiness wait
 *    cleanly and tears down whatever was already spawned.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { DeliverableVerifyConfig } from '../../../../shared/types/visualVerification';
import type {
  DevServerHandle,
  DevServerProvider,
  DevServerSpawnArgs,
} from '../../orchestrator/verify/verificationScheduler';
import type { LoggerLike } from '../../orchestrator/types';

/** How long to wait for `readyWhen` (or the baseUrl poll) before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Interval between baseUrl readiness polls when no readyWhen token is configured. */
const READY_POLL_INTERVAL_MS = 500;

/** Grace window between SIGTERM and the SIGKILL fallback during teardown. */
const TEARDOWN_GRACE_MS = 2_000;

/** Construction-time tunables (overridable in tests so they run fast). */
export interface DevServerManagerOptions {
  logger?: LoggerLike;
  /** Readiness deadline (ms). Defaults to DEFAULT_READY_TIMEOUT_MS. */
  readyTimeoutMs?: number;
  /** SIGTERM→SIGKILL grace (ms). Defaults to TEARDOWN_GRACE_MS. */
  teardownGraceMs?: number;
  /** baseUrl readiness poll interval (ms). Defaults to READY_POLL_INTERVAL_MS. */
  readyPollIntervalMs?: number;
  /**
   * Injectable HTTP probe for the default (no readyWhen) readiness path. Resolves
   * true once the server answers. Defaults to a fetch-based GET that treats ANY
   * HTTP response (even 404/500) as "the port is listening". Tests inject a fake.
   */
  httpProbe?: (url: string, signal: AbortSignal) => Promise<boolean>;
}

/**
 * Interpolate `${PORT}` in a command with the leased port. Both `${PORT}` and the
 * bare-word `$PORT` forms are replaced so a verify.json author can use either; the
 * PORT env var is ALSO set (below) so a tool that reads the environment works
 * without any placeholder at all.
 */
export function interpolatePort(command: string, port: number): string {
  return command.replace(/\$\{PORT\}/g, String(port)).replace(/\$PORT\b/g, String(port));
}

/** The default HTTP readiness probe: any response (incl. 4xx/5xx) means "listening". */
async function defaultHttpProbe(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { signal, method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

export class DevServerManager implements DevServerProvider {
  private readonly logger?: LoggerLike;
  private readonly readyTimeoutMs: number;
  private readonly teardownGraceMs: number;
  private readonly readyPollIntervalMs: number;
  private readonly httpProbe: (url: string, signal: AbortSignal) => Promise<boolean>;

  constructor(opts: DevServerManagerOptions = {}) {
    this.logger = opts.logger;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.teardownGraceMs = opts.teardownGraceMs ?? TEARDOWN_GRACE_MS;
    this.readyPollIntervalMs = opts.readyPollIntervalMs ?? READY_POLL_INTERVAL_MS;
    this.httpProbe = opts.httpProbe ?? defaultHttpProbe;
  }

  /**
   * Stand the deliverable up on the leased port and return a DevServerHandle whose
   * baseUrl the scheduler threads into capture and whose release() tears the
   * process tree down. Order: build (if any, awaited) → spawn start → await
   * readiness. Any failure (build exit, spawn error, readiness timeout) rejects
   * AFTER tearing down whatever was spawned, so a failed spawn never leaks a
   * process or the leased port. The AbortSignal interrupts every phase.
   */
  async spawn(args: DevServerSpawnArgs): Promise<DevServerHandle> {
    const { config, port, cwd, signal } = args;
    if (signal.aborted) {
      throw new Error('dev-server spawn aborted before start');
    }

    // The baseUrl the backend captures. A verify.json `url` may pin a host/path;
    // otherwise default to localhost on the leased port.
    const baseUrl = this.resolveBaseUrl(config, port);

    // (1) build — run to completion BEFORE start (a build failure aborts the spawn).
    if (config.build && config.build.trim().length > 0) {
      await this.runBuild(interpolatePort(config.build, port), cwd, port, signal);
    }
    if (signal.aborted) {
      throw new Error('dev-server spawn aborted after build');
    }

    // (2) start — long-lived, in its own process group so the whole tree dies on
    // teardown. `${PORT}`/`$PORT` interpolated + PORT env set.
    if (!config.start || config.start.trim().length === 0) {
      // Spawn was requested without a start command — nothing to run. The caller
      // (scheduler) only calls spawn when config.start is present, but guard anyway.
      throw new Error('dev-server spawn requires a start command');
    }
    const startCommand = interpolatePort(config.start, port);
    const child = spawn(startCommand, {
      cwd,
      shell: true,
      detached: true, // own process group → kill(-pid) reaches the whole tree.
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // release() must be safe to build now so we can tear down on ANY later failure.
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await this.teardown(child, startCommand);
    };

    try {
      await this.awaitReady(child, config, baseUrl, signal);
    } catch (err) {
      // Readiness failed / aborted — tear down the just-spawned tree, then rethrow
      // so the scheduler marks the request failed/timeout and releases the lease.
      await release();
      throw err;
    }

    this.logger?.info('[DevServerManager] dev server ready', { baseUrl, port });
    return { baseUrl, release };
  }

  /** localhost:<port> unless verify.json pins an explicit url. */
  private resolveBaseUrl(config: DeliverableVerifyConfig, port: number): string {
    if (config.url && config.url.trim().length > 0) {
      return interpolatePort(config.url.trim(), port);
    }
    return `http://localhost:${port}`;
  }

  /**
   * Run the optional `build` command to completion. Rejects on a non-zero exit, a
   * spawn error, or abort (killing the build process group on abort/teardown).
   */
  private runBuild(command: string, cwd: string, port: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('dev-server build aborted'));
        return;
      }
      const child = spawn(command, {
        cwd,
        shell: true,
        detached: true,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.killTree(child);
        reject(new Error('dev-server build aborted'));
      };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      child.on('exit', (code, sig) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`dev-server build failed (exit code ${code ?? sig ?? 'unknown'})`));
        }
      });
    });
  }

  /**
   * Resolve once the server is ready: the `readyWhen` token appears on
   * stdout/stderr, OR (no token configured) the baseUrl HTTP probe answers. Rejects
   * on the readiness timeout, the child exiting early, a spawn error, or abort.
   */
  private awaitReady(
    child: ChildProcess,
    config: DeliverableVerifyConfig,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const token =
        config.readyWhen && config.readyWhen.trim().length > 0 ? config.readyWhen.trim() : null;

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (pollTimer) clearTimeout(pollTimer);
        child.stdout?.removeListener('data', onData);
        child.stderr?.removeListener('data', onData);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };

      const onData = (chunk: Buffer | string): void => {
        if (!token) return;
        if (chunk.toString().includes(token)) {
          this.logger?.debug('[DevServerManager] readyWhen token observed', { token });
          finish();
        }
      };
      const onExit = (code: number | null, sig: NodeJS.Signals | null): void => {
        finish(new Error(`dev server exited before ready (code ${code ?? sig ?? 'unknown'})`));
      };
      const onError = (err: Error): void => {
        finish(err instanceof Error ? err : new Error(String(err)));
      };
      const onAbort = (): void => finish(new Error('dev-server readiness aborted'));

      const deadline = setTimeout(() => {
        finish(new Error(`dev server not ready within ${this.readyTimeoutMs}ms`));
      }, this.readyTimeoutMs);
      if (typeof deadline === 'object' && deadline !== null && 'unref' in deadline) {
        (deadline as { unref: () => void }).unref();
      }

      if (signal.aborted) {
        finish(new Error('dev-server readiness aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', onExit);
      child.on('error', onError);
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      // No token → poll the baseUrl until it answers (or the deadline/abort fires).
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      if (!token) {
        const poll = (): void => {
          if (settled) return;
          void this.httpProbe(baseUrl, signal).then((ok) => {
            if (settled) return;
            if (ok) {
              this.logger?.debug('[DevServerManager] baseUrl readiness probe answered', { baseUrl });
              finish();
            } else {
              pollTimer = setTimeout(poll, this.readyPollIntervalMs);
            }
          });
        };
        poll();
      }
    });
  }

  /**
   * Teardown the dev-server tree: graceful SIGTERM on the process GROUP, then a
   * SIGKILL fallback after the grace window (the killProcessTree shape sans the pty
   * path). detached:true means the child leads its own group, so kill(-pid, sig)
   * signals the whole tree. Fail-soft — a process that is already dead is fine.
   */
  private async teardown(child: ChildProcess, command: string): Promise<void> {
    this.logger?.debug('[DevServerManager] tearing down dev server', { command });
    this.signalTree(child, 'SIGTERM');
    // Give the tree a chance to exit gracefully.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.teardownGraceMs);
      if (typeof t === 'object' && t !== null && 'unref' in t) {
        (t as { unref: () => void }).unref();
      }
      // Resolve early if it exits before the grace window elapses.
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (child.exitCode === null && child.signalCode === null) {
      this.signalTree(child, 'SIGKILL');
    }
  }

  /** Abort-path immediate hard kill of a just-spawned build/start tree. */
  private killTree(child: ChildProcess): void {
    this.signalTree(child, 'SIGTERM');
    this.signalTree(child, 'SIGKILL');
  }

  /**
   * Send a signal to the child's whole process GROUP (negative pid), falling back
   * to the single child if the group signal is rejected. Mirrors AbstractCliManager
   * (SIGTERM/SIGKILL on -pid). Swallows ESRCH (already dead).
   */
  private signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      // Negative pid → the whole process group (detached:true makes pid the leader).
      process.kill(-pid, sig);
    } catch (err) {
      // Group kill failed (e.g. no group / already gone) — try the single process.
      try {
        process.kill(pid, sig);
      } catch {
        // Already dead — nothing to do.
      }
      this.logger?.debug('[DevServerManager] group signal fell back to single pid', {
        pid,
        sig,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
