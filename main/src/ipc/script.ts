import { IpcMain } from 'electron';
import { logsManager } from '../services/panels/logPanel/logsManager';

export function registerScriptHandlers(ipcMain: IpcMain): void {
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