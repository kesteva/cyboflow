import { IpcMain } from 'electron';
import type { AppServices } from './types';

export function registerPromptHandlers(ipcMain: IpcMain, { sessionManager }: AppServices): void {
  ipcMain.handle('sessions:get-prompts', async (_event, sessionId: string) => {
    try {
      const prompts = sessionManager.getSessionPrompts(sessionId);
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get session prompts:', error);
      return { success: false, error: 'Failed to get session prompts' };
    }
  });

  // Prompts handlers
  ipcMain.handle('prompts:get-all', async () => {
    try {
      const prompts = sessionManager.getPromptHistory();
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get prompts:', error);
      return { success: false, error: 'Failed to get prompts' };
    }
  });

} 