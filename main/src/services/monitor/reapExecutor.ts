/**
 * Reap executor — performs a CONFIRMED manifest's target list (never the raw
 * request; `MonitorReapService.execute` has already validated the id, TTL and
 * target-set identity before calling in here).
 *
 * Process targets: the kill ladder is NOT reimplemented. `killTree`
 * (utils/platformProcess.ts) already owns SIGTERM → group TERM → SIGKILL →
 * verification; this module parameterizes it (a 5s grace window) and turns what it
 * reports into a caller-visible result: any pid still alive after the KILL step
 * (a descendant reported by the ladder's verification pass, or the root itself)
 * comes back as `kind: 'survived'` with `survivorPids`, which the router lifts
 * into the response's `errors` array. A survivor can never read as success.
 *
 * Worktree targets: brokers rooted in the worktree are reaped through
 * `CodexBrokerReaper.reapForWorktree` as part of the same target's teardown, then
 * the injected `pruneWorktree` runs. Process targets are all handled first, so
 * anything running inside a worktree is dead before its directory is touched.
 */
import { collectDescendantPidsAsync, killTree } from '../../utils/platformProcess';
import {
  reapTargetKey,
  type ReapExecutionResult,
  type ReapExecutor,
  type ReapManifest,
  type ReapProcessTarget,
  type ReapWorktreeTarget,
} from '../../orchestrator/reapTypes';

/** SIGTERM → SIGKILL grace window for a reap kill (killTree's own default is 2s). */
export const REAP_KILL_GRACE_MS = 5000;

/** The kill primitive: `killTree`'s shape, injectable so tests never signal real pids. */
export type ReapKillTree = (pid: number, opts: Parameters<typeof killTree>[1]) => Promise<boolean>;

export interface ReapExecutorDeps {
  /** Defaults to the shared platform-aware `killTree`. */
  killTree?: ReapKillTree;
  /** Descendants of a pid, enumerated BEFORE the ladder starts. Defaults to the shared walker. */
  listDescendants?: (pid: number) => Promise<number[]>;
  /** Liveness probe; defaults to signal 0 (ESRCH dead, EPERM alive). */
  isPidAlive?: (pid: number) => boolean;
  /** `CodexBrokerReaper.reapForWorktree`: kills brokers (and their trees) under a worktree path. */
  reapBrokersForWorktree?: (worktreePath: string) => Promise<void>;
  /**
   * Prunes one worktree target (the worktree-removal primitive). Absent until wired:
   * worktree targets then fail visibly rather than being silently skipped.
   */
  pruneWorktree?: (
    target: ReapWorktreeTarget,
    options: { alsoDeleteBranch: boolean; projectId?: number },
  ) => Promise<ReapExecutionResult>;
  /** SIGTERM→SIGKILL grace window in ms; defaults to {@link REAP_KILL_GRACE_MS}. */
  graceMs?: number;
  /** This app's own pid, which must never be a kill target. Defaults to `process.pid`. */
  selfPid?: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ReapExecutorImpl implements ReapExecutor {
  private readonly killTreeFn: ReapKillTree;
  private readonly listDescendants: (pid: number) => Promise<number[]>;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly graceMs: number;
  private readonly selfPid: number;

  constructor(private readonly deps: ReapExecutorDeps = {}) {
    this.killTreeFn = deps.killTree ?? killTree;
    this.listDescendants = deps.listDescendants ?? ((pid) => collectDescendantPidsAsync(pid));
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.graceMs = deps.graceMs ?? REAP_KILL_GRACE_MS;
    this.selfPid = deps.selfPid ?? process.pid;
  }

  async execute(
    manifest: ReapManifest,
    options: { alsoDeleteBranch: boolean; projectId?: number },
  ): Promise<ReapExecutionResult[]> {
    const results: ReapExecutionResult[] = [];
    // Processes first: nothing may still be running in a worktree when it is removed.
    for (const target of manifest.targets) {
      if (target.kind === 'process') results.push(await this.killProcessTarget(target));
    }
    for (const target of manifest.targets) {
      if (target.kind === 'worktree') results.push(await this.teardownWorktreeTarget(target, options));
    }
    return results;
  }

  /** Kill one process target's full descendant tree; report survivors, never swallow them. */
  async killProcessTarget(target: ReapProcessTarget): Promise<ReapExecutionResult> {
    const targetId = reapTargetKey(target);
    const { pid } = target;
    // pid 0/1 or our own process would take down far more than a stale child.
    if (!Number.isInteger(pid) || pid <= 1 || pid === this.selfPid) {
      return { targetId, kind: 'failed', error: `Refusing to kill protected pid ${pid}` };
    }
    try {
      if (!this.isPidAlive(pid)) return { targetId, kind: 'skipped' };

      // Enumerated up front so children orphaned mid-ladder are still reached.
      const descendantPids = await this.listDescendants(pid);
      const reported: number[] = [];
      const ladderErrors: string[] = [];
      const ladderOk = await this.killTreeFn(pid, {
        descendantPids,
        graceMs: this.graceMs,
        // The pid is not necessarily a process-group leader, so never resolve (and
        // signal) its real group: 'root' only targets `-<pid>`, a harmless ESRCH
        // when it leads no group. Descendants get TERM individually, then KILL.
        posixGroupMode: 'root',
        posixTermDescendants: true,
        isPidAlive: this.isPidAlive,
        onSurvivors: (remaining) => {
          reported.push(...remaining);
        },
        onError: (error) => {
          ladderErrors.push(errorMessage(error));
        },
      });

      // killTree's verification walks the CURRENT parent tree, so a child orphaned
      // when its parent exited drops out of that walk. Every pid captured before the
      // ladder (and the root) is therefore re-probed here.
      const survivors = new Set<number>(reported);
      for (const candidate of [pid, ...descendantPids]) {
        if (candidate !== this.selfPid && this.isPidAlive(candidate)) survivors.add(candidate);
      }
      if (survivors.size > 0) {
        return { targetId, kind: 'survived', survivorPids: [...survivors].sort((a, b) => a - b) };
      }
      // `false` with nothing left alive means the ladder itself broke (it returns
      // false on an internal error): the outcome is unverified, never a success.
      if (!ladderOk) {
        const detail = ladderErrors.length > 0 ? `: ${ladderErrors.join('; ')}` : '';
        return { targetId, kind: 'failed', error: `Kill ladder did not complete cleanly${detail}` };
      }
      return { targetId, kind: 'killed' };
    } catch (err) {
      return { targetId, kind: 'failed', error: errorMessage(err) };
    }
  }

  private async teardownWorktreeTarget(
    target: ReapWorktreeTarget,
    options: { alsoDeleteBranch: boolean; projectId?: number },
  ): Promise<ReapExecutionResult> {
    const targetId = reapTargetKey(target);
    const prune = this.deps.pruneWorktree;
    if (!prune) {
      return { targetId, kind: 'failed', error: 'Worktree pruning is not available yet.' };
    }
    try {
      // Brokers rooted here die as part of this target's teardown, before its directory goes.
      await this.deps.reapBrokersForWorktree?.(target.path);
      return await prune(target, options);
    } catch (err) {
      return { targetId, kind: 'failed', error: errorMessage(err) };
    }
  }
}
