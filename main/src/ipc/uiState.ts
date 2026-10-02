import { ipcMain } from 'electron';
import { UIStateManager } from '../services/uiStateManager';
import type { AppServices } from './types';

export function registerUIStateHandlers(services: AppServices) {
  const uiStateManager = new UIStateManager(services.databaseService);

  ipcMain.handle('ui-state:get-expanded', async () => {
    try {
      return {
        success: true,
        data: uiStateManager.getExpandedState()
      };
    } catch (error) {
      console.error('Error getting expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded', async (_, projectIds: number[]) => {
    try {
      uiStateManager.saveExpandedProjects(projectIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });
}