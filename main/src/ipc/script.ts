import { IpcMain } from 'electron';
import { exec, type ExecException } from 'child_process';
import type { AppServices } from './types';
import { getShellPath, findExecutableInPath } from '../utils/shellPath';
import { logsManager } from '../services/panels/logPanel/logsManager';

type OpenIdeResult = { success: true } | { success: false; error: string };

export function registerScriptHandlers(ipcMain: IpcMain, { sessionManager }: AppServices): void {
  // Runs the project's configured "Open IDE Command" in the session worktree.
  // Triggered by the "Open in IDE" button in the right-rail Diff tab header.
  ipcMain.handle('sessions:open-ide', async (_event, sessionId: string): Promise<OpenIdeResult> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      const ideCommand = project?.open_ide_command;
      if (!ideCommand) {
        return { success: false, error: 'No IDE command configured for this project' };
      }
      const worktreePath = session.worktreePath;

      // Enhanced PATH so a packaged app (launched without the user's shell
      // environment) still finds `code`, `cursor`, etc.
      const shellPath = getShellPath();

      return await new Promise<OpenIdeResult>((resolve) => {
        exec(
          ideCommand,
          {
            cwd: worktreePath,
            windowsHide: true,
            env: { ...process.env, PATH: shellPath },
          },
          (error: ExecException | null, _stdout: string, stderr: string) => {
            if (!error) {
              resolve({ success: true });
              return;
            }
            console.error('[IDE] Failed to open IDE:', error, stderr ? `stderr: ${stderr}` : '');

            let errorMessage: string;
            if (error.code === 127 || stderr.includes('command not found')) {
              // Extract just the command name (e.g. "code" from "code .").
              const commandName = ideCommand.trim().split(/\s+/)[0];
              const foundPath = findExecutableInPath(commandName);
              if (foundPath) {
                errorMessage = `IDE command not found: ${ideCommand}.\n\nThe command '${commandName}' was found at: ${foundPath}\n\nTry updating your project settings to use the full path:\n${foundPath} .`;
              } else {
                // The VS Code example is platform-specific: the .app-relative
                // launcher path only exists on macOS.
                const vscodeHint = process.platform === 'win32'
                  ? `For VS Code, try: code "${worktreePath}"`
                  : 'For VS Code, try: /Applications/Visual\\ Studio\\ Code.app/Contents/Resources/app/bin/code .';
                errorMessage = `IDE command not found: ${ideCommand}.\n\nMake sure the command is in your PATH or use a full path.\n\n${vscodeHint}`;
              }
            } else if (error.code) {
              errorMessage = `IDE command failed with exit code ${error.code}: ${stderr || error.message}`;
            } else {
              errorMessage = `Failed to open IDE: ${error.message}`;
            }
            resolve({ success: false, error: errorMessage });
          }
        );
      });
    } catch (error) {
      console.error('[IDE] Failed to open IDE:', error);
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