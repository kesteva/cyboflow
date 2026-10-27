/**
 * Self-termination for vitest fork-pool workers whose root has died.
 *
 * WHY THIS EXISTS. A vitest fork-pool worker is an ordinary child process with no
 * lifetime link to its parent. macOS has no `PDEATHSIG` (Linux-only), and
 * tinypool's pool teardown — the thing that would normally kill the workers — only
 * runs if the ROOT exits gracefully. In agent contexts the root is essentially
 * never allowed to: the Claude harness abandons a Bash command after ~180s with no
 * output (and vitest is silent for long stretches), a stopped session hard-kills
 * the tree, and cyboflow's own teardown is a `killProcessTree` SIGKILL. A SIGKILL'd
 * root cannot clean up after itself, so its workers are adopted by launchd and keep
 * running. Two were observed holding ~2 GB and two cores for 24 minutes, which
 * pushed a 16 GB box to 79 MB free and 13.9 GB of swap.
 *
 * WHY THIS RUNS ON A SEPARATE THREAD — the part that is not obvious, and that a
 * plain `setInterval` gets wrong. When the root dies, the worker's IPC channel
 * breaks and the resulting uncaught exception wedges the process inside the libuv
 * CHECK phase, re-entering V8's own stack-trace formatter forever. Sampled stack
 * of a real orphan:
 *
 *     uv_run -> uv__run_check -> CheckImmediate -> ReportPendingMessages
 *            -> TriggerUncaughtException -> ErrorStackGetter -> FormatStackTrace -> ...
 *
 * The loop never advances to `uv__run_timers`, so NO main-thread JS callback can
 * ever run again — not a timer, not `process.on('disconnect')`, not an exit hook.
 * Both were tried against a live orphan and neither fired. A `worker_threads`
 * watchdog has its own isolate and event loop on its own OS thread, so it keeps
 * ticking while the main thread is wedged, and `process.kill(pid, 'SIGKILL')` from
 * it takes down the whole process regardless. Verified end to end: a process spun
 * up at 98% CPU in an infinite loop self-terminated within 1s of being orphaned.
 *
 * COST. The extra isolate measures ~12 MB RSS per worker. That is paid only while
 * a gate is running, and under managed mode — the case that actually produces
 * orphans — the fork cap is small (see `shared/types/testConcurrency.ts`), so it is
 * tens of MB against the ~2 GB a single orphan pair costs.
 *
 * SAFETY. Arming is gated on two independently-verified facts (see
 * {@link isForkPoolWorker}), and the orphan test itself is `ppid === 1`, which is a
 * proof rather than a heuristic: a live worker always has its root as parent. A
 * deliberately detached run (`nohup pnpm test:unit &`) reparents the ROOT, which is
 * titled `node (vitest)` and never matches the worker pattern.
 *
 * This is the innermost of three layers; `vitestForkCap.ts` reaps at gate start and
 * `VitestOrphanReaper` sweeps from the main process.
 */
import { isMainThread, Worker } from 'node:worker_threads';

import { isVitestWorkerTitle, ORPHAN_PPID } from './shared/types/testConcurrency';

/**
 * How often the watchdog thread checks whether we have been orphaned. Short
 * enough that a runaway fork is measured in seconds rather than the 24 minutes we
 * observed, long enough to be free: one integer read off `process`, no syscall.
 */
export const ORPHAN_POLL_INTERVAL_MS = 5_000;

/**
 * The watchdog thread's entire program. Kept as a string and run with
 * `eval: true` so there is no second file to resolve — a setup file is loaded
 * through vite, and a path-based worker entry would have to survive that.
 *
 * SIGKILL, not `process.exit()`: `process.exit()` inside a worker thread ends only
 * that thread, and the wedged main thread would carry on. The signal is delivered
 * to the process and is uncatchable, which is the only thing that reliably stops a
 * main thread stuck in a native loop.
 */
export const WATCHDOG_THREAD_SOURCE = `
const ORPHAN_PPID = ${ORPHAN_PPID};
setInterval(() => {
  if (process.ppid === ORPHAN_PPID) {
    process.kill(process.pid, 'SIGKILL');
  }
}, INTERVAL_MS);
`;

/** A spawned watchdog, narrowed to what this module uses. */
export interface WatchdogHandle {
  unref?: () => void;
  terminate?: () => void;
}

/** Injectable seams so the watchdog is unit-testable without spawning threads. */
export interface OrphanWatchdogDeps {
  /** This process's title. Defaults to `process.title`. */
  title?: string;
  /** True when this is the main thread of its own process. Defaults to node's value. */
  mainThread?: boolean;
  /** Poll cadence handed to the thread. Defaults to {@link ORPHAN_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Spawn the watchdog. Defaults to a `worker_threads` Worker running the source above. */
  spawn?: (source: string) => WatchdogHandle;
}

/**
 * Is this process a vitest FORK-pool worker — the one class of process that can
 * be orphaned by a dead root?
 *
 * Both conditions matter:
 *  - the title must be `node (vitest N)`, which excludes the root (`node (vitest)`)
 *    and anything that is not vitest at all; and
 *  - it must be the main thread of its own process, which excludes the `threads`
 *    pool. A worker THREAD shares the root's pid, so it would inherit the root's
 *    ppid — and a detached (`nohup`) root has ppid 1, which would otherwise read as
 *    "orphaned" and make a healthy run kill itself. It also stops the watchdog
 *    thread we spawn from recursively spawning one of its own.
 */
export function isForkPoolWorker(title: string, mainThread: boolean): boolean {
  return mainThread && isVitestWorkerTitle(title);
}

/**
 * Vitest <= 3 (tinypool) titled each fork worker `node (vitest N)`; vitest 4 replaced
 * tinypool with its own pool and sets no process title at all. Every layer of the
 * orphan defence (this watchdog, the `ps` scan in `vitestForkCap.ts`, the main-process
 * `VitestOrphanReaper`) recognises workers BY that title, so we apply it ourselves.
 * `VITEST_POOL_ID` is set by vitest's worker bootstrap (before setup files run) and
 * only in pool workers; the main-thread guard keeps worker-threads pools untouched.
 */
export function titleVitestForkWorker(
  mainThread: boolean = isMainThread,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const poolId = env.VITEST_POOL_ID;
  if (!mainThread || poolId === undefined || !/^\d+$/.test(poolId)) return;
  try {
    process.title = `node (vitest ${poolId})`;
  } catch {
    // Cosmetic for everything but the title-keyed reapers; never fail the gate.
  }
}

/** Default spawner: a real worker thread, unref'd so it never holds us open. */
function defaultSpawn(source: string): WatchdogHandle {
  const worker = new Worker(source, { eval: true });
  // Never let the watchdog be the reason the process stays alive: a healthy
  // worker must still exit the instant its pool releases it.
  worker.unref();
  return worker;
}

/**
 * Arm the orphan watchdog for this process. A no-op returning `undefined` unless
 * this really is a fork-pool worker, so it is safe to call unconditionally from a
 * setup file — including from the frontend's jsdom suite and from a human's
 * terminal run.
 *
 * Returns a disarm function when armed. Fail-soft: if the thread cannot be
 * spawned at all, the gate proceeds unwatched rather than failing, and the outer
 * two layers still cover it.
 */
export function startOrphanWatchdog(deps: OrphanWatchdogDeps = {}): (() => void) | undefined {
  const mainThread = deps.mainThread ?? isMainThread;
  if (deps.title === undefined) titleVitestForkWorker(mainThread);
  const title = deps.title ?? process.title;
  if (!isForkPoolWorker(title, mainThread)) return undefined;

  const intervalMs = deps.intervalMs ?? ORPHAN_POLL_INTERVAL_MS;
  const spawn = deps.spawn ?? defaultSpawn;
  const source = WATCHDOG_THREAD_SOURCE.replace('INTERVAL_MS', String(intervalMs));

  try {
    const handle = spawn(source);
    return () => handle.terminate?.();
  } catch {
    // A sandbox that forbids threads, or a node build without worker_threads.
    // Losing the watchdog is not worth losing the test run over.
    return undefined;
  }
}
