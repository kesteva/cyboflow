import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import { killTree, listPidPpidTable } from '../utils/platformProcess';
import { exec } from 'child_process';
import { promisify } from 'util';
import { collectDescendantPids, parseProcessTable, type ProcessTableRow } from './processTable';

// The (pid, ppid) table helpers moved to processTable.ts (one parser/walker for
// every kill ladder); re-exported here so the injected-test seams and the
// existing imports keep working unchanged.
export { collectDescendantPids, parseProcessTable } from './processTable';
export type { ProcessTableRow } from './processTable';

interface TerminalSession {
  pty: pty.IPty;
  sessionId: string;
  cwd: string;
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
  /** Test seam: which kill ladder to run. Defaults to the host platform. */
  platform?: NodeJS.Platform;
}

/**
 * Default process lister — the shared two-column table from
 * utils/platformProcess.ts (`ps -axo pid=,ppid=` on POSIX, the PowerShell
 * stand-in on win32).
 */
const defaultListProcessTable = listPidPpidTable;

/** True if `error` is a Node errno exception carrying a `.code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

// Wrapped (rather than a bare promisify(exec)) so the default shell-command
// runner passes windowsHide — a packaged Windows app must never flash a conhost.
const execAsync = async (command: string): Promise<{ stdout: string; stderr: string }> =>
  promisify(exec)(command, { windowsHide: true });

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
  private readonly platform: NodeJS.Platform;

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
    this.platform = options.platform ?? process.platform;
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
   * Kill a process and all its descendants. Returns true if successful, false
   * if zombie processes remain.
   *
   * Both platform ladders live in utils/platformProcess.ts (killTree); this
   * site contributes its seams (execCommand / isPidAlive / sendSignal / the
   * injected process-table lister) and its zombie-event reporting, routed by
   * this class's `platform` option.
   */
  private async killProcessTree(pid: number): Promise<boolean> {
    // First, get all descendant PIDs before we start killing
    const descendantPids = await this.getAllDescendantPids(pid);

    return killTree(pid, {
      platform: this.platform,
      descendantPids,
      execCommand: (command) => this.execCommand(command),
      isPidAlive: (probePid) => this.isPidAlive(probePid),
      sendSignal: (signalPid, signal) => this.sendSignal(signalPid, signal),
      graceMs: this.graceMs,
      pollIntervalMs: this.pollIntervalMs,
      listDescendants: () => this.getAllDescendantPids(pid),
      onSurvivors: (remainingPids) => {
        console.error(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        this.emit('zombie-processes-detected', {
          sessionId: null,
          pids: remainingPids,
          message: `Failed to terminate ${remainingPids.length} child processes. Please manually kill PIDs: ${remainingPids.join(', ')}`
        });
      },
    });
  }
}
