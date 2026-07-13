import type { IpcMain } from 'electron';
import {
  CODEX_DETECT_CHANNEL,
  type CodexDetectionResult,
} from '../../../shared/types/onboarding';
import type { AppServices } from './types';

/** Register the short-lived Codex app-server account probe used by onboarding. */
export function registerCodexDetectionHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle(
    CODEX_DETECT_CHANNEL,
    async (): Promise<{ success: true; data: CodexDetectionResult }> => ({
      success: true,
      data: await services.codexSdkManager.detectChatGptAccount(),
    }),
  );
}
