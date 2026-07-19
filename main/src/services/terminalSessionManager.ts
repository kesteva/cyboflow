import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

interface TerminalSession {
  pty: pty.IPty;
  sessionId: string;
  cwd: string;
}

/** One row of the system process table: a pid and its parent pid. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
}

/** Minimal shape of a shell command's result — only stdout is ever consulted. */
interface ExecResult {
  stdout: string;
}

/**
 * Construction-time seams for process control. The real `ps`/`process.kill`/`exec`
 * implementations are the defaults — overriding them lets tests exercise the
 * SIGTERM-poll-SIGKILL flow and descendant enumeration deterministically, without
 * spawning real subprocesses or waiting out real timers.
 */
export interface TerminalSessionManagerOptions {
  /** List every host process as {pid, ppid} rows. Defaults to `ps -axo pid=,ppid=`. */
  listProcessTable?: () => Promise<ProcessTableRow[]>;
  /** Signal-0 liveness probe; a negative pid probes a process group. Defaults to `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
  /** Send a signal to a pid; a negative pid targets a process group. Defaults to `process.kill`. */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Run a shell command (pgid lookup, group kill, and the `pkill` fallback). Defaults to the real `child_process.exec`. */
  execCommand?: (command: string) => Promise<ExecResult>;
  /** Poll interval while waiting out the post-SIGTERM grace window. Defaults to 100ms. */
  pollIntervalMs?: number;
  /**
   * Bounded grace period after SIGTERM before forcing SIGKILL. Reviewed decision:
   * ~2s (NOT 200ms) — give shells a real chance to exit cleanly. Defaults to 2000ms.
   */
  graceMs?: number;
}

/**
 * Parse `ps -axo pid=,ppid=` output into rows ("<pid> <ppid>" per line, no
 * header). Lines that don't match a plain numeric pair are skipped.
 */
export function parseProcessTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * Collect every descendant of `rootPid` by walking the ppid table (BFS,
 * cycle-safe). Excludes the root itself and never traverses pid<=1 (never chase
 * launchd/kernel via a stray reparent). Mirrors the tree-walk in
 * `codexBrokerReaper.ts`'s `collectProcessTree`.
 */
export function collectDescendantPids(rootPid: number, procs: ProcessTableRow[]): number[] {
  const childrenByPpid = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid <= 1) continue;
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByPpid.set(p.ppid, [p.pid]);
  }

  // Never traverse from a root of launchd/kernel itself (mirrors codexBrokerReaper's
  // collectProcessTree guard) — a reparented pid<=1 root has no legitimate descendants
  // to enumerate here.
  if (rootPid <= 1) return [];

  const result = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const kids = childrenByPpid.get(current);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid > 1 && kid !== rootPid && !result.has(kid)) {
        result.add(kid);
        queue.push(kid);
      }
    }
  }
  return [...result];
}

/** True if `error` is a Node errno exception carrying a `.code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Default process lister: one `ps -axo pid=,ppid=` call (no header, all
 * processes, no shell interpolation). Unlike the Linux-only `ps --ppid` flag
 * this works on both macOS and Linux.
 */
function defaultListProcessTable(): Promise<ProcessTableRow[]> {
  return new Promise<ProcessTableRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid='],
      // The full process table can be large; 16 MiB comfortably covers it.
      { maxBuffer: 16 * 1024 * 1024 },
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

/**
 * Default liveness probe: signal-0 `process.kill`. ESRCH ("no such
 * process/group") means dead; EPERM ("exists, no permission to signal") still
 * counts as alive.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

/** Default signal sender: `process.kill`. */
function defaultSendSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

const execAsync = promisify(exec);

/** Default shell-command runner: the real `child_process.exec`. */
async function defaultExecCommand(command: string): Promise<ExecResult> {
  const { stdout } = await execAsync(command);
  return { stdout };
}

export class TerminalSessionManager extends EventEmitter {
  private terminalSessions: Map<string, TerminalSession> = new Map();
  private readonly listProcessTable: () => Promise<ProcessTableRow[]>;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly execCommand: (command: string) => Promise<ExecResult>;
  private readonly pollIntervalMs: number;
  private readonly graceMs: number;

  constructor(options: TerminalSessionManagerOptions = {}) {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    this.setMaxListeners(50);
    this.listProcessTable = options.listProcessTable ?? defaultListProcessTable;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.sendSignal = options.sendSignal ?? defaultSendSignal;
    this.execCommand = options.execCommand ?? defaultExecCommand;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.graceMs = options.graceMs ?? 2000;
  }

  async createTerminalSession(sessionId: string, worktreePath: string): Promise<void> {
    // Check if session already exists
    if (this.terminalSessions.has(sessionId)) {
      return;
    }

    const shellPath = getShellPath();

    // Get the user's default shell
    const shellInfo = ShellDetector.getDefaultShell();
    console.log(`Using shell: ${shellInfo.path} (${shellInfo.name})`);

    // Create a new PTY instance with proper terminal settings
    const ptyProcess = pty.spawn(shellInfo.path, shellInfo.args || [], {
      name: 'xterm-256color',  // Better terminal emulation
      cwd: worktreePath,
      cols: 80,
      rows: 24,
      env: {
        ...process.env,
        PATH: shellPath,
        WORKTREE_PATH: worktreePath,
        TERM: 'xterm-256color',  // Ensure TERM is set for color support
        COLORTERM: 'truecolor',  // Enable 24-bit color
        LANG: process.env.LANG || 'en_US.UTF-8',  // Set locale for proper character handling
        // Canonical Cyboflow env var exposed to PTY subprocesses.
        CYBOFLOW_SESSION_ID: sessionId,
        // @deprecated Legacy Crystal-era name kept for backward compat with user
        // shell scripts. TODO(post-v1): remove after deprecation window.
        CRYSTAL_SESSION_ID: sessionId,
      },
    });

    // Store the session
    this.terminalSessions.set(sessionId, {
      pty: ptyProcess,
      sessionId,
      cwd: worktreePath,
    });

    // Handle data from the PTY
    ptyProcess.onData((data: string) => {
      this.emit('terminal-output', { sessionId, data, type: 'stdout' });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      this.terminalSessions.delete(sessionId);
    });

    // Don't send any initial input - let the user interact with the terminal
    // This prevents unnecessary terminal output and activity indicators
  }

  sendCommand(sessionId: string, command: string): void {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      throw new Error('Terminal session not found');
    }

    // Send the command to the PTY
    session.pty.write(command + '\r');
  }

  sendInput(sessionId: string, data: string): void {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      throw new Error('Terminal session not found');
    }

    // Send raw input directly to the PTY without modification
    session.pty.write(data);
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const session = this.terminalSessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  async closeTerminalSession(sessionId: string): Promise<void> {
    const session = this.terminalSessions.get(sessionId);
    if (session) {
      try {
        const pid = session.pty.pid;

        // Kill the process tree to ensure all child processes are terminated
        if (pid) {
          const success = await this.killProcessTree(pid);
          if (!success) {
            // Emit warning about zombie processes
            this.emit('zombie-processes-detected', {
              sessionId,
              message: `Warning: Some child processes could not be terminated. Check system process list.`
            });
          }
        }

        // Also try to kill via pty interface as fallback
        try {
          session.pty.kill();
        } catch (error) {
          // PTY might already be dead
        }
      } catch (error) {
        console.warn(`Error killing terminal session ${sessionId}:`, error);
      }
      this.terminalSessions.delete(sessionId);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.terminalSessions.has(sessionId);
  }

  async cleanup(): Promise<void> {
    // Close all terminal sessions
    const closePromises = [];
    for (const sessionId of this.terminalSessions.keys()) {
      closePromises.push(this.closeTerminalSession(sessionId));
    }
    await Promise.all(closePromises);
  }

  /**
   * Get all descendant PIDs of a parent process recursively.
   * This is critical for ensuring all child processes are killed.
   */
  private async getAllDescendantPids(parentPid: number): Promise<number[]> {
    try {
      const procs = await this.listProcessTable();
      return collectDescendantPids(parentPid, procs);
    } catch (error) {
      console.warn(`Error getting descendant PIDs for ${parentPid}:`, error);
      return [];
    }
  }

  /**
   * Poll every `pollIntervalMs` for up to `graceMs` after SIGTERM, returning as
   * soon as both the main pid and its process group are dead. A probe that
   * throws is treated as "still alive" so the grace window elapses safely
   * rather than short-circuiting to a premature SIGKILL.
   */
  private async waitForExit(pid: number, pgid: number): Promise<void> {
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline) {
      if (!this.probeAlive(pid) && !this.probeAlive(-pgid)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private probeAlive(pid: number): boolean {
    try {
      return this.isPidAlive(pid);
    } catch {
      return true;
    }
  }

  /**
   * Kill a process and all its descendants
   * Returns true if successful, false if zombie processes remain
   */
  private async killProcessTree(pid: number): Promise<boolean> {
    // First, get all descendant PIDs before we start killing
    const descendantPids = await this.getAllDescendantPids(pid);

    let success = true;

    try {
      // macOS/Unix: First, try SIGTERM for graceful shutdown
      try {
        this.sendSignal(pid, 'SIGTERM');
      } catch (error) {
        console.warn('SIGTERM failed:', error);
      }

      // Kill the entire process group using negative PID
      // First, find the actual process group ID
      let pgid = pid;
      try {
        const pgidResult = await this.execCommand(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
        const foundPgid = parseInt(pgidResult.stdout.trim());
        if (!isNaN(foundPgid)) {
          pgid = foundPgid;
        }
      } catch (error) {
        // Use original PID as fallback
      }

      try {
        await this.execCommand(`kill -TERM -${pgid}`);
      } catch (error) {
        console.warn(`Error sending SIGTERM to process group: ${error}`);
      }

      // Poll for early exit instead of unconditionally sleeping the full grace
      // window — return the moment both the main pid and its process group are
      // gone, bounded at ~2s (reviewed: NOT 200ms — give shells a real chance to
      // exit cleanly) before forcing SIGKILL below.
      await this.waitForExit(pid, pgid);

      // Now forcefully kill the main process
      try {
        this.sendSignal(pid, 'SIGKILL');
      } catch (error) {
        // Process might already be dead
      }

      // Kill the process group with SIGKILL
      try {
        await this.execCommand(`kill -9 -${pgid}`);
      } catch (error) {
        console.warn(`Error sending SIGKILL to process group: ${error}`);
      }

      // Kill all known descendants individually to be sure
      for (const childPid of descendantPids) {
        try {
          await this.execCommand(`kill -9 ${childPid}`);
        } catch (error) {
          // Process already terminated
        }
      }

      // Final cleanup attempt using pkill
      try {
        await this.execCommand(`pkill -9 -P ${pid}`);
      } catch (error) {
        // Ignore errors - processes might already be dead
      }

      // Verify all processes are actually dead
      await new Promise(resolve => setTimeout(resolve, 500));
      const remainingPids = await this.getAllDescendantPids(pid);

      if (remainingPids.length > 0) {
        console.error(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        success = false;

        this.emit('zombie-processes-detected', {
          sessionId: null,
          pids: remainingPids,
          message: `Failed to terminate ${remainingPids.length} child processes. Please manually kill PIDs: ${remainingPids.join(', ')}`
        });
      }
    } catch (error) {
      console.error('Error in killProcessTree:', error);
      success = false;
    }

    return success;
  }
}
