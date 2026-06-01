import { IpcMain } from 'electron';
import type { AppServices } from './types';
import * as fs from 'fs';
import * as path from 'path';
import { commandExecutor } from '../utils/commandExecutor';
import { getCurrentWorktreeName } from '../utils/worktreeUtils';
import { getCyboflowDirectory } from '../utils/cyboflowDirectory';

export function registerUpdaterHandlers(ipcMain: IpcMain, { app }: AppServices): void {
  ipcMain.handle('version:get-info', () => {
    try {
      console.log('🚀 [WORKTREE DEBUG] version:get-info called - NEW BUILD!');
      console.log('🚀 [WORKTREE DEBUG] app.isPackaged:', app.isPackaged);
      console.log('🚀 [WORKTREE DEBUG] process.cwd():', process.cwd());
      
      let buildDate: string | undefined;
      let gitCommit: string | undefined;
      let buildTimestamp: number | undefined;
      let worktreeName: string | undefined;
      
      // Try to read build info if in packaged app
      if (app.isPackaged) {
        try {
          const buildInfoPath = path.join(process.resourcesPath, 'app', 'main', 'dist', 'buildInfo.json');
          if (fs.existsSync(buildInfoPath)) {
            const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
            buildDate = buildInfo.buildDate;
            gitCommit = buildInfo.gitCommit;
            buildTimestamp = buildInfo.buildTimestamp;
          }
        } catch (err) {
          console.log('Could not read build info:', err);
        }
      }

      // For development builds, try to get git commit hash dynamically
      if (!app.isPackaged) {
        console.log('[Version Debug] Development mode detected, getting git info...');
        try {
          const gitHash = commandExecutor.execSync('git rev-parse --short HEAD', { 
            encoding: 'utf8',
            cwd: process.cwd()
          }).trim();
          
          // Check if the working directory is clean (no uncommitted changes)
          try {
            interface ExtendedExecOptions {
              encoding: 'utf8';
              cwd: string;
              silent?: boolean;
            }
            commandExecutor.execSync('git diff-index --quiet HEAD --', { 
              encoding: 'utf8',
              cwd: process.cwd(),
              silent: true
            } as ExtendedExecOptions);
            gitCommit = gitHash;
          } catch {
            // Working directory has uncommitted changes
            gitCommit = `${gitHash} (modified)`;
          }
          console.log('[Version Debug] Git commit:', gitCommit);
        } catch (err) {
          console.log('Could not get git commit:', err);
          gitCommit = 'unknown';
        }

        // Detect current worktree name for development builds only
        worktreeName = getCurrentWorktreeName(process.cwd());
        console.log('[Version Debug] Worktree name:', worktreeName);
      }

      const responseData: {
        current: string;
        name: string;
        workingDirectory: string;
        cyboflowDirectory: string;
        buildDate?: string;
        gitCommit?: string;
        buildTimestamp?: number;
        worktreeName?: string;
      } = {
        current: app.getVersion(),
        name: app.getName(),
        workingDirectory: process.cwd(),
        cyboflowDirectory: getCyboflowDirectory(),
        buildDate,
        gitCommit,
        buildTimestamp
      };

      // Only include worktreeName in development builds and when defined
      if (!app.isPackaged && worktreeName) {
        responseData.worktreeName = worktreeName;
        console.log('[Version Debug] Adding worktreeName to response:', worktreeName);
      } else {
        console.log('[Version Debug] Not adding worktreeName. isPackaged:', app.isPackaged, 'worktreeName:', worktreeName);
      }

      console.log('[Version Debug] Final response data:', responseData);
      return {
        success: true,
        data: responseData
      };
    } catch (error) {
      console.error('Failed to get version info:', error);
      return { success: false, error: 'Failed to get version info' };
    }
  });

} 