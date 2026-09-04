import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { Logger } from '../utils/logger';
import type { DatabaseService } from '../database/database';
import type { ProjectRunCommand } from '../database/models';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import { exec } from 'child_process';
import { promisify } from 'util';
import { collectDescendantPidsAsync, forceKillPids, killTree } from '../utils/platformProcess';

interface RunProcess {
  process: pty.IPty;
  command: ProjectRunCommand;
  sessionId: string;
}

export class RunCommandManager extends EventEmitter {
  private processes: Map<string, RunProcess[]> = new Map();

  // Wrapped (rather than a bare promisify(exec)) so every kill-ladder call
  // passes windowsHide — a packaged Windows app must never flash a conhost.
  private readonly execAsync = async (command: string): Promise<{ stdout: string; stderr: string }> =>
    promisify(exec)(command, { windowsHide: true });

  constructor(
    private databaseService: DatabaseService,
    private logger?: Logger
  ) {
    super();
  }

  async startRunCommands(sessionId: string, projectId: number, worktreePath: string): Promise<void> {
    try {
      // Get all run commands for the project
      const runCommands = this.databaseService.getProjectRunCommands(projectId);
      
      
      if (runCommands.length === 0) {
        this.logger?.info(`No RUN commands configured for project ${projectId}`);
        return;
      }

      this.logger?.info(`Starting ${runCommands.length} RUN commands sequentially for session ${sessionId}`);
      
      const processes: RunProcess[] = [];

      // Execute commands sequentially
      for (let i = 0; i < runCommands.length; i++) {
        const command = runCommands[i];
        
        try {
          this.logger?.verbose(`Starting RUN command ${i + 1}/${runCommands.length}: ${command.display_name || command.command}`);
          
          // Split command by newlines to execute each line sequentially
          const commandLines = command.command.split('\n').filter(line => line.trim());
          
          for (let j = 0; j < commandLines.length; j++) {
            const commandLine = commandLines[j].trim();
            if (!commandLine) continue;
            
            this.logger?.verbose(`Executing line ${j + 1}/${commandLines.length} of command ${i + 1}: ${commandLine}`);
            
            // Create environment with WORKTREE_PATH and enhanced PATH
            const shellPath = getShellPath();
            const env = {
              ...process.env,
              WORKTREE_PATH: worktreePath,
              PATH: shellPath
            } as { [key: string]: string };
            
            // Log environment details for debugging
            if (j === 0) {
              this.logger?.verbose(`Setting WORKTREE_PATH to: ${worktreePath}`);
              this.logger?.verbose(`Enhanced PATH: ${shellPath}`);
              this.logger?.verbose(`Env WORKTREE_PATH check: ${env.WORKTREE_PATH}`);
            }
            
            // Get the user's default shell
            const shellInfo = ShellDetector.getDefaultShell();
            this.logger?.verbose(`Using shell: ${shellInfo.path} (${shellInfo.name})`);
            
            // Prepare command with environment variable, in the dialect
            // getShellCommandArgs routes to: POSIX sets it via `export` joined
            // with `&&`; PowerShell (the win32 shell) has no `export` and, on
            // the PS 5.1 every Windows host ships, cannot parse `&&`. The
            // quoting still prevents shell injection from adversarial
            // directory names — escapeShellArg on POSIX, PS single-quote
            // doubling on win32.
            const commandWithEnv = ShellDetector.buildCommandString(
              { WORKTREE_PATH: worktreePath },
              [commandLine]
            );
            
            // Get shell command arguments
            const { shell, args: shellArgs } = ShellDetector.getShellCommandArgs(commandWithEnv);
            
            this.logger?.verbose(`Using shell: ${shell}`);
            this.logger?.verbose(`Full command: ${commandWithEnv}`);
            
            // Spawn the shell process with the enhanced environment
            // IMPORTANT: We don't use 'detached' here because node-pty already creates a new session
            const ptyProcess = pty.spawn(shell, shellArgs, {
              name: 'xterm-color',
              cols: 80,
              rows: 30,
              cwd: worktreePath,
              env: env
            });

            const runProcess: RunProcess = {
              process: ptyProcess,
              command,
              sessionId
            };

            // Store the process immediately so it can be stopped if needed
            const currentProcesses = this.processes.get(sessionId) || [];
            currentProcesses.push(runProcess);
            this.processes.set(sessionId, currentProcesses);

            // Wait for this command line to complete before starting the next one
            await new Promise<void>((resolve, reject) => {
              let hasExited = false;

              // Handle output from the run command
              ptyProcess.onData((data: string) => {
                this.emit('output', {
                  sessionId,
                  commandId: command.id,
                  displayName: command.display_name || command.command,
                  type: 'stdout',
                  data,
                  timestamp: new Date()
                });
              });

              ptyProcess.onExit(({ exitCode, signal }) => {
                hasExited = true;
                this.logger?.info(`Command line exited: ${commandLine}, exitCode: ${exitCode}, signal: ${signal}`);
                
                // Only emit exit event for the last line of a command
                if (j === commandLines.length - 1) {
                  this.emit('exit', {
                    sessionId,
                    commandId: command.id,
                    displayName: command.display_name || command.command,
                    exitCode,
                    signal
                  });
                }

                // Remove from processes array
                const sessionProcesses = this.processes.get(sessionId);
                if (sessionProcesses) {
                  const index = sessionProcesses.indexOf(runProcess);
                  if (index > -1) {
                    sessionProcesses.splice(index, 1);
                  }
                }

                // Only continue to next command line if this one succeeded
                if (exitCode === 0) {
                  resolve();
                } else {
                  reject(new Error(`Command line failed with exit code ${exitCode}: ${commandLine}`));
                }
              });
            });

            this.logger?.verbose(`Completed command line successfully: ${commandLine}`);
          }

          this.logger?.info(`Completed run command successfully: ${command.display_name || command.command}`);
        } catch (error) {
          this.logger?.error(`Failed to run command: ${command.display_name || command.command}`, error as Error);
          this.emit('error', {
            sessionId,
            commandId: command.id,
            displayName: command.display_name || command.command,
            error: error instanceof Error ? error.message : String(error)
          });
          
          // Stop execution of subsequent commands if one fails
          break;
        }
      }

      this.logger?.info(`Finished running commands for session ${sessionId}`);
    } catch (error) {
      this.logger?.error(`Failed to start run commands for session ${sessionId}`, error as Error);
      throw error;
    }
  }

  async stopRunCommands(sessionId: string): Promise<void> {
    const processes = this.processes.get(sessionId);
    if (!processes || processes.length === 0) {
      return;
    }

    this.logger?.info(`Stopping ${processes.length} run commands for session ${sessionId}`);

    // Collect all PIDs we know about
    const knownPids: number[] = [];
    
    for (const runProcess of processes) {
      try {
        const pid = runProcess.process.pid;
        const commandName = runProcess.command.display_name || runProcess.command.command;
        
        if (pid) {
          knownPids.push(pid);
          // Use the comprehensive killProcessTree method
          const success = await this.killProcessTree(pid, commandName);
          if (!success) {
            this.logger?.error(`Failed to cleanly terminate all child processes for command: ${commandName}`);
          }
        }
        
        // Also try to kill via pty interface as fallback
        try {
          runProcess.process.kill();
        } catch (error) {
          // Process might already be dead
        }
      } catch (error) {
        this.logger?.error(`Failed to stop run command: ${runProcess.command.display_name || runProcess.command.command}`, error as Error);
      }
    }

    // IMPORTANT: Do a final sweep to catch any processes that might have escaped
    // This happens when the shell exits but child processes continue running
    if (knownPids.length > 0) {
      await this.killEscapedProcesses(sessionId, knownPids);
    }

    this.processes.delete(sessionId);
  }

  async stopAllRunCommands(): Promise<void> {
    const stopPromises = [];
    for (const [sessionId, processes] of this.processes) {
      stopPromises.push(this.stopRunCommands(sessionId));
    }
    await Promise.all(stopPromises);
  }

  /**
   * Get all descendant PIDs of a parent process recursively
   * This is critical for ensuring all child processes are killed
   *
   * The per-platform enumeration strategy (PowerShell (pid, ppid) table on
   * win32, per-level `ps --ppid` recursion on POSIX) lives in
   * utils/platformProcess.ts; this site contributes only its warning logging.
   */
  private getAllDescendantPids(parentPid: number): Promise<number[]> {
    return collectDescendantPidsAsync(parentPid, {
      onWalkError: (error) => this.logger?.warn(`Error getting descendant PIDs for ${parentPid}:`, error as Error),
    });
  }

  /**
   * Kill a process and all its descendants. Returns true if successful, false
   * if zombie processes remain.
   *
   * Both platform ladders live in utils/platformProcess.ts (killTree); this
   * site contributes its seams (execCommand / the zombie-event reporting) and
   * its ladder timings: a fixed, non-probed grace window on both platforms
   * (2s on Windows, the historical 10s on POSIX), and — POSIX — the
   * pre-signal pgid resolution that sweeps in group members the up-front tree
   * walk missed (posixGroupMode 'enumerate').
   */
  private async killProcessTree(pid: number, commandName: string): Promise<boolean> {
    // First, get all descendant PIDs before we start killing
    const descendantPids = await this.getAllDescendantPids(pid);
    this.logger?.info(`Found ${descendantPids.length} descendant processes for PID ${pid}: ${descendantPids.join(', ')}`);

    return killTree(pid, {
      descendantPids,
      logger: {
        info: (message) => this.logger?.info(`[${commandName}] ${message}`),
        warn: (message, error) => this.logger?.warn(`[${commandName}] ${message}`, error as Error),
      },
      execCommand: (command) => this.execAsync(command),
      // This ladder historically slept the grace window unconditionally (no
      // probe) on both platforms — preserved exactly via the fixed grace mode.
      graceMode: 'fixed',
      graceMs: process.platform === 'win32' ? 2000 : 10_000,
      posixGroupMode: 'enumerate',
      listDescendants: () => this.getAllDescendantPids(pid),
      onGracefulError: (error) => {
        this.logger?.verbose(`Graceful taskkill for ${pid} did not settle (expected for console apps): ${error}`);
      },
      onSurvivors: (remainingPids) => {
        this.logger?.error(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        this.emit('zombie-processes-detected', {
          commandName,
          pids: remainingPids,
          message: `Failed to terminate ${remainingPids.length} child processes from command "${commandName}". Please manually kill PIDs: ${remainingPids.join(', ')}`
        });
      },
      onError: (error) => this.logger?.error('Error in killProcessTree:', error as Error),
    });
  }

  /**
   * Kill any processes that might have escaped our normal termination
   * This can happen when a shell exits but its children continue running
   */
  private async killEscapedProcesses(sessionId: string, knownPids: number[]): Promise<void> {
    try {
      // Every process that still has one of our known pids as an ancestor.
      const allDescendants: number[] = [];

      for (const pid of knownPids) {
        allDescendants.push(...(await this.getAllDescendantPids(pid)));

        // POSIX only, and the one place this file reads the platform: a
        // process reparented to init has left the tree the walk above covers,
        // but it is still in the group. Windows has no process groups, and its
        // taskkill walk is the whole story there.
        if (process.platform === 'win32') continue;
        try {
          const pgidResult = await this.execAsync(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
          const pgid = parseInt(pgidResult.stdout.trim());
          if (!isNaN(pgid)) {
            const pgResult = await this.execAsync(`ps -o pid= -g ${pgid} 2>/dev/null || true`);
            const pgPids = pgResult.stdout.split('\n')
              .map(line => parseInt(line.trim()))
              .filter(p => !isNaN(p) && !knownPids.includes(p));
            if (pgPids.length > 0) {
              this.logger?.warn(`Found ${pgPids.length} orphaned processes in process group ${pgid}: ${pgPids.join(', ')}`);
              allDescendants.push(...pgPids);
            }
          }
        } catch (error) {
          // Process might be gone already
        }
      }

      const escapees = [...new Set(allDescendants)];
      if (escapees.length === 0) return;

      this.logger?.warn(`Killing ${escapees.length} escaped processes: ${escapees.join(', ')}`);
      await forceKillPids(escapees, {
        execCommand: (command) => this.execAsync(command),
        onKilled: (pid) => this.logger?.info(`Killed escaped process ${pid}`),
      });

      this.emit('zombie-processes-detected', {
        sessionId,
        pids: escapees,
        message: `Detected and killed ${escapees.length} processes that escaped normal termination`
      });
    } catch (error) {
      this.logger?.error('Error killing escaped processes:', error as Error);
    }
  }
}