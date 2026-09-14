import { ipcMain } from 'electron';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { registerUpdaterHandlers } from './updater';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerDialogHandlers } from './dialog';
import { registerScriptHandlers } from './script';
import { registerFolderHandlers } from './folders';
import { registerUIStateHandlers } from './uiState';
import { registerDashboardHandlers } from './dashboard';
import { setupLogHandlers } from './logs';
import { registerPanelHandlers } from './panels';
import { registerClaudePanelHandlers } from './claudePanel';
import { registerEditorPanelHandlers } from './editorPanel';
import { registerNimbalystHandlers } from './nimbalyst';
import { registerCyboflowHandlers } from './cyboflow';
import { registerIdeaAttachmentHandlers } from './ideaAttachments';
import { registerTelemetryHandlers } from './telemetry';
import { registerModelHandlers } from './models';
import { registerProviderDetectionHandlers } from './providerDetection';
import { registerBugReportHandlers } from './bugReport';
import { installIpcSenderGuard, resolveSenderGuardConfig } from './senderGuard';


export function registerIpcHandlers(services: AppServices): void {
  // Sender validation goes on FIRST: it patches the ipcMain singleton, so it
  // only covers channels registered after this line. This is the earliest
  // registration in the boot sequence, which puts every `ipcMain.handle` in the
  // app — including the modules below that import ipcMain directly and the two
  // inline handlers in main/src/index.ts — behind the check. See ./senderGuard.
  installIpcSenderGuard(resolveSenderGuardConfig());

  registerAppHandlers(ipcMain, services);
  registerUpdaterHandlers(ipcMain, services);
  registerSessionHandlers(ipcMain, services);
  registerProjectHandlers(ipcMain, services);
  registerDialogHandlers(ipcMain, services);
  registerScriptHandlers(ipcMain, services);
  registerFolderHandlers(ipcMain, services);
  registerUIStateHandlers(services);
  registerDashboardHandlers(ipcMain, services);
  setupLogHandlers(services.sessionManager);
  registerPanelHandlers(ipcMain, services);
  registerClaudePanelHandlers(ipcMain, services);
  registerEditorPanelHandlers(ipcMain, services);
  registerNimbalystHandlers(ipcMain, services);
  registerCyboflowHandlers(ipcMain, services);
  registerIdeaAttachmentHandlers(ipcMain, services);
  registerTelemetryHandlers(ipcMain, services);
  registerBugReportHandlers(ipcMain, services);
  registerModelHandlers(ipcMain, services);
  registerProviderDetectionHandlers(ipcMain, services);
}
