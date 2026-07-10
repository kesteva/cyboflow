import { IpcMain } from 'electron';
import type { AppServices } from './types';
import {
  CLAUDE_DETECT_CHANNEL,
  type ClaudeDetectionResult,
  type ClaudeDetectionState,
} from '../../../shared/types/onboarding';
import { detectClaudeCredentials } from '../utils/claudeCredentials';
import { detectClaudeBinary } from '../utils/claudeCodeTest';

/**
 * Onboarding step-1 detection IPC — the on-demand Claude Code login/binary
 * probe. Idempotent, side-effect free, and UNCACHED: the onboarding "Check
 * again" button re-invokes CLAUDE_DETECT_CHANNEL and must see fresh results
 * after the user logs in or installs the binary.
 *
 * The overall `state` is computed HERE (main-side) so every consumer agrees on
 * the mapping (shared/types/onboarding.ts):
 *   credentials.found            → 'detected'
 *   !credentials.found && binary → 'loggedOut'
 *   neither                      → 'missing'
 */
export function computeState(credentialsFound: boolean, binaryFound: boolean): ClaudeDetectionState {
  if (credentialsFound) return 'detected';
  if (binaryFound) return 'loggedOut';
  return 'missing';
}

export function registerClaudeDetectionHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle(
    CLAUDE_DETECT_CHANNEL,
    async (): Promise<{ success: true; data: ClaudeDetectionResult }> => {
      const configuredPath = services.configManager.getConfig()?.claudeExecutablePath;
      const [credentials, binary] = await Promise.all([
        detectClaudeCredentials(),
        detectClaudeBinary(configuredPath),
      ]);
      return {
        success: true,
        data: { credentials, binary, state: computeState(credentials.found, binary.found) },
      };
    },
  );
}
