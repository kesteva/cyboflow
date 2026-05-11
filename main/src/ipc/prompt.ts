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

  ipcMain.handle('prompts:get-by-id', async (_event, promptId: string) => {
    try {
      const promptMarker = sessionManager.getPromptById(promptId);
      return { success: true, data: promptMarker };
    } catch (error) {
      console.error('Failed to get prompt by id:', error);
      return { success: false, error: 'Failed to get prompt by id' };
    }
  });
} 