import { IpcMain } from 'electron';
import type { AppServices } from './types';

export function registerStravuHandlers(ipcMain: IpcMain, { stravuAuthManager, stravuNotebookService }: AppServices): void {
  // Stravu OAuth integration handlers
  ipcMain.handle('stravu:get-connection-status', async () => {
    try {
      const connectionState = stravuAuthManager.getConnectionState();
      return { success: true, data: connectionState };
    } catch (error) {
      console.error('Failed to get Stravu connection status:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get connection status' };
    }
  });

  ipcMain.handle('stravu:initiate-auth', async () => {
    try {
      const result = await stravuAuthManager.authenticate();
      return {
        success: true,
        data: {
          authUrl: stravuAuthManager.getCurrentSession()?.authUrl,
          sessionId: stravuAuthManager.getCurrentSession()?.sessionId
        }
      };
    } catch (error) {
      console.error('Failed to initiate Stravu authentication:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to initiate authentication' };
    }
  });

  ipcMain.handle('stravu:check-auth-status', async (_event, sessionId: string) => {
    try {
      const result = await stravuAuthManager.pollForCompletion(sessionId);

      if (result.status === 'pending') {
        return { success: true, data: { status: 'pending' } };
      } else {
        return {
          success: true,
          data: {
            status: 'completed',
            memberInfo: {
              memberId: result.memberId || '',
              orgSlug: result.orgSlug || '',
              scopes: result.scopes || []
            }
          }
        };
      }
    } catch (error) {
      console.error('Failed to check Stravu auth status:', error);
      return {
        success: true,
        data: {
          status: 'error',
          error: error instanceof Error ? error.message : 'Authentication failed'
        }
      };
    }
  });

  ipcMain.handle('stravu:disconnect', async () => {
    try {
      await stravuAuthManager.disconnect();
      stravuNotebookService.clearCache();
      return { success: true };
    } catch (error) {
      console.error('Failed to disconnect from Stravu:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to disconnect' };
    }
  });

  ipcMain.handle('stravu:get-notebooks', async () => {
    try {
      if (!stravuAuthManager.isConnected()) {
        return { success: false, error: 'Not connected to Stravu' };
      }

      const notebooks = await stravuNotebookService.getNotebooks();
      return { success: true, data: notebooks };
    } catch (error) {
      console.error('Failed to get Stravu notebooks:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get notebooks' };
    }
  });

  ipcMain.handle('stravu:get-notebook', async (_event, notebookId: string) => {
    try {
      if (!stravuAuthManager.isConnected()) {
        return { success: false, error: 'Not connected to Stravu' };
      }

      const notebook = await stravuNotebookService.getNotebookContent(notebookId);
      return { success: true, data: notebook };
    } catch (error) {
      console.error('Failed to get Stravu notebook:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get notebook' };
    }
  });

  ipcMain.handle('stravu:search-notebooks', async (_event, query: string, limit?: number) => {
    try {
      if (!stravuAuthManager.isConnected()) {
        return { success: false, error: 'Not connected to Stravu' };
      }

      const results = await stravuNotebookService.searchNotebooks(query, limit);
      return { success: true, data: results };
    } catch (error) {
      console.error('Failed to search Stravu notebooks:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to search notebooks' };
    }
  });
} 