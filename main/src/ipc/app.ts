import { IpcMain, shell } from 'electron';
import type { AppServices } from './types';
import { getDemoSandboxPath, DEMO_PROJECT_NAME, DEMO_REMOTE_URL } from '../services/demo/demoEnvironment';

export function registerAppHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { app } = services;

  // Basic app info handlers
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('is-packaged', () => {
    return app.isPackaged;
  });

  // System utilities
  ipcMain.handle('openExternal', async (_event, url: string) => {
    try {
      // Demo mode: the sandbox's origin is a fake github.com URL (pushes go to
      // a local bare repo — see demoEnvironment.ts). Opening it would 404 in
      // the browser mid-tour, so report success without opening; the Create-PR
      // dialog proceeds exactly as if the compare page had opened.
      const demoRepoWebUrl = DEMO_REMOTE_URL.replace(/\.git$/, '');
      if (services.configManager.isDemoMode() && url.startsWith(demoRepoWebUrl)) {
        console.log('[Main] Demo mode — suppressed openExternal for fake demo repo URL:', url);
        return { success: true };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Failed to open external URL:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' };
    }
  });


  // Demo-mode tour info — the Create Project dialog prefills the sandbox repo
  // from this so the user never has to type a path during the demo.
  ipcMain.handle('demo:get-info', () => {
    const demoMode = services.configManager.isDemoMode();
    return {
      success: true,
      data: {
        demoMode,
        sandboxPath: demoMode ? getDemoSandboxPath() : null,
        projectName: DEMO_PROJECT_NAME,
      },
    };
  });

  // Relaunch the app (used by the Settings demo-mode toggle — demoMode is read
  // once at startup, so flipping it requires a fresh boot). exit(0) skips the
  // graceful before-quit drain on purpose: this is a user-requested restart,
  // mirroring how Electron docs pair relaunch() with exit().
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // App opens tracking
  ipcMain.handle('app:record-open', (_event, welcomeHidden: boolean) => {
    try {
      services.databaseService.recordAppOpen(welcomeHidden);
      return { success: true };
    } catch (error) {
      console.error('Failed to record app open:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to record app open' };
    }
  });

  ipcMain.handle('app:get-last-open', () => {
    try {
      const lastOpen = services.databaseService.getLastAppOpen();
      return { success: true, data: lastOpen };
    } catch (error) {
      console.error('Failed to get last app open:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get last app open' };
    }
  });

  // User preferences handlers
  ipcMain.handle('preferences:get', (_event, key: string) => {
    try {
      const value = services.databaseService.getUserPreference(key);
      return { success: true, data: value };
    } catch (error) {
      console.error('Failed to get preference:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get preference' };
    }
  });

  ipcMain.handle('preferences:set', (_event, key: string, value: string) => {
    try {
      services.databaseService.setUserPreference(key, value);
      return { success: true };
    } catch (error) {
      console.error('Failed to set preference:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set preference' };
    }
  });

  ipcMain.handle('preferences:get-all', () => {
    try {
      const preferences = services.databaseService.getUserPreferences();
      return { success: true, data: preferences };
    } catch (error) {
      console.error('Failed to get all preferences:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get all preferences' };
    }
  });
} 