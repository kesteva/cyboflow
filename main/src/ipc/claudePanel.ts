import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { ClaudePanelManager } from '../services/panels/claude/claudePanelManager';
import { ClaudeCodeManager } from '../services/panels/claude/claudeCodeManager';
import { panelManager } from '../services/panelManager';
import { isAnyEffortLevel, type ReasoningEffort } from '../../../shared/types/reasoningEffort';
import { DEFAULT_CODEX_MODEL, normalizeAgentModelSelection } from '../../../shared/types/agentModels';
import type { AgentProvider } from '../../../shared/types/agentRuntime';
import { DEFAULT_QUICK_MODEL } from '../../../shared/types/sessionDefaults';
import { providerForSession } from '../services/panelLane';

/**
 * Normalize a resolved panel model candidate to the family of the provider
 * that OWNS the panel, flooring to that provider's quick default when another
 * provider's family claims the value. Onboarding's Model step (step 3) can
 * persist a Codex catalog id into the GLOBAL `defaultLaunchModel` when Codex is
 * the chosen default runtime, and a per-panel setting can independently carry a
 * stale cross-provider id — either would otherwise surface as the panel's model
 * even though it belongs to a different provider.
 *
 * The provider is a parameter because every provider's chat rides a
 * 'claude'-typed panel and therefore reads its model through THIS handler: a
 * Codex or OMP quick session stores `gpt-5.4` / `openrouter/auto` in the same
 * panel settings, and normalizing those against Claude's family threw the
 * value away and floored to 'opus' — so the composer pill read "opus" over a
 * turn that actually ran on the stored OMP model (2026-09-11).
 *
 * The floor is per provider: Claude has a curated alias to fall to, Codex has
 * 'auto', and OMP/pi have no model flag to fall to (an omitted model means the
 * vendor's own default, which the composer renders as "Default"), so they
 * resolve to undefined rather than a value the spawn would not honor.
 */
function resolveQuickModelForProvider(provider: AgentProvider, candidate: unknown): string | undefined {
  const value = typeof candidate === 'string' ? candidate : undefined;
  const normalized = normalizeAgentModelSelection(provider, value);
  if (normalized !== undefined) return normalized;
  switch (provider) {
    case 'claude':
      return DEFAULT_QUICK_MODEL;
    case 'codex':
      return DEFAULT_CODEX_MODEL;
    default:
      return undefined;
  }
}

let claudePanelManager: ClaudePanelManager;

/**
 * The provider owning a panel's session — the family its stored model is
 * normalized against. Unknown panel / session (tests, a panel mid-delete)
 * keeps the Claude floor, matching `providerForSession`'s own default.
 */
function providerForPanel(services: AppServices, panelId: string): AgentProvider {
  const panel = panelManager.getPanel(panelId);
  const dbSession = panel ? services.sessionManager.getDbSession(panel.sessionId) : undefined;
  return providerForSession(dbSession);
}

/**
 * Re-register the persisted Claude-typed panels with the freshly built manager
 * (restoration from the database, so not user-initiated).
 */
function registerExistingClaudePanels(services: AppServices): void {
  const { databaseService, logger } = services;
  logger?.info('[Claude] Registering existing Claude panels from database...');
  const claudePanels = databaseService.getActivePanels().filter((panel) => panel.type === 'claude');
  for (const panel of claudePanels) {
    try {
      claudePanelManager.registerPanel(panel.id, panel.sessionId, undefined, false);
      logger?.info(`[Claude] Registered existing panel ${panel.id} for session ${panel.sessionId}`);
    } catch (error) {
      logger?.error(`[Claude] Failed to register existing panel ${panel.id}: ${error}`);
    }
  }
  logger?.info(`[Claude] Registered ${claudePanels.length} existing panels`);
}

export function registerClaudePanelHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { sessionManager, claudeCodeManager, databaseService, configManager, logger } = services;

  // DB injection happens at construction time via cliManagerFactory.createManager()
  // in main/src/index.ts (additionalOptions.db). No setter call required here.
  claudePanelManager = new ClaudePanelManager(
    claudeCodeManager,
    sessionManager,
    logger,
    configManager,
    services.interactiveCliManager,
    (panelId) => panelManager.getPanel(panelId)?.substrate,
  );
  registerExistingClaudePanels(services);

  // The panel's model, normalized to the family of the provider that owns the
  // panel's session (see resolveQuickModelForProvider), falling back to the
  // global quick-launch default when the panel has none stored.
  ipcMain.handle('claude-panels:get-model', async (_event, panelId: string) => {
    try {
      const settings = databaseService.getPanelSettings(panelId);
      const modelCandidate = settings.model || configManager.getDefaultLaunchModel('quick');
      return { success: true, data: resolveQuickModelForProvider(providerForPanel(services, panelId), modelCandidate) };
    } catch (error) {
      console.error('Failed to get Claude panel model:', error);
      return { success: false, error: 'Failed to get Claude panel model' };
    }
  });

  // Persist the panel's model selection in tool_panels.settings.
  ipcMain.handle('claude-panels:set-model', async (_event, panelId: string, model: string) => {
    try {
      console.log('[IPC] claude-panels:set-model called for panelId:', panelId, 'model:', model);
      
      databaseService.updatePanelSettings(panelId, { model });

      return { success: true };
    } catch (error) {
      console.error('Failed to set Claude panel model:', error);
      return { success: false, error: 'Failed to set Claude panel model' };
    }
  });

  // Set the per-panel fast-mode opt-in (quick-session launch toggle). Persisted
  // in tool_panels.settings and read by sessions:input on every respawn, where
  // it threads into buildSdkOptions' `settings.fastMode`. Default off — fast mode
  // is the premium, Opus-only research preview; see claudeCodeManager.
  ipcMain.handle('claude-panels:set-fast-mode', async (_event, panelId: string, fastMode: boolean) => {
    try {
      console.log('[IPC] claude-panels:set-fast-mode called for panelId:', panelId, 'fastMode:', fastMode);

      databaseService.updatePanelSettings(panelId, { fastMode: fastMode === true });

      return { success: true };
    } catch (error) {
      console.error('Failed to set Claude panel fast mode:', error);
      return { success: false, error: 'Failed to set Claude panel fast mode' };
    }
  });

  // Read the per-panel fast-mode opt-in so the composer toggle can reflect the
  // launch choice. Mirrors get-model; defaults to false when never set.
  ipcMain.handle('claude-panels:get-fast-mode', async (_event, panelId: string) => {
    try {
      const settings = databaseService.getPanelSettings(panelId);
      return { success: true, data: settings?.fastMode === true };
    } catch (error) {
      console.error('Failed to get Claude panel fast mode:', error);
      return { success: false, error: 'Failed to get Claude panel fast mode' };
    }
  });

  // Latest CLI-reported fast-mode state for the panel (null until a turn has
  // reported). The composer combines it with the persisted toggle to warn when
  // a requested opt-in didn't actually engage (entitlement / cooldown). Live
  // updates arrive over the 'fast-mode-state' push (events.ts); this getter is
  // the mount-time snapshot. Only the real SDK manager tracks it — the demo /
  // PTY managers report null.
  ipcMain.handle('claude-panels:get-fast-mode-state', async (_event, panelId: string) => {
    try {
      const report =
        claudeCodeManager instanceof ClaudeCodeManager ? claudeCodeManager.getFastModeReport(panelId) : null;
      return { success: true, data: report };
    } catch (error) {
      console.error('Failed to get Claude panel fast-mode state:', error);
      return { success: false, error: 'Failed to get Claude panel fast-mode state' };
    }
  });

  // Set the per-panel reasoning-effort selection (IDEA-029; wizard select / the
  // in-composer EffortPill). Persisted in tool_panels.settings and read by
  // sessions:input / panels:continue on every respawn, where it threads into
  // ClaudeSpawnOptions.reasoningEffort (→ buildSdkOptions' `sdkOptions.effort`,
  // or the Codex turn options). Mirrors claude-panels:set-fast-mode. `null`
  // clears the persisted selection back to the provider default.
  ipcMain.handle('claude-panels:set-effort', async (_event, panelId: string, effort: ReasoningEffort | null) => {
    try {
      console.log('[IPC] claude-panels:set-effort called for panelId:', panelId, 'effort:', effort);

      if (effort !== null && !isAnyEffortLevel(effort)) {
        return { success: false, error: `Invalid reasoning effort: ${String(effort)}` };
      }

      databaseService.updatePanelSettings(panelId, { reasoningEffort: effort ?? undefined });

      return { success: true };
    } catch (error) {
      console.error('Failed to set Claude panel reasoning effort:', error);
      return { success: false, error: 'Failed to set Claude panel reasoning effort' };
    }
  });

  // Read the per-panel reasoning-effort selection so the composer pill can
  // reflect the launch/last-set choice. Mirrors get-fast-mode; null when never set.
  ipcMain.handle('claude-panels:get-effort', async (_event, panelId: string) => {
    try {
      const settings = databaseService.getPanelSettings(panelId);
      const stored = settings?.reasoningEffort;
      return { success: true, data: isAnyEffortLevel(stored) ? stored : null };
    } catch (error) {
      console.error('Failed to get Claude panel reasoning effort:', error);
      return { success: false, error: 'Failed to get Claude panel reasoning effort' };
    }
  });
}

// Export the manager instance for use by other modules
export { claudePanelManager };
