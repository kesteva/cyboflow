import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { getShellPath, findExecutableInPath } from '../utils/shellPath';
import { logsManager } from '../services/panels/logPanel/logsManager';
import { ExecException } from 'child_process';

export function registerScriptHandlers(ipcMain: IpcMain, { sessionManager }: AppServices): void {
  ipcMain.handle('sessions:open-ide', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project || !project.open_ide_command) {
        return { success: false, error: 'No IDE command configured for this project' };
      }

      // Execute the IDE command in the worktree directory
      const { exec } = require('child_process');
      
      // Get enhanced shell PATH for packaged apps
      const shellPath = getShellPath();
      
      console.log(`[IDE] Opening IDE with command: ${project.open_ide_command}`);
      console.log(`[IDE] Working directory: ${session.worktreePath}`);
      console.log(`[IDE] Using PATH: ${shellPath.split(':').slice(0, 5).join(':')}...`);
      
      // Wrap exec in a Promise to wait for completion
      return new Promise((resolve) => {
        exec(
          project.open_ide_command,
          {
            cwd: session.worktreePath,
            shell: true,
            windowsHide: true,
            env: {
              ...process.env,
              PATH: shellPath  // Use enhanced PATH that includes user's shell PATH
            }
          },
          (error: ExecException | null, stdout: string, stderr: string) => {
            if (error) {
              console.error('Failed to open IDE:', error);
              console.error('stdout:', stdout);
              console.error('stderr:', stderr);
              
              let errorMessage = 'Failed to open IDE';
              
              // Provide more specific error messages
              if (error.code === 127 || stderr.includes('command not found')) {
                // Try to extract just the command name (e.g., "code" from "code .")
                const commandParts = project.open_ide_command!.trim().split(/\s+/);
                const commandName = commandParts[0];
                
                // Try to find the executable in PATH
                const foundPath = findExecutableInPath(commandName);
                
                if (foundPath) {
                  errorMessage = `IDE command not found: ${project.open_ide_command}.\n\nThe command '${commandName}' was found at: ${foundPath}\n\nTry updating your project settings to use the full path:\n${foundPath} .`;
                } else {
                  // The VS Code example is platform-specific: the .app-relative
                  // launcher path only exists on macOS.
                  const vscodeHint = process.platform === 'win32'
                    ? `For VS Code, try: code "${session.worktreePath}"`
                    : 'For VS Code, try: /Applications/Visual\\ Studio\\ Code.app/Contents/Resources/app/bin/code .';
                  errorMessage = `IDE command not found: ${project.open_ide_command}.\n\nMake sure the command is in your PATH or use a full path.\n\n${vscodeHint}`;
                }
              } else if (error.code) {
                errorMessage = `IDE command failed with exit code ${error.code}: ${stderr || error.message}`;
              } else {
                errorMessage = `Failed to open IDE: ${error.message}`;
              }
              
              resolve({ success: false, error: errorMessage });
            } else {
              console.log('Successfully opened IDE for session:', sessionId);
              if (stdout) console.log('IDE command output:', stdout);
              resolve({ success: true });
            }
          }
        );
      });
    } catch (error) {
      console.error('Failed to open IDE:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open IDE' };
    }
  });

  // Logs panel stop button
  ipcMain.handle('logs:stopScript', async (_event, panelId: string) => {
    try {
      await logsManager.stopScript(panelId);
      return { success: true };
    } catch (error) {
      console.error('Failed to stop script in logs panel:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop script' };
    }
  });
} 