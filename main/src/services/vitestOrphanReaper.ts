/**
 * VitestOrphanReaper — the main-process backstop for abandoned vitest fork-pool
 * workers left behind anywhere on this machine.
 *
 * WHY THESE LEAK. A vitest pool worker is an ordinary child process with no
 * lifetime link to its parent (macOS has no `PDEATHSIG`), and tinypool's pool
 * teardown only runs when the ROOT exits gracefully. Under cyboflow the root
 * essentially never does: the Claude harness abandons a Bash command after ~180s
 * with no output and vitest is silent for long stretches, a stopped session
 * hard-kills the tree, and run teardown is a `killProcessTree` SIGKILL. A SIGKILL'd
 * root cannot kill its own pool, so the workers are adopted by launchd and spin at
 * ~100% CPU on a full test file's heap forever, with nobody left to read their
 * results. Two were observed holding ~2 GB and two cores for 24 minutes, which
 * pushed a 16 GB box to 79 MB of free memory and 13.9 GB of swap.
 *
 * WHY THIS IS A GLOBAL, ANYTIME SWEEP — unlike {@link CodexBrokerReaper}, which is
 * carefully scoped to cyboflow's own worktree roots and runs only at boot. That
 * caution exists because a Codex broker is a long-lived daemon with no idle
 * signal, so a third party's broker is indistinguishable from a stale one and
 * might be mid-turn. Nothing of the kind applies here: `ppid === 1` on a worker is
 * a PROOF of abandonment, not a heuristic, because a live worker always has its
 * root as parent. There is no such thing as a legitimately orphaned vitest worker
 * — not cyboflow's, not another tool's — so this needs no scoping to be safe, and
 * it can run mid-session, which matters because that is exactly when sprint lanes
 * produce orphans.
 *
 * A detached run (`nohup pnpm test:unit &`) reparents the ROOT, titled
 * `node (vitest)`, which never matches the worker pattern and is never touched.
 *
 * This is the outermost of three layers. `vitestOrphanWatchdog.ts` has each worker
 * exit itself within seconds of losing its root (the layer that actually fires
 * first, and the only one that works when cyboflow is not running); `vitestForkCap.ts`
 * reaps at gate start and charges any survivor against the fork cap; this service
 * catches whatever predates or slips past both — a worker from an older checkout
 * whose setup file has no watchdog, or one orphaned in a worktree nobody will run
 * a gate in again.
 */
import { isOrphanedWorker } from '../../../shared/types/testConcurrency';
import type { LoggerLike } from '../orchestrator/types';
import { collectProcessTree, type ProcessRow } from './processTable';
import { listProcessTable } from '../utils/platformProcess';

/** How often the periodic sweep runs. */
export const VITEST_ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Construction-time seams — the real `ps`/`process.kill` impls are the defaults. */
export interface VitestOrphanReaperOptions {
  /** List host processes. Defaults to `ps -axo pid=,ppid=,command=`. */
  listProcesses?: () => Promise<ProcessRow[]>;
  /** Kill one PID. Defaults to SIGKILL — see {@link VitestOrphanReaper.sweep}. */
  killPid?: (pid: number) => void;
  /** Periodic sweep cadence. Defaults to {@link VITEST_ORPHAN_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
  /** Optional structured logger (warn on kills, debug on clean sweeps). */
  logger?: LoggerLike;
}

/** Default killer: SIGKILL the PID. May throw (dead PID) — caller guards. */
function defaultKillPid(pid: number): void {
  process.kill(pid, 'SIGKILL');
}

export class VitestOrphanReaper {
  private readonly listProcesses: () => Promise<ProcessRow[]>;
  private readonly killPid: (pid: number) => void;
  private readonly intervalMs: number;
  private readonly logger?: LoggerLike;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: VitestOrphanReaperOptions = {}) {
    this.listProcesses = opts.listProcesses ?? listProcessTable;
    this.killPid = opts.killPid ?? defaultKillPid;
    this.intervalMs = opts.intervalMs ?? VITEST_ORPHAN_SWEEP_INTERVAL_MS;
    this.logger = opts.logger;
  }

  /**
   * Kill every abandoned vitest pool worker on this machine, plus anything each
   * one spawned (a test that started a server leaves its own orphan behind when
   * the worker dies). Returns the number of processes killed.
   *
   * SIGKILL rather than the SIGTERM `CodexBrokerReaper` uses, deliberately: an
   * orphaned worker has no cleanup worth running, and it is by definition stopped
   * mid-test — possibly inside a tight loop or a signal handler a test file
   * installed — so a catchable signal is not reliably fatal. A broker, by
   * contrast, has sockets and pid files to tidy up.
   *
   * Fail-soft throughout: a `ps` failure or a per-PID kill throw is logged and
   * swallowed, never thrown — reaping must never block boot.
   */
  async sweep(): Promise<number> {
    let processes: ProcessRow[];
    try {
      processes = await this.listProcesses();
    } catch (err) {
      this.logger?.error('[VitestOrphanReaper] listing processes failed — skipping', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    const orphanPids = processes
      .filter((proc) => isOrphanedWorker(proc.command, proc.ppid))
      .map((proc) => proc.pid);

    if (orphanPids.length === 0) {
      this.logger?.debug('[VitestOrphanReaper] no orphaned vitest workers');
      return 0;
    }

    const tree = collectProcessTree(orphanPids, processes);
    let killed = 0;
    for (const pid of tree) {
      try {
        this.killPid(pid);
        killed += 1;
      } catch (err) {
        // A dead / permission-denied PID must not abort the loop.
        this.logger?.debug('[VitestOrphanReaper] kill failed (already gone?) — continuing', {
          pid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.logger?.warn('[VitestOrphanReaper] reaped abandoned vitest pool worker(s)', {
      workers: orphanPids.length,
      processesKilled: killed,
    });
    return killed;
  }

  /**
   * Begin sweeping on an interval, in addition to whatever boot sweep the caller
   * runs. Idempotent — calling twice does not stack timers. The timer is unref'd
   * so it never holds the process open at quit.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        this.logger?.error('[VitestOrphanReaper] periodic sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic sweep. Safe to call when not started. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
