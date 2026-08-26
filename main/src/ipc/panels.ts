import { IpcMain, BrowserWindow } from 'electron';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { databaseService } from '../services/database';
import { CreatePanelRequest, PanelEventType, ToolPanel, BaseAIPanelState, hasCwdString } from '../../../shared/types/panels';
import type { AppServices } from './types';
import { relayOrSpawnPtyPanel } from './ptyPanelDispatch';
import { nonClaudeLaneOwner, resolvePanelLane, type PanelLane } from '../services/panelLane';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';

/**
 * Resolve the working directory for a terminal panel in priority order:
 *   1. panel.state.customState.cwd   (persisted from a previous init or panel create)
 *   2. optionsCwd                    (caller-supplied at init time)
 *   3. process.cwd()                 (last-resort fallback)
 */
function resolveTerminalCwd(panel: ToolPanel, optionsCwd?: string): string {
  if (hasCwdString(panel.state.customState)) {
    return panel.state.customState.cwd;
  }
  if (typeof optionsCwd === 'string' && optionsCwd.length > 0) {
    return optionsCwd;
  }
  return process.cwd();
}

export function registerPanelHandlers(ipcMain: IpcMain, services: AppServices) {
  /**
   * The manager that actually owns a live Codex/OMP panel — undefined for the
   * two Claude lanes (those stay owned by claudePanelManager below).
   *
   * Every agent panel, whatever its provider, keeps the legacy `type: 'claude'`
   * panel row and registers into `claudePanelManager` at create time (see
   * panels:create below). But `ClaudePanelManager.getCliManager` only ever
   * resolves the two CLAUDE substrates — it has no notion of Codex/OMP — so a
   * panel whose actual (provider × substrate) lane is Codex or OMP was never
   * reachable through claudePanelManager.stopPanel/isPanelRunning at all: those
   * calls silently missed it (wrong manager, panel id not found there), and
   * panels:delete leaked the live process. Dispatch by the panel's real lane
   * instead.
   */
  const laneOwner = (lane: PanelLane): AbstractCliManager | undefined =>
    nonClaudeLaneOwner<AbstractCliManager | undefined>(lane, {
      'codex-sdk': services.codexSdkManager,
      'codex-pty': services.codexPtyManager,
      'omp-sdk': services.ompSdkManager,
      'omp-pty': services.ompPtyManager,
      'pi-sdk': services.piSdkManager,
      'pi-pty': services.piPtyManager,
     });

  // Panel CRUD operations
  ipcMain.handle('panels:create', async (_, request: CreatePanelRequest) => {
    try {
      const panel = await panelManager.createPanel(request);

      // Auto-register Claude panels so they're hooked to the Claude runtime
      if (panel.type === 'claude') {
        try {
          const { claudePanelManager } = require('./claudePanel');
          if (claudePanelManager) {
            claudePanelManager.registerPanel(panel.id, panel.sessionId, panel.state.customState);
          } else {
            console.warn('[Panels IPC] ClaudePanelManager not initialized yet; will register later');
          }
        } catch (err) {
          console.error('[Panels IPC] Failed to register Claude panel with ClaudePanelManager:', err);
        }

        // EAGER PTY SPAWN for an ADDED PTY-backed chat panel ("Add chat" whose
        // effective substrate resolves to interactive Claude or Codex PTY). This
        // IPC path fires only for FRONTEND-created panels — a quick session's
        // PRIMARY panel is created server-side by sessions:create-quick and is
        // never routed here — so it is exactly the added-panel case. Without it an
        // added PTY panel would have NO live REPL of its own: direct xterm
        // keystrokes (relayInput, panelId-keyed) would no-op and the composer
        // would misroute to the session's first panel. Mirrors the create-quick
        // eager spawn, keyed by THIS panel's own id. Fire-and-forget + fail-soft;
        // a no-op (returns false) for SDK/demo panels.
        void relayOrSpawnPtyPanel(services, panel, null).catch((err: unknown) => {
          console.error('[Panels IPC] Eager PTY spawn for added panel failed:', err);
        });
      }

      return { success: true, data: panel };
    } catch (error) {
      console.error('[IPC] Failed to create panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:delete', async (_, panelId: string) => {
    try {
      // Clean up terminal process if it's a terminal panel
      const panel = panelManager.getPanel(panelId);
      // Stop + unregister an agent panel, routed by its ACTUAL lane — see
      // laneOwner above for why a substrate-only lookup used to leak a live
      // Codex/OMP panel's process. The claudePanelManager require stays
      // SCOPED to the branches that actually need it (mirrors the original
      // fail-soft shape: a require failure here must never block the
      // nonClaudeOwner stop, or the panelManager.deletePanel below).
      if (panel?.type === 'claude') {
        const lane = resolvePanelLane(databaseService.getSession(panel.sessionId), panel);
        const nonClaudeOwner = laneOwner(lane);
        // An omp-fleet panel is a 'claude' panel whose work lives on a REMOTE
        // worker, so claudePanelManager.isPanelRunning is false for it and the
        // stop below never fires. Closing the tab would leave the worker alive
        // AND leave its poll timer emitting into a deleted panel, where
        // addPanelOutput throws 'Panel not found' on every tick. stopPanel is a
        // no-op for a panel the fleet manager doesn't track, so this is safe to
        // call unconditionally — no runtime lookup needed.

        try {
          await services.ompSessionManager?.stopPanel(panelId);
        } catch (err) {
          console.warn('[Panels IPC] Failed to stop OMP fleet worker during delete:', err);
        }
        try {
          if (nonClaudeOwner) {
            if (nonClaudeOwner.isPanelRunning(panelId)) {
              await nonClaudeOwner.stopPanel(panelId);
            }
          } else {
            const { claudePanelManager } = require('./claudePanel');
            if (claudePanelManager?.isPanelRunning(panelId)) {
              await claudePanelManager.stopPanel(panelId);
            }
          }
        } catch (err) {
          console.warn('[Panels IPC] Failed to stop panel during delete:', err);
        }
        // claudePanelManager registers EVERY agent panel at create time
        // regardless of lane (panels:create above), so its own bookkeeping
        // must be cleared even when a different manager owned the live process.
        try {
          const { claudePanelManager } = require('./claudePanel');
          claudePanelManager?.unregisterPanel(panelId);
        } catch (err) {
          console.warn('[Panels IPC] Failed to unregister Claude panel during delete:', err);
        }
      }
      if (panel?.type === 'terminal') {
        terminalPanelManager.destroyTerminal(panelId);
      }
      
      await panelManager.deletePanel(panelId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to delete panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:update', async (_, panelId: string, updates: Partial<ToolPanel>) => {
    try {
      const result = await panelManager.updatePanel(panelId, updates);
      return { success: true, data: result };
    } catch (error) {
      console.error('[IPC] Failed to update panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:list', async (_, sessionId: string) => {
    try {
      const panels = panelManager.getPanelsForSession(sessionId);
      return { success: true, data: panels };
    } catch (error) {
      console.error('[IPC] Failed to list panels:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:set-active', async (_, sessionId: string, panelId: string) => {
    try {
      await panelManager.setActivePanel(sessionId, panelId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to set active panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:getActive', async (_, sessionId: string) => {
    return databaseService.getActivePanel(sessionId);
  });
  
  // Panel initialization (lazy loading)
  ipcMain.handle('panels:initialize', async (_, panelId: string, options?: { cwd?: string; sessionId?: string }) => {
    
    const panel = panelManager.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel ${panelId} not found`);
    }
    
    // Mark panel as viewed
    if (!panel.state.hasBeenViewed) {
      panel.state.hasBeenViewed = true;
      await panelManager.updatePanel(panelId, { state: panel.state });
    }
    
    // Initialize based on panel type
    if (panel.type === 'terminal') {
      const resolvedCwd = resolveTerminalCwd(panel, options?.cwd);

      // Persist resolvedCwd into customState.cwd BEFORE spawning the PTY so the
      // panel record has a stable source of truth (used by the breadcrumb header
      // in TASK-659 and by any re-initialization path).
      if (!hasCwdString(panel.state.customState)) {
        const existingCustomState = panel.state.customState ?? {};
        const nextCustomState = {
          ...(typeof existingCustomState === 'object' && existingCustomState !== null
            ? existingCustomState
            : {}),
          cwd: resolvedCwd,
        };
        await panelManager.updatePanel(panel.id, {
          state: { ...panel.state, customState: nextCustomState },
        });
      }

      await terminalPanelManager.initializeTerminal(panel, resolvedCwd);
    }
    
    return true;
  });
  
  ipcMain.handle('panels:checkInitialized', async (_, panelId: string) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;
    
    if (panel.type === 'terminal') {
      return terminalPanelManager.isTerminalInitialized(panelId);
    }
    
    if (panel.type === 'diff') {
      // Diff panels don't have background processes, so they're always "initialized"
      return true;
    }
    
    if (panel.type === 'claude') {
      const customState = panel.state.customState as { isInitialized?: boolean } | undefined;
      return customState?.isInitialized || false;
    }
    
    // Editor panels don't need initialization
    if (panel.type === 'editor') {
      return true;
    }
    
    return false;
  });
  
  // Event handlers
  ipcMain.handle('panels:emitEvent', async (_, panelId: string, eventType: PanelEventType, data: unknown) => {
    return panelManager.emitPanelEvent(panelId, eventType, data);
  });

  // Clear unviewed content flag for AI panels
  ipcMain.handle('panels:clearUnviewedContent', async (event, panelId: string) => {
    try {
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      // Only applicable to AI panels
      if (panel.type !== 'claude') {
        return { success: true };
      }

      const customState = (panel.state.customState as BaseAIPanelState | undefined) ?? {};

      // Clear unviewed content flag and reset status if it was completed_unviewed
      const nextCustomState: BaseAIPanelState = {
        ...customState,
        hasUnviewedContent: false,
        panelStatus: customState.panelStatus === 'completed_unviewed' ? 'stopped' : customState.panelStatus,
        lastActivityTime: new Date().toISOString()
      };

      const nextPanelState = {
        ...panel.state,
        customState: nextCustomState
      };

      await panelManager.updatePanel(panelId, { state: nextPanelState });

      // Notify frontend of the update
      const webContents = event.sender;
      if (webContents && !webContents.isDestroyed()) {
        try {
          webContents.send('panel:updated', {
            ...panel,
            state: nextPanelState
          });
        } catch (ipcError) {
          console.error(`[Panels IPC] Failed to send panel:updated event for panel ${panelId}:`, ipcError);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to clear unviewed content:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  // Panel-specific terminal handlers (called via panels: namespace from frontend)
  ipcMain.handle('panels:resize-terminal', async (_, panelId: string, cols: number, rows: number) => {
    try {
      await terminalPanelManager.resizeTerminal(panelId, cols, rows);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to resize terminal:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:send-terminal-input', async (_, panelId: string, data: string) => {
    try {
      await terminalPanelManager.writeToTerminal(panelId, data);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to send terminal input:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  // Note: Panel output handlers (get-output, get-conversation-messages, get-json-messages, get-prompts, continue)
  // are implemented in session.ts as they need access to sessionManager methods
  
  // Terminal-specific handlers (internal use)
  ipcMain.handle('terminal:input', async (_, panelId: string, data: string) => {
    return terminalPanelManager.writeToTerminal(panelId, data);
  });
  
  ipcMain.handle('terminal:resize', async (_, panelId: string, cols: number, rows: number) => {
    return terminalPanelManager.resizeTerminal(panelId, cols, rows);
  });
  
  ipcMain.handle('terminal:getState', async (_, panelId: string) => {
    return terminalPanelManager.getTerminalState(panelId);
  });
  
  ipcMain.handle('terminal:saveState', async (_, panelId: string) => {
    return terminalPanelManager.saveTerminalState(panelId);
  });
}
