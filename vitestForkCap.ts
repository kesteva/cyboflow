/**
 * Gate-run-time resolution of the vitest fork-pool size, shared by
 * `main/vitest.config.ts` and `frontend/vitest.config.ts`.
 *
 * The policy lives in `shared/types/testConcurrency.ts`; this module supplies the
 * only impure inputs — how many vitest gates are running on this machine RIGHT
 * NOW, and how many ABANDONED pool workers are still holding cores — and is the
 * reason the cap is computed here rather than baked into the agent environment at
 * spawn time. See that module's header for the full why.
 *
 * ORPHANED WORKERS. A fork whose root was hard-killed keeps running (macOS has no
 * PDEATHSIG; see `vitestOrphanWatchdog.ts`). Such a fork is titled
 * `node (vitest N)`, NOT `node (vitest)` — so the gate count this module has
 * always produced skipped it entirely, and a runaway fork pinning a core
 * contributed nothing to the concurrency the cap divides by. That is the exact
 * blind spot that let two orphans pin two cores and ~2 GB for 24 minutes while the
 * next gate sized its pool as though the box were idle. They are now both REAPED
 * (when policy allows) and, for any that survive, COUNTED as cores this run does
 * not have.
 *
 * Every path is fail-soft: if `ps` is unavailable (Windows, a locked-down CI
 * image, a sandbox), we report a single gate and no orphans, which resolves to
 * vitest's normal parallelism — never an error and never a hang. A kill that
 * throws is swallowed the same way.
 */
import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

import {
  isOrphanedWorker,
  isVitestRootTitle,
  resolveForkCap,
  shouldReapOrphans,
} from './shared/types/testConcurrency';

export type ListProcessLines = () => string;

/**
 * `ps -Ao pid=,ppid=,command=` — pid and ppid alongside the command, with no
 * header. The ppid is what makes an orphan provable, and the pid is what lets us
 * reap it.
 */
const defaultListProcessLines: ListProcessLines = () =>
  execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
    // The full process table with command lines; comfortably oversized.
    maxBuffer: 16 * 1024 * 1024,
  });

/** What one scan of the process table tells us about vitest on this box. */
export interface VitestProcessScan {
  /**
   * Vitest roots running right now, INCLUDING this one. At least 1 — vitest may
   * not have titled itself yet when the config is evaluated, and undercounting by
   * one is the safe direction (a slightly larger pool, never a divide-by-zero).
   */
  gates: number;
  /** PIDs of pool workers whose root has died (ppid === 1). */
  orphanPids: number[];
}

/**
 * Parse `ps -Ao pid=,ppid=,command=` into the two facts the cap needs. Lines that
 * do not parse are skipped rather than throwing — `ps` output is not a contract.
 */
export function scanVitestProcesses(
  listProcessLines: ListProcessLines = defaultListProcessLines,
): VitestProcessScan {
  try {
    let gates = 0;
    const orphanPids: number[] = [];
    for (const rawLine of listProcessLines().split('\n')) {
      const line = rawLine.replace(/^\s+/, '');
      if (line.length === 0) continue;
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      const title = match[3].trim();
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (isVitestRootTitle(title)) gates += 1;
      else if (isOrphanedWorker(title, ppid)) orphanPids.push(pid);
    }
    return { gates: Math.max(1, gates), orphanPids };
  } catch {
    return { gates: 1, orphanPids: [] };
  }
}

/**
 * SIGKILL every pid in `pids`, returning how many kills were accepted.
 *
 * SIGKILL rather than the SIGTERM `CodexBrokerReaper` uses, deliberately: an
 * orphaned worker has no cleanup worth running (nothing will read its results),
 * and it is by definition mid-test — possibly inside a tight loop or a signal
 * handler installed by the test file itself — so a catchable signal is not
 * reliably fatal. There is a narrow TOCTOU window between the `ps` above and this
 * kill in which the pid could be recycled; it is the same exposure every
 * ps-then-kill reaper in this repo carries, and is kept small by killing
 * immediately after the scan.
 */
export function reapOrphans(
  pids: number[],
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGKILL'),
): number {
  let reaped = 0;
  for (const pid of pids) {
    try {
      kill(pid);
      reaped += 1;
    } catch {
      // Already gone, or not ours to kill. Never abort the loop — a surviving
      // orphan is counted against the cap below instead.
    }
  }
  return reaped;
}

/**
 * Vitest <= 3 titled its root `node (vitest)`; vitest 4 sets no title. The gate
 * counter ({@link scanVitestProcesses}) and the orphan reaper tell a root from a
 * worker by title, so the config (evaluated in the root process) applies it. Call
 * from every vitest config.
 */
export function titleVitestRoot(): void {
  try {
    process.title = 'node (vitest)';
  } catch {
    // Cosmetic outside the title-keyed scan; never fail config load over it.
  }
}

/**
 * The `pool`/`maxWorkers` slice (vitest 4 flattened `poolOptions.forks.maxForks`) to spread into a vitest `test` config. Empty
 * when no cap applies, so an unmanaged run keeps vitest's own pool defaults
 * untouched rather than being pinned to `forks`.
 *
 * Orphan reaping happens here, before the cap is resolved, because this is the
 * one moment every gate passes through. Whether it reaps is
 * {@link shouldReapOrphans}'s call: agent-spawned gates self-clean, a human's
 * terminal gate does not kill processes it did not start unless
 * `CYBOFLOW_TEST_REAP_ORPHANS=1` says so. Whatever survives is subtracted from
 * the cores the cap divides up.
 */
export function forkPoolOptions(
  env: NodeJS.ProcessEnv = process.env,
  listProcessLines: ListProcessLines = defaultListProcessLines,
  kill?: (pid: number) => void,
):
  | Record<string, never>
  | { pool: 'forks'; maxWorkers: number } {
  // Before the scan, so this root counts itself exactly as it did under vitest 2.
  titleVitestRoot();
  const scan = scanVitestProcesses(listProcessLines);

  let survivingOrphans = scan.orphanPids.length;
  if (survivingOrphans > 0 && shouldReapOrphans(env.CYBOFLOW_TEST_REAP_ORPHANS, env.CYBOFLOW_MANAGED_TEST_CONCURRENCY)) {
    const reaped = reapOrphans(scan.orphanPids, kill);
    survivingOrphans -= reaped;
    if (reaped > 0) {
      process.stderr.write(
        `[vitest] reaped ${reaped} orphaned pool worker(s) left by a dead gate\n`,
      );
    }
  }

  const maxForks = resolveForkCap({
    explicit: env.CYBOFLOW_TEST_MAX_FORKS,
    managed: env.CYBOFLOW_MANAGED_TEST_CONCURRENCY,
    cores: availableParallelism(),
    concurrentGates: scan.gates,
    orphanWorkers: survivingOrphans,
  });
  if (maxForks === undefined) return {};
  return { pool: 'forks', maxWorkers: maxForks };
}
