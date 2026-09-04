/**
 * platformProcess — the ONE place that answers "how do I list, enumerate or
 * kill processes on this platform".
 *
 * Call sites may read the host platform to choose their {@link KillTreeOptions}
 * timings, modes and log wording. The kill and enumeration commands themselves
 * may not branch. The single exception is runCommandManager's escapee sweep,
 * where POSIX has a process-group lookup Windows has no equivalent for.
 *
 * Every primitive takes a `platform` option so tests pin a platform regardless
 * of the host, and the per-site reporting — zombie events, log lines — stays at
 * the call sites through the option hooks.
 */
import { exec, execFile, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import {
  collectDescendantPids as walkPidPpidTable,
  parseProcessTable,
  parsePsOutput,
  type ProcessRow,
  type ProcessTableRow,
} from '../services/processTable';
import { buildWindowsProcessTableScript, execWindowsProcessTable } from '../services/winProcessTable';

/** Test seam shared by every primitive here: which platform's code path runs. */
export interface PlatformProcessOptions {
  /** Defaults to the host platform. */
  platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Enumeration — the process-table listings
// ---------------------------------------------------------------------------

/**
 * Default process lister. The win32 PowerShell stand-in emits the same line
 * shape as `ps`, so one parser serves both.
 */
export function listProcessTable(opts: PlatformProcessOptions = {}): Promise<ProcessRow[]> {
  if ((opts.platform ?? process.platform) === 'win32') {
    return execWindowsProcessTable('pid-ppid-command').then(parsePsOutput);
  }
  return new Promise<ProcessRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table. The other listings below use the same budget.
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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

/** Default two-column lister: `ps -axo pid=,ppid=` (no header, all processes). */
export function listPidPpidTable(opts: PlatformProcessOptions = {}): Promise<ProcessTableRow[]> {
  if ((opts.platform ?? process.platform) === 'win32') {
    return execWindowsProcessTable('pid-ppid').then(parseProcessTable);
  }
  return new Promise<ProcessTableRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid='],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parseProcessTable(stdout));
      },
    );
  });
}

/** {@link listPidPpidTable} for callers that cannot await. */
export function listPidPpidTableSync(opts: PlatformProcessOptions = {}): ProcessTableRow[] {
  if ((opts.platform ?? process.platform) === 'win32') {
    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "${buildWindowsProcessTableScript('pid-ppid')}"`,
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return parseProcessTable(output);
  }
  return parseProcessTable(execSync('ps -axo pid=,ppid=', { encoding: 'utf8', windowsHide: true }));
}

// ---------------------------------------------------------------------------
// Enumeration — the descendant-tree walker
// ---------------------------------------------------------------------------

export interface CollectDescendantPidsOptions extends PlatformProcessOptions {
  /**
   * POSIX one-level child lister. Sites differ — `pgrep -P N` is portable
   * across macOS/BSD/Linux where GNU `ps --ppid` is not — so a site whose walk
   * must stay byte-identical injects its own. The win32 arm never varies.
   */
  posixChildPids?: (parentPid: number) => number[];
  /** Reporter for a failed fetch or walk step; the walk degrades, never throws. */
  onWalkError?: (error: unknown) => void;
}

/**
 * Default POSIX one-level lister. The `2>/dev/null || true` suffix keeps a
 * "no such process" race from throwing; the recursion just ends.
 */
function defaultPosixChildPids(parentPid: number): number[] {
  const output = execSync(`ps -o pid= --ppid ${parentPid} 2>/dev/null || true`, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output
    .split('\n')
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid !== parentPid);
}

/**
 * {@link collectDescendantPidsAsync}, synchronously. Production kill paths use
 * the async one: this blocks the calling thread on the process-table query.
 * Kept for callers that cannot await, and as an independent enumeration in
 * tests. Same contracts — cycle-safe, never includes the root or pid <= 1, and
 * fail-soft through `onWalkError`.
 */
export function collectDescendantPids(rootPid: number, opts: CollectDescendantPidsOptions = {}): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  if ((opts.platform ?? process.platform) === 'win32') {
    try {
      return walkPidPpidTable(rootPid, listPidPpidTableSync({ platform: 'win32' }));
    } catch (error) {
      opts.onWalkError?.(error);
      return [];
    }
  }

  const listChildren = opts.posixChildPids ?? defaultPosixChildPids;
  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  const walk = (pid: number): void => {
    let children: number[];
    try {
      children = listChildren(pid);
    } catch (error) {
      opts.onWalkError?.(error);
      return;
    }
    for (const child of children) {
      // pid<=1 is never traversed (launchd/kernel reparent guard, mirroring
      // the shared table walk); `seen` both dedupes and terminates cycles.
      if (child <= 1 || seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return descendants;
}

/**
 * Async POSIX one-level lister. Same command and the same fail-soft
 * `2>/dev/null || true` suffix as the synchronous default.
 */
async function defaultPosixChildPidsAsync(parentPid: number): Promise<number[]> {
  const { stdout } = await promisify(exec)(`ps -o pid= --ppid ${parentPid} 2>/dev/null || true`, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(stdout)
    .split('\n')
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid !== parentPid);
}

export interface CollectDescendantPidsAsyncOptions extends PlatformProcessOptions {
  /** As {@link CollectDescendantPidsOptions.posixChildPids}, async allowed. */
  posixChildPids?: (parentPid: number) => number[] | Promise<number[]>;
  /** As {@link CollectDescendantPidsOptions.onWalkError}. */
  onWalkError?: (error: unknown) => void;
}

/**
 * {@link collectDescendantPids} without blocking the calling thread.
 *
 * Prefer this everywhere a caller can await. The synchronous twin runs the
 * win32 (pid, ppid) query through execSync, which stalls the Electron main
 * thread — and with it the renderer bridge — for as long as PowerShell takes
 * to start, or for the whole 15s timeout if the query itself hangs.
 */
export async function collectDescendantPidsAsync(
  rootPid: number,
  opts: CollectDescendantPidsAsyncOptions = {},
): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  if ((opts.platform ?? process.platform) === 'win32') {
    try {
      return walkPidPpidTable(rootPid, await listPidPpidTable({ platform: 'win32' }));
    } catch (error) {
      opts.onWalkError?.(error);
      return [];
    }
  }

  const listChildren = opts.posixChildPids ?? defaultPosixChildPidsAsync;
  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  const walk = async (pid: number): Promise<void> => {
    let children: number[];
    try {
      children = await listChildren(pid);
    } catch (error) {
      opts.onWalkError?.(error);
      return;
    }
    for (const child of children) {
      if (child <= 1 || seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      await walk(child);
    }
  };
  await walk(rootPid);
  return descendants;
}

// ---------------------------------------------------------------------------
// Kill primitives
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget `taskkill /PID <pid> /T /F`. Windows has no process-group
 * semantics through `process.kill` — a negative pid fails EINVAL — so taskkill
 * walks the PPID chain instead. An already-dead or denied pid is ignored.
 */
export function killWindowsTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
    // Already dead / no permission — nothing left to reap here.
  });
}

/**
 * {@link killWindowsTree}, blocking until the kill was ISSUED — for a caller
 * that continues straight into bookkeeping assuming the tree is going away.
 * A no-op off win32, where callers signal process groups directly.
 */
export function killPidSync(pid: number, opts: PlatformProcessOptions = {}): void {
  if ((opts.platform ?? process.platform) !== 'win32') return;
  spawnSync('taskkill', ['/pid', String(Math.abs(pid)), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  });
}

/**
 * What {@link signalTree} managed to do, so the caller can decide whether its
 * own fallback still applies.
 *
 *  - 'signaled': the tree was signalled.
 *  - 'gone':     nothing there to signal (POSIX ESRCH).
 *  - 'failed':   the group signal was rejected for another reason.
 */
export type SignalTreeOutcome = 'signaled' | 'gone' | 'failed';

/**
 * Force-kill each pid outright, one command per pid, best effort: win32
 * `taskkill /PID <pid> /F`, POSIX `kill -9 <pid>`. No tree walk and no grace —
 * for a caller that has already decided exactly which processes must die.
 */
export async function forceKillPids(
  pids: number[],
  opts: PlatformProcessOptions & {
    /** Shell runner. Defaults to `exec` wrapped with `windowsHide: true`. */
    execCommand?: (command: string) => Promise<{ stdout: string }>;
    /** Called after each kill command that did not throw. */
    onKilled?: (pid: number) => void;
  } = {},
): Promise<void> {
  const win32 = (opts.platform ?? process.platform) === 'win32';
  const execCommand =
    opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));
  for (const pid of pids) {
    try {
      await execCommand(win32 ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`);
      opts.onKilled?.(pid);
    } catch (error) {
      // Already dead / no permission — the sweep is best effort by contract.
    }
  }
}

/**
 * A short name per pid, for a survivor report. Windows has no `ps`, so the
 * shared process table supplies the command line and its first token's
 * basename stands in. An unresolvable pid reports 'unknown'; never throws.
 */
export async function describeProcesses(
  pids: number[],
  opts: PlatformProcessOptions & {
    execCommand?: (command: string) => Promise<{ stdout: string }>;
    onError?: (error: unknown) => void;
  } = {},
): Promise<{ pid: number; name: string }[]> {
  const platform = opts.platform ?? process.platform;
  const execCommand =
    opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));

  if (platform === 'win32') {
    try {
      const rows = await listProcessTable({ platform });
      const commandByPid = new Map(rows.map(row => [row.pid, row.command]));
      return pids.map((pid) => {
        const firstToken = (commandByPid.get(pid) ?? '').trim().split(/\s+/)[0] ?? '';
        return { pid, name: firstToken ? basename(firstToken) : 'unknown' };
      });
    } catch (error) {
      opts.onError?.(error);
      return pids.map(pid => ({ pid, name: 'unknown' }));
    }
  }

  const described: { pid: number; name: string }[] = [];
  for (const pid of pids) {
    try {
      const { stdout } = await execCommand(`ps -p ${pid} -o comm= 2>/dev/null || true`);
      described.push({ pid, name: String(stdout).trim() || 'unknown' });
    } catch (error) {
      described.push({ pid, name: 'unknown' });
    }
  }
  return described;
}

/**
 * Signal a process TREE: the POSIX process group by negative pid, or
 * `taskkill /T /F` on Windows, which has no group semantics through
 * `process.kill`. taskkill delivers no signal, so `signal` is POSIX-only.
 */
export function signalTree(
  pid: number,
  signal: NodeJS.Signals,
  opts: PlatformProcessOptions & {
    /** 'sync' blocks until the kill was ISSUED; 'async' (default) does not. */
    windowsKill?: 'async' | 'sync';
    /**
     * win32 tree killer. Defaults to the taskkill primitives above; injected
     * by tests, which must never fire a real taskkill at an arbitrary pid.
     */
    killWindows?: (pid: number) => void;
    /** Signal sender for the POSIX arm. Defaults to `process.kill`. */
    sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): SignalTreeOutcome {
  if ((opts.platform ?? process.platform) === 'win32') {
    const killWindows =
      opts.killWindows ??
      (opts.windowsKill === 'sync'
        ? (target: number) => killPidSync(target, { platform: 'win32' })
        : killWindowsTree);
    killWindows(pid);
    return 'signaled';
  }
  const sendSignal = opts.sendSignal ?? ((target: number, sig: NodeJS.Signals) => process.kill(target, sig));
  try {
    sendSignal(-pid, signal);
    return 'signaled';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed';
  }
}

/**
 * Where the ladder's progress and failures go. It emits plain sentences; the
 * site adds its own identity — a `[toolName]` prefix, a session log line.
 * Without one, failures fall back to the console.
 */
export interface KillTreeLogger {
  /** A step worth showing: grace started, escalation, a signal delivered. */
  info?(message: string): void;
  /** A step that did not work. The ladder continues regardless. */
  warn?(message: string, error?: unknown): void;
}

export interface KillTreeOptions extends PlatformProcessOptions {
  /**
   * Descendants enumerated BEFORE the ladder starts, so children orphaned
   * mid-ladder are still reached. Defaults to enumerating here.
   */
  descendantPids?: number[];
  /** Shell runner. Defaults to `exec` with `windowsHide`: no conhost flash. */
  execCommand?: (command: string) => Promise<{ stdout: string }>;
  /**
   * Liveness probe; defaults to signal 0 (ESRCH dead, EPERM alive). A probe
   * that throws counts as alive, so a grace poll waits rather than escalating.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Signal sender for the POSIX ladder. Defaults to `process.kill`. Unused on
   * win32 (no catchable signals — the ladder is entirely taskkill).
   */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Grace window after the graceful phase, in ms. Default 2000. */
  graceMs?: number;
  /** Poll interval while waiting out the grace window. Default 100ms. */
  pollIntervalMs?: number;
  /** 'poll' (default) returns once the root is dead; 'fixed' sleeps it out. */
  graceMode?: 'poll' | 'fixed';
  /**
   * POSIX process-group resolution (win32 ignores this — no groups there):
   *  - 'lookup' (default, terminalSessionManager's shape): after the SIGTERM,
   *    one `ps -o pgid=` lookup replaces the root-pid stand-in with the real
   *    pgid when it responds.
   *  - 'root' (AbstractCliManager / sessionManager): no lookup — the pty/spawned
   *    child is its own group leader, so the root pid IS the group id.
   *  - 'enumerate' (runCommandManager): BEFORE any signal, resolve the real
   *    pgid and sweep group members the up-front tree walk missed into the
   *    per-descendant kill list.
   */
  posixGroupMode?: 'lookup' | 'root' | 'enumerate';
  /** Re-enumeration for the verification passes; async allowed. */
  listDescendants?: () => number[] | Promise<number[]>;
  /**
   * Awaited with the pids left after the whole ladder ran, just before
   * killTree resolves false. What that emits is the site's choice.
   */
  onSurvivors?: (remainingPids: number[]) => void | Promise<void>;
  /** Called when the graceful `taskkill /T` attempt fails (expected for console apps). */
  onGracefulError?: (error: unknown) => void;
  /**
   * Progress and failure reporting for the ladder itself. See
   * {@link KillTreeLogger}; defaults to the console.
   */
  logger?: KillTreeLogger;
  /** Called when the ladder itself throws unexpectedly. Defaults to console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Default liveness probe: signal-0 `process.kill`. ESRCH means dead; EPERM
 * ("exists, no permission to signal") still counts as alive.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill a process and its whole tree. Returns true when nothing survives the
 * ladder, false when survivors remain (after {@link KillTreeOptions.onSurvivors}
 * ran) or the ladder threw. The inline steps below own the detail; the shape:
 *
 * win32 — the taskkill ladder shared by runCommandManager,
 * AbstractCliManager and terminalSessionManager: graceful `/T`, the grace
 * window, `/T /F`, per-descendant `/F`, then a verification pass with a
 * survivors re-kill.
 *
 * POSIX — the SIGTERM → process-group ladder: SIGTERM the root, group
 * handling per {@link KillTreeOptions.posixGroupMode}, `kill -TERM -<pgid>`,
 * the grace window in {@link KillTreeOptions.graceMode} shape, SIGKILL the
 * root and group, every enumerated descendant, a `pkill -9 -P` sweep, then
 * the same verification pass (no survivors re-kill on POSIX).
 */
export async function killTree(pid: number, opts: KillTreeOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  // Default shell-command runner: real `exec`, wrapped with windowsHide —
  // taskkill/kill/pkill must never flash a conhost when the packaged app runs
  // windowless on Windows.
  const execCommand =
    opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));
  const graceMs = opts.graceMs ?? 2000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const fixedGrace = (opts.graceMode ?? 'poll') === 'fixed';
  const posixGroupMode = opts.posixGroupMode ?? 'lookup';
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const log = {
    info: (message: string) => opts.logger?.info?.(message),
    warn: (message: string, error?: unknown) =>
      opts.logger?.warn ? opts.logger.warn(message, error) : console.warn(message, error),
  };
  // Probe contract: a throw means "could not tell" — count as alive so a poll
  // waits out its window instead of short-circuiting to the forceful kill.
  const probeAlive = (probePid: number): boolean => {
    try {
      return isPidAlive(probePid);
    } catch {
      return true;
    }
  };
  const listDescendants = async (): Promise<number[]> =>
    (opts.listDescendants
      ? await opts.listDescendants()
      : await collectDescendantPidsAsync(pid, { platform })) ?? [];

  try {
    // Copied: the POSIX 'enumerate' group mode appends group members the tree
    // walk missed — the caller's array must not be mutated as a side effect.
    const descendantPids = [
      ...(opts.descendantPids ?? (await collectDescendantPidsAsync(pid, { platform }))),
    ];
    if (platform === 'win32') {
      // Graceful attempt first (without /F, GUI apps may close cleanly).
      try {
        await execCommand(`taskkill /PID ${pid} /T`);
      } catch (error) {
        opts.onGracefulError?.(error);
      }
      if (fixedGrace) {
        await sleep(graceMs);
      } else {
        // Bounded grace poll — return the moment the pid is gone, capped at
        // the grace window.
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (!probeAlive(pid)) break;
          await sleep(pollIntervalMs);
        }
      }
      // Forceful: /F kills the tree immediately.
      try {
        await execCommand(`taskkill /PID ${pid} /T /F`);
        log.info(`Force-killed the tree under process ${pid}`);
      } catch (error) {
        log.info(`Process ${pid} had already terminated`);
      }
      // taskkill /T walks the PPID chain at call time, so a shell that died
      // between the graceful and /F calls — or a pid that was reused in that
      // window — can orphan children the tree walk can no longer see. Force
      // every descendant enumerated up-front that is still alive.
      for (const childPid of descendantPids) {
        try {
          if (probeAlive(childPid)) {
            await execCommand(`taskkill /PID ${childPid} /F`);
          }
        } catch (error) {
          // Already dead or denied; the verification pass below decides.
        }
      }
    } else {
      const sendSignal = opts.sendSignal ?? ((signalPid: number, signal: NodeJS.Signals) => {
        process.kill(signalPid, signal);
      });
      let pgid = pid;

      if (posixGroupMode === 'enumerate') {
        // Resolve the real pgid BEFORE any signal flies, and sweep in group
        // members the tree walk could not see (workers re-parented into it).
        try {
          const result = await execCommand(`ps -o pgid= -p ${pid}`);
          const foundPgid = parseInt(result.stdout.trim());
          if (!isNaN(foundPgid)) {
            pgid = foundPgid;
            if (foundPgid !== pid) {
              const pgResult = await execCommand(`ps -o pid= -g ${foundPgid} 2>/dev/null || true`);
              const pgPids = pgResult.stdout
                .split('\n')
                .map(line => parseInt(line.trim()))
                .filter(p => !isNaN(p) && p !== pid && !descendantPids.includes(p));
              descendantPids.push(...pgPids);
            }
          }
        } catch (error) {
          log.warn('Could not resolve the process group', error);
        }
      }

      try {
        sendSignal(pid, 'SIGTERM');
      } catch (error) {
        log.warn('SIGTERM failed', error);
      }

      if (posixGroupMode === 'lookup') {
        // The root pid is only a stand-in until this lookup answers.
        try {
          const pgidResult = await execCommand(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
          const foundPgid = parseInt(pgidResult.stdout.trim());
          if (!isNaN(foundPgid)) {
            pgid = foundPgid;
          }
        } catch (error) {
          // Keep the root pid as the group id.
        }
      }

      try {
        await execCommand(`kill -TERM -${pgid}`);
      } catch (error) {
        log.warn(`Could not send SIGTERM to process group ${pgid}`, error);
      }

      if (graceMs > 0) {
        log.info(`Waiting ${graceMs}ms for graceful shutdown`);
      }
      if (fixedGrace) {
        await sleep(graceMs);
      } else {
        // Poll for early exit instead of unconditionally sleeping the full grace
        // window — return the moment both the main pid and its process group are
        // gone, bounded at the grace window, before forcing SIGKILL below.
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (!probeAlive(pid) && !probeAlive(-pgid)) {
            break;
          }
          await sleep(pollIntervalMs);
        }
      }

      // Now forcefully kill the main process
      log.info('Grace period expired, using forceful termination');
      try {
        sendSignal(pid, 'SIGKILL');
        log.info(`Sent SIGKILL to process ${pid}`);
      } catch (error) {
        log.info(`Process ${pid} had already terminated`);
      }

      // Kill the process group with SIGKILL
      try {
        await execCommand(`kill -9 -${pgid}`);
        log.info(`Sent SIGKILL to process group ${pgid}`);
      } catch (error) {
        log.warn(`Could not send SIGKILL to process group ${pgid}`, error);
      }

      // Kill all known descendants individually to be sure
      for (const childPid of descendantPids) {
        try {
          await execCommand(`kill -9 ${childPid}`);
        } catch (error) {
          // Process already terminated
        }
      }

      // Final cleanup attempt using pkill
      try {
        await execCommand(`pkill -9 -P ${pid}`);
      } catch (error) {
        // Ignore errors - processes might already be dead
      }
    }

    // Verify all processes are actually dead
    await sleep(500);
    let remainingPids = await listDescendants();
    if (platform === 'win32' && remainingPids.length > 0) {
      // Survivors found: one direct forced kill each — the tree-level kill
      // cannot see a child whose parent link it can no longer walk — then
      // re-verify. (win32-only: on POSIX the `pkill -9 -P` sweep above
      // already plays this role.)
      for (const survivorPid of remainingPids) {
        try {
          await execCommand(`taskkill /PID ${survivorPid} /F`);
        } catch (error) {
          // Already dead / no permission — the re-check below decides.
        }
      }
      await sleep(200);
      remainingPids = await listDescendants();
    }
    if (remainingPids.length > 0) {
      if (opts.onSurvivors) {
        await opts.onSurvivors(remainingPids);
      } else {
        log.warn(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
      }
      return false;
    }
    return true;
  } catch (error) {
    if (opts.onError) {
      opts.onError(error);
    } else {
      log.warn('Error in killTree', error);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Immediate hard kill — the logs-panel stop shape
// ---------------------------------------------------------------------------

export interface KillTreeImmediateOptions extends PlatformProcessOptions {
  /** Descendants to SIGKILL alongside the root. Defaults to enumerating here. */
  descendantPids?: number[];
  /** Runner for the final sweep. Failures ignored: it is only a backstop. */
  execCommand?: (command: string) => Promise<{ stdout: string }>;
  /** Signal sender. Defaults to `process.kill`. */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Called when the ladder itself throws unexpectedly. Defaults to console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Hard kill with no graceful phase, grace window or probe — the logs-panel
 * stop shape. Unbranched on purpose: Node's SIGKILL is cross-platform, and
 * the shell sweep behind it silently no-ops through cmd.exe on win32.
 */
export async function killTreeImmediate(
  pid: number,
  opts: KillTreeImmediateOptions = {}
): Promise<void> {
  try {
    const allPids = [pid, ...(opts.descendantPids ?? (await collectDescendantPidsAsync(pid, opts)))];
    const sendSignal =
      opts.sendSignal ??
      ((signalPid: number, signal: NodeJS.Signals) => {
        process.kill(signalPid, signal);
      });
    for (const targetPid of allPids) {
      try {
        sendSignal(targetPid, 'SIGKILL');
      } catch (error) {
        // Process might already be dead or inaccessible
      }
    }

    // Shell command as the ultimate fallback (kill -9 cannot be caught or ignored)
    const execCommand =
      opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));
    try {
      await execCommand(`kill -9 ${allPids.join(' ')} 2>/dev/null; pkill -9 -P ${pid} 2>/dev/null`);
    } catch (error) {
      // Processes might already be dead — the sweep is best-effort by contract.
    }
  } catch (error) {
    if (opts.onError) {
      opts.onError(error);
    } else {
      console.error('Error killing process tree:', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
