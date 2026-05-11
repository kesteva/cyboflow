import { IpcMain, dialog } from 'electron';
import type { AppServices } from './types';

export function registerDialogHandlers(ipcMain: IpcMain, { getMainWindow }: AppServices): void {
  ipcMain.handle('dialog:open-file', async (_event, options?: Electron.OpenDialogOptions) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const defaultOptions: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        ...options
      };

      const result = await dialog.showOpenDialog(mainWindow, defaultOptions);

      if (result.canceled) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to open file dialog:', error);
      return { success: false, error: 'Failed to open file dialog' };
    }
  });

  ipcMain.handle('dialog:open-directory', async (_event, options?: Electron.OpenDialogOptions) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const defaultOptions: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        ...options
      };

      const result = await dialog.showOpenDialog(mainWindow, defaultOptions);

      if (result.canceled) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
      return { success: false, error: 'Failed to open directory dialog' };
    }
  });
} 