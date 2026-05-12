import { ChildProcess, spawn, exec, execSync } from 'child_process';
import { ToolPanel, LogsPanelState } from '../../../../../shared/types/panels';
import { panelManager } from '../../panelManager';
import { addSessionLog, cleanupSessionLogs } from '../../../ipc/logs';
import { mainWindow } from '../../../index';
import { getShellPath } from '../../../utils/shellPath';
import type { AnalyticsManager } from '../../analyticsManager';

export class LogsManager {
  private static instance: LogsManager;
  private activeProcesses = new Map<string, ChildProcess>(); // panelId -> process
  private scriptStartTimes = new Map<string, number>(); // panelId -> start timestamp
  private analyticsManager: AnalyticsManager | null = null;
  
  static getInstance(): LogsManager {
    if (!LogsManager.instance) {
      LogsManager.instance = new LogsManager();
    }
    return LogsManager.instance;
  }

  /**
   * Set the analytics manager for tracking script executions
   */
  setAnalyticsManager(analyticsManager: AnalyticsManager): void {
    this.analyticsManager = analyticsManager;
  }

  /**
   * Get or create singleton logs panel for session
   */
  async getOrCreateLogsPanel(sessionId: string): Promise<ToolPanel> {
    const panels = await panelManager.getPanelsForSession(sessionId);
    const existingLogs = panels.find((p: ToolPanel) => p.type === 'logs');
    
    if (existingLogs) {
      // Clear existing panel output
      await this.clearPanel(existingLogs.id);
      
      // Emit panel:created event to ensure frontend adds it back if it was closed
      // This is necessary because closing a panel in the frontend removes it from the store
      // but doesn't delete it from the backend database
      if (mainWindow) {
        mainWindow.webContents.send('panel:created', existingLogs);
      }
      
      return existingLogs;
    }
    
    // Create new logs panel
    return await panelManager.createPanel({
      sessionId,
      type: 'logs',
      title: 'Logs'
    });
  }
  
  /**
   * Clear panel output and reset state
   */
  async clearPanel(panelId: string): Promise<void> {
    const panel = await panelManager.getPanel(panelId);
    if (!panel) return;
    
    // Clear session logs
    cleanupSessionLogs(panel.sessionId);
    
    // Reset panel state
    await panelManager.updatePanel(panelId, {
      state: {
        ...panel.state,
        customState: {
          isRunning: false,
          processId: undefined,
          command: undefined,
          startTime: undefined,
          endTime: undefined,
          exitCode: undefined,
          outputBuffer: [],
          errorCount: 0,
          warningCount: 0,
          lastActivityTime: undefined
        } as LogsPanelState
      }
    });
  }
  
  /**
   * Run a script in the logs panel
   */
  async runScript(sessionId: string, command: string, cwd: string): Promise<void> {
    // Get or create logs panel
    const panel = await this.getOrCreateLogsPanel(sessionId);
    
    // Stop any existing process for this panel
    await this.stopScript(panel.id);
    
    // Clear previous content
    await this.clearPanel(panel.id);
    
    // Small delay to ensure frontend processes the clear event
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Update panel state to running
    const startTime = new Date().toISOString();

    // Record start time for analytics tracking
    this.scriptStartTimes.set(panel.id, Date.now());

    await panelManager.updatePanel(panel.id, {
      state: {
        ...panel.state,
        customState: {
          isRunning: true,
          command,
          startTime,
          outputBuffer: [],
          errorCount: 0,
          warningCount: 0,
          lastActivityTime: startTime
        } as LogsPanelState
      }
    });
    
    // Make panel active
    await panelManager.setActivePanel(sessionId, panel.id);
    
    // Emit process started event
    if (mainWindow) {
      mainWindow.webContents.send('panel:event', {
        type: 'process:started',
        source: {
          panelId: panel.id,
          panelType: 'logs',
          sessionId
        },
        data: { command, cwd },
        timestamp: startTime
      });
    }
    
    // Get enhanced shell PATH for packaged apps
    const shellPath = getShellPath();
    
    // Start process with shell
    // We don't use exec wrapper as it can cause issues with complex scripts
    const childProcess = spawn(command, [], {
      cwd,
      shell: true,
      env: {
        ...process.env,
        PATH: shellPath
      }
    });
    
    if (childProcess.pid) {
      // Store process reference
      this.activeProcesses.set(panel.id, childProcess);
      
      // Update panel with process ID
      await panelManager.updatePanel(panel.id, {
        state: {
          ...panel.state,
          customState: {
            ...(panel.state.customState as LogsPanelState),
            processId: childProcess.pid
          } as LogsPanelState
        }
      });
      
      // Stream stdout
      childProcess.stdout?.on('data', (data) => {
        this.handleOutput(panel.id, sessionId, data.toString(), 'stdout');
      });
      
      // Stream stderr
      childProcess.stderr?.on('data', (data) => {
        this.handleOutput(panel.id, sessionId, data.toString(), 'stderr');
      });
      
      // Handle process exit
      childProcess.on('exit', (code) => {
        this.handleProcessExit(panel.id, sessionId, code);
      });
      
      // Handle process error
      childProcess.on('error', (error) => {
        this.handleOutput(panel.id, sessionId, `Process error: ${error.message}`, 'stderr');
        this.handleProcessExit(panel.id, sessionId, 1);
      });
    } else {
      // Process failed to start
      this.handleOutput(panel.id, sessionId, 'Failed to start process', 'stderr');
      this.handleProcessExit(panel.id, sessionId, 1);
    }
  }
  
  /**
   * Get all descendant PIDs of a process recursively
   * @param parentPid The parent process ID
   * @returns Array of all descendant PIDs
   */
  private getAllDescendantPids(parentPid: number): number[] {
    const descendants: number[] = [];

    try {
      const output = execSync(`ps -o pid= --ppid ${parentPid}`, { encoding: 'utf8' });
      const pids = output.split('\n')
        .map(line => parseInt(line.trim()))
        .filter(pid => !isNaN(pid));

      for (const pid of pids) {
        descendants.push(pid);
        descendants.push(...this.getAllDescendantPids(pid));
      }
    } catch (error) {
      // Command might fail if no children exist, which is fine
    }

    return descendants;
  }

  /**
   * Stop a running script and ensure all child processes are terminated.
   * This method uses multiple approaches to ensure complete cleanup:
   * 1. Gets all descendant PIDs recursively before killing
   * 2. Kills the process group via `kill -TERM -<pgid>` then `-9`
   * 3. Kills individual descendant processes as a fallback
   * 4. Uses graceful SIGTERM first, then forceful SIGKILL
   */
  async stopScript(panelId: string): Promise<void> {
    const childProcess = this.activeProcesses.get(panelId);
    if (!childProcess || !childProcess.pid) {
      this.activeProcesses.delete(panelId);
      return;
    }
    
    const pid = childProcess.pid;

    // Immediately remove from active processes to prevent new output
    this.activeProcesses.delete(panelId);

    try {
      // First, get all descendant PIDs before we start killing
      const descendantPids = this.getAllDescendantPids(pid);

      // macOS/Unix: kill the shell AND all its descendants
      const allPids = [pid, ...descendantPids];

      for (const targetPid of allPids) {
        try {
          process.kill(targetPid, 'SIGKILL');
        } catch (error: unknown) {
          // Process might already be dead or inaccessible
        }
      }

      // Use shell command as ultimate fallback (kill -9 cannot be caught or ignored)
      const killCmd = `kill -9 ${allPids.join(' ')} 2>/dev/null; pkill -9 -P ${pid} 2>/dev/null`;
      await new Promise<void>((resolve) => {
        exec(killCmd, () => {
          // Ignore errors - processes might already be dead
          resolve();
        });
      });
    } catch (error) {
      console.error('Error killing process tree:', error);
    }
  }
  
  /**
   * Handle process output
   */
  private async handleOutput(panelId: string, sessionId: string, content: string, type: 'stdout' | 'stderr'): Promise<void> {
    // Add to session logs
    const level = type === 'stderr' ? 'error' : 'info';
    addSessionLog(sessionId, level, content, 'Script');
    
    // Emit output event
    if (mainWindow) {
      mainWindow.webContents.send('panel:event', {
        type: 'process:output',
        source: {
          panelId,
          panelType: 'logs',
          sessionId
        },
        data: { content, type },
        timestamp: new Date().toISOString()
      });
      
      // Also send logs-specific output event for the panel
      mainWindow.webContents.send('logs:output', {
        panelId,
        content,
        type
      });
    }
    
    // Update panel state
    const panel = await panelManager.getPanel(panelId);
    if (panel) {
      const currentState = panel.state.customState as LogsPanelState || {};
      const outputBuffer = currentState.outputBuffer || [];
      outputBuffer.push(content);
      
      // Keep only last 1000 lines in buffer
      if (outputBuffer.length > 1000) {
        outputBuffer.splice(0, outputBuffer.length - 1000);
      }
      
      // Count errors and warnings
      let errorCount = currentState.errorCount || 0;
      let warningCount = currentState.warningCount || 0;
      
      if (type === 'stderr' || content.toLowerCase().includes('error')) {
        errorCount++;
      }
      if (content.toLowerCase().includes('warning')) {
        warningCount++;
      }
      
      await panelManager.updatePanel(panelId, {
        state: {
          ...panel.state,
          customState: {
            ...currentState,
            outputBuffer,
            errorCount,
            warningCount,
            lastActivityTime: new Date().toISOString()
          } as LogsPanelState
        }
      });
    }
  }
  
  /**
   * Handle process exit
   */
  private async handleProcessExit(panelId: string, sessionId: string, code: number | null): Promise<void> {
    // Remove from active processes
    this.activeProcesses.delete(panelId);

    // Track script execution analytics
    const startTime = this.scriptStartTimes.get(panelId);
    if (startTime && this.analyticsManager) {
      const duration = (Date.now() - startTime) / 1000; // Convert to seconds
      const success = code === 0;

      this.analyticsManager.track('run_script_executed', {
        success,
        duration_seconds: this.analyticsManager.categorizeDuration(duration),
      });

      // Clean up start time
      this.scriptStartTimes.delete(panelId);
    }

    // Update panel state
    const panel = await panelManager.getPanel(panelId);
    if (panel) {
      const currentState = panel.state.customState as LogsPanelState || {};
      await panelManager.updatePanel(panelId, {
        state: {
          ...panel.state,
          customState: {
            ...currentState,
            isRunning: false,
            endTime: new Date().toISOString(),
            exitCode: code ?? undefined
          } as LogsPanelState
        }
      });
    }

    // Emit process ended event
    if (mainWindow) {
      mainWindow.webContents.send('panel:event', {
        type: 'process:ended',
        source: {
          panelId,
          panelType: 'logs',
          sessionId
        },
        data: { exitCode: code },
        timestamp: new Date().toISOString()
      });

      // Also send specific event for the panel
      mainWindow.webContents.send('process:ended', {
        panelId,
        exitCode: code
      });
    }

    // Add final log entry
    const message = code === 0
      ? 'Process completed successfully'
      : `Process exited with code ${code}`;
    addSessionLog(sessionId, code === 0 ? 'info' : 'error', message, 'Script');
  }
  
  /**
   * Check if a logs panel is running for a session
   */
  async isRunning(sessionId: string): Promise<boolean> {
    const panels = await panelManager.getPanelsForSession(sessionId);
    const logsPanel = panels.find((p: ToolPanel) => p.type === 'logs');
    
    if (!logsPanel) return false;
    
    const state = logsPanel.state.customState as LogsPanelState;
    return state?.isRunning || false;
  }
  
  /**
   * Get the running process for a session's logs panel
   */
  async getRunningProcess(sessionId: string): Promise<ChildProcess | undefined> {
    const panels = await panelManager.getPanelsForSession(sessionId);
    const logsPanel = panels.find((p: ToolPanel) => p.type === 'logs');
    
    if (!logsPanel) return undefined;
    
    return this.activeProcesses.get(logsPanel.id);
  }
  
  /**
   * Cleanup all running processes
   */
  async cleanup(): Promise<void> {
    // Stop all running processes
    for (const [panelId, process] of this.activeProcesses) {
      await this.stopScript(panelId);
    }
    this.activeProcesses.clear();
  }
}

export const logsManager = LogsManager.getInstance();