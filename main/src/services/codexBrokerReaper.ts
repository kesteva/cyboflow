/**
 * CodexBrokerReaper — the main-process lifecycle owner for the DETACHED Codex
 * "app-server broker" daemons the Claude Code `openai-codex` plugin starts when a
 * session running inside a cyboflow worktree invokes Codex (codex-rescue /
 * adversarial-review).
 *
 * WHY THIS LEAKS. The plugin spawns the broker `detached: true` + `child.unref()`
 * (its own process group, reparents to launchd → ppid=1). It is a persistent
 * daemon: it has NO idle TTL and NO cwd-existence check, and only exits on an
 * explicit `broker/shutdown` RPC or SIGTERM/SIGINT. Its ONLY intended reaper is
 * the plugin's own `SessionEnd` hook — which never fires under cyboflow, because
 * cyboflow tears runs down by HARD-killing the Claude process (SDK close /
 * `killProcessTree` SIGKILL), not a graceful session end. And because the broker
 * has detached out of the Claude process's tree, cyboflow's process-group +
 * descendant-walk kill can't reach it either. Result: one orphaned broker →
 * `codex` helper → `node_repl` worker tree leaks per worktree that ever used
 * Codex, surviving dismiss/merge indefinitely.
 *
 * This service reaps them at the three seams the main process owns:
 *   1. worktree removal ({@link reapForWorktree}, wired into WorktreeManager) —
 *      the chokepoint every dismiss/merge/delete path funnels through;
 *   2. boot ({@link sweepOrphans}) — brokers whose `--cwd` no longer exists on
 *      disk, left behind by a prior session or a crash; and
 *   3. boot ({@link sweepForWorktreeRoots}) — brokers under one of THIS install's
 *      worktree roots. Covers the case neither of the above can: a worktree that
 *      still exists and was never removed, whose session ended days ago. Boot-only
 *      and root-scoped by design — see that method's docstring for why an
 *      age/idle-based sweep is not possible here and would be unsafe.
 *
 * These are the plugin's broker daemons, NOT cyboflow's own Codex SDK runtime
 * (CodexManager) nor the ui-prototype `http.server` (PrototypeServerReaper) — both
 * of those are matched by different markers and left untouched here.
 *
 * Matching strategy (mirrors PrototypeServerReaper, deliberately): list processes
 * via `ps -axo pid=,ppid=,command=` and do plain JS substring/parse on the command
 * line — we require the literal `app-server-broker.mjs` marker AND parse the broker's
 * `--cwd <path>` arg. No `pkill -f <regex>` with a raw absolute path (which can carry
 * regex metacharacters and mis-escape). The broker's detached `codex`/`node_repl`
 * descendants carry no `--cwd`, so they are collected by walking the ppid table from
 * each matched broker. Every path is fail-soft: a `ps` failure or a per-PID kill
 * failure is logged and swallowed, never thrown — reaping must never block
 * close-out or boot.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { LoggerLike } from '../orchestrator/types';

/** A single process row parsed from `ps` output. */
export interface CodexBrokerProcess {
  pid: number;
  ppid: number;
  command: string;
}

/** Construction-time seams — the real `ps`/`process.kill`/`fs` impls are the defaults. */
export interface CodexBrokerReaperOptions {
  /** List host processes. Defaults to `ps -axo pid=,ppid=,command=`. */
  listProcesses?: () => Promise<CodexBrokerProcess[]>;
  /** Kill one PID (SIGTERM). Defaults to `process.kill(pid, 'SIGTERM')`. */
  killPid?: (pid: number) => void;
  /** Does a path exist on disk? Defaults to `fs.existsSync`. */
  pathExists?: (path: string) => boolean;
  /** Optional structured logger (warn on kills, debug on misses/skips). */
  logger?: LoggerLike;
}

/** The literal marker every Codex broker's command line carries. */
const BROKER_MARKER = 'app-server-broker.mjs';

/** Strip trailing path separators; returns '' for empty/whitespace/undefined input. */
function trimDir(dir: string | undefined): string {
  if (!dir) return '';
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/\/+$/, '');
}

/**
 * Extract the `--cwd <path>` value from a Codex broker command line. Returns null
 * when the line is not a broker (no marker) or carries no `--cwd`. cyboflow
 * worktree paths never contain spaces (generated names), so `\S+` is a safe token.
 */
export function parseBrokerCwd(command: string): string | null {
  if (!command.includes(BROKER_MARKER)) return null;
  const match = /--cwd\s+(\S+)/.exec(command);
  return match ? match[1] : null;
}

/**
 * Parse `ps -axo pid=,ppid=,command=` output into rows. Each line is leading
 * whitespace + numeric pid + whitespace + numeric ppid + a space + the full
 * command line. Lines that do not match are skipped.
 */
export function parsePsOutput(stdout: string): CodexBrokerProcess[] {
  const rows: CodexBrokerProcess[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, command: match[3] });
  }
  return rows;
}

/**
 * Collect `rootPids` plus every descendant, walking the ppid table. Guards:
 * pids ≤ 1 are never traversed or included (never chase launchd/kernel), a pid is
 * only ever visited once (cycle-safe), and a root not present in `procs` is still
 * returned (a broker whose children already exited). Returns a de-duplicated set.
 */
export function collectProcessTree(
  rootPids: number[],
  procs: CodexBrokerProcess[],
): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid <= 1) continue;
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByPpid.set(p.ppid, [p.pid]);
  }

  const result = new Set<number>();
  const queue: number[] = [];
  for (const root of rootPids) {
    if (root > 1 && !result.has(root)) {
      result.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = childrenByPpid.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid > 1 && !result.has(kid)) {
        result.add(kid);
        queue.push(kid);
      }
    }
  }
  return result;
}

/** Default process lister: `ps -axo pid=,ppid=,command=` (no header, all processes). */
function defaultListProcesses(): Promise<CodexBrokerProcess[]> {
  return new Promise<CodexBrokerProcess[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table.
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parsePsOutput(stdout));
      },
    );
  });
}

/** Default killer: SIGTERM the PID. May throw (dead/reparented PID) — caller guards. */
function defaultKillPid(pid: number): void {
  process.kill(pid, 'SIGTERM');
}

export class CodexBrokerReaper {
  private readonly listProcesses: () => Promise<CodexBrokerProcess[]>;
  private readonly killPid: (pid: number) => void;
  private readonly pathExists: (path: string) => boolean;
  private readonly logger?: LoggerLike;

  constructor(opts: CodexBrokerReaperOptions = {}) {
    this.listProcesses = opts.listProcesses ?? defaultListProcesses;
    this.killPid = opts.killPid ?? defaultKillPid;
    this.pathExists = opts.pathExists ?? existsSync;
    this.logger = opts.logger;
  }

  /**
   * Kill every Codex broker whose `--cwd` is AT or UNDER `worktreePath`, plus each
   * broker's detached descendant tree (`codex` helper + `node_repl` workers).
   * Called from WorktreeManager on every worktree removal (dismiss / merge /
   * delete). Fail-soft, and a no-op for an empty/undefined `worktreePath` (matching
   * on '' would kill EVERY broker).
   */
  async reapForWorktree(worktreePath: string): Promise<void> {
    const base = trimDir(worktreePath);
    if (base.length === 0) {
      this.logger?.debug('[CodexBrokerReaper] empty worktreePath — skipping reap');
      return;
    }
    await this.killBrokerTrees(
      (cwd) => {
        const c = trimDir(cwd);
        return c === base || c.startsWith(base + '/');
      },
      'reapForWorktree',
      base,
    );
  }

  /**
   * Kill every Codex broker whose `--cwd` is AT or UNDER one of `worktreeRoots`,
   * plus each broker's descendant tree.
   *
   * BOOT ONLY — this is deliberately NOT safe to call mid-session. It closes the
   * gap {@link sweepOrphans} structurally cannot: a broker in a worktree that
   * STILL EXISTS. Such a broker has a live cwd (so the orphan sweep spares it) and
   * its worktree was never removed (so {@link reapForWorktree} never fired), yet
   * the session that spawned it ended long ago — the broker has no idle TTL, so it
   * lives forever. Observed in the wild: three cyboflow worktrees holding brokers
   * idle for 2+ days, one having accumulated 7 `node_repl` + MCP worker pairs.
   *
   * WHY BOOT IS THE SAFE MOMENT, AND WHY THIS IS ROOT-SCOPED RATHER THAN AGE-BASED.
   * There is no idle signal to test: the broker's `broker.log` is 0 bytes with an
   * mtime frozen at spawn, and its socket/pid files are removed on shutdown, so
   * their presence means "alive", not "recently used". An age-based sweep would
   * therefore have to guess — and would be actively harmful, because brokers for
   * OTHER tools' worktrees (a Warp or plain-terminal Claude session) are
   * indistinguishable by age and may be mid-turn. Restricting to cyboflow's own
   * worktree roots removes the guess entirely: at boot no cyboflow session is yet
   * running, so any broker under a cyboflow worktree root is by construction a
   * leftover from a previous app lifetime, and third-party brokers live outside
   * those roots and are never matched.
   *
   * A blank/whitespace root is dropped (matching '' would match EVERY broker); if
   * that leaves no roots this is a no-op. Fail-soft throughout.
   */
  async sweepForWorktreeRoots(worktreeRoots: string[]): Promise<void> {
    const bases = worktreeRoots.map(trimDir).filter((root) => root.length > 0);
    if (bases.length === 0) {
      this.logger?.debug('[CodexBrokerReaper] no worktree roots — skipping sweep');
      return;
    }
    await this.killBrokerTrees(
      (cwd) => {
        const c = trimDir(cwd);
        // Unlike sweepOrphans, an unparseable cwd is NOT treated as a match here:
        // this sweep's whole safety property is "provably under a cyboflow root".
        if (c.length === 0) return false;
        return bases.some((base) => c === base || c.startsWith(base + '/'));
      },
      'sweepForWorktreeRoots',
      bases.join(', '),
    );
  }

  /**
   * Kill every Codex broker whose `--cwd` no longer exists on disk, plus each
   * broker's descendant tree. Used at boot to clear orphans a prior session or a
   * crash left behind. A broker for a still-live worktree is spared automatically
   * (its cwd exists) — see {@link sweepForWorktreeRoots} for the companion sweep
   * that covers those. Fail-soft.
   */
  async sweepOrphans(): Promise<void> {
    await this.killBrokerTrees(
      (cwd) => {
        const c = trimDir(cwd);
        // Defensive: an unparseable/empty cwd is treated as an orphan (a broker
        // with no resolvable working dir can never be a live worktree's).
        return c.length === 0 || !this.pathExists(c);
      },
      'sweepOrphans',
      '<orphan cwd>',
    );
  }

  /**
   * Shared core: list processes, select brokers whose parsed `--cwd` satisfies
   * `matchesCwd`, expand each to its full process tree, and SIGTERM every pid
   * fail-soft (a dead/reparented PID or a throwing kill for one process never
   * aborts the loop). A `ps` failure logs and returns — never throws out of the
   * reaper.
   */
  private async killBrokerTrees(
    matchesCwd: (cwd: string) => boolean,
    context: string,
    target: string,
  ): Promise<void> {
    let processes: CodexBrokerProcess[];
    try {
      processes = await this.listProcesses();
    } catch (err) {
      this.logger?.error('[CodexBrokerReaper] listing processes failed — skipping', {
        context,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const rootPids: number[] = [];
    for (const proc of processes) {
      const cwd = parseBrokerCwd(proc.command);
      if (cwd === null) continue;
      if (matchesCwd(cwd)) rootPids.push(proc.pid);
    }

    if (rootPids.length === 0) {
      this.logger?.debug('[CodexBrokerReaper] no matching Codex brokers', { context, target });
      return;
    }

    const tree = collectProcessTree(rootPids, processes);
    let killed = 0;
    for (const pid of tree) {
      try {
        this.killPid(pid);
        killed += 1;
      } catch (err) {
        // A dead / reparented / permission-denied PID must not abort the loop.
        this.logger?.debug('[CodexBrokerReaper] kill failed (already gone?) — continuing', {
          context,
          pid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.logger?.warn('[CodexBrokerReaper] reaped leaked Codex broker tree(s)', {
      context,
      target,
      brokers: rootPids.length,
      processesKilled: killed,
    });
  }
}
