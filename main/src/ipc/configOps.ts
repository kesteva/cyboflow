import type { AppServices } from './types';
import type { ConfigOpsLike, SessionCreationPreferences } from '../orchestrator/trpc/contracts/configOps';
import type { UpdateConfigRequest } from '../types/config';
import {
  isAgentProviderAccess,
  resolveAgentProviderAccess,
} from '../../../shared/types/agentRuntime';
import {
  clampSprintMaxTasks,
  type SprintMaxTasksOverrides,
} from '../../../shared/types/sprintBatch';
import {
  isBindableKeybinding,
  SHORTCUT_ACTIONS,
  type KeyboardShortcutOverrides,
} from '../../../shared/types/keyboardShortcuts';

/**
 * Concrete implementation of {@link ConfigOpsLike}, backing the `config`
 * tRPC router (routers/config.ts). Method bodies are moved verbatim from the
 * legacy `config:*` ipcMain.handle handlers (ipc/config.ts, now deleted) —
 * this file may freely import from main/src/services/*, unlike the tRPC
 * subtree itself.
 */
export function createConfigOps(
  services: Pick<AppServices, 'configManager' | 'claudeCodeManager'>,
): ConfigOpsLike {
  const { configManager, claudeCodeManager } = services;

  return {
    async getConfig() {
      try {
        const config = configManager.getConfig();
        return { success: true, data: config };
      } catch (error) {
        console.error('Failed to get config:', error);
        return { success: false, error: 'Failed to get config' };
      }
    },

    async updateConfig(updates) {
      try {
        // Check if Claude path is being updated
        const oldConfig = configManager.getConfig();
        const claudePathChanged = updates.claudeExecutablePath !== undefined &&
                                 updates.claudeExecutablePath !== oldConfig.claudeExecutablePath;

        // Defense-in-depth for the "two write channels cannot race" invariant
        // declared on UpdateConfigRequest (main/src/types/config.ts): that type
        // omits `runTypeDefaults`, but the tRPC boundary (routers/config.ts)
        // only asserts "is a plain object" and does not itself strip unknown
        // keys, so a caller whose own static type still includes the field (a
        // stale cast, a future drift on either side of the IPC boundary) would
        // reach here and clobber the whole map through this generic channel
        // instead of the dedicated config.applyRunTypeDefault mutation. Strip
        // it unconditionally rather than trusting the type system alone.
        const strippedUpdates: UpdateConfigRequest = { ...updates };
        delete (strippedUpdates as Record<string, unknown>).runTypeDefaults;

        // Validate the untyped provider-access patch at the IPC boundary: a
        // malformed shape is rejected outright, and a well-formed one is stored
        // normalized (both members explicit, never all-off) so every downstream
        // read — including a config.json edited by hand — sees the floors already
        // applied. See shared/types/agentRuntime.ts.
        if (updates.agentProviderAccess !== undefined && !isAgentProviderAccess(updates.agentProviderAccess)) {
          return { success: false, error: 'Invalid agentProviderAccess payload' };
        }
        let normalized = updates.agentProviderAccess === undefined
          ? strippedUpdates
          : { ...strippedUpdates, agentProviderAccess: resolveAgentProviderAccess(updates.agentProviderAccess) };

        // Same treatment for the sprint cap override: reject a malformed shape at
        // the boundary, and STORE the clamped map so config.json never holds a 0 or
        // a 10_000 that every reader would have to re-clamp. A member the caller
        // clears (undefined / null) drops out entirely, which is how the UI resets a
        // substrate back to its built-in default.
        if (updates.sprintMaxTasks !== undefined) {
          const patch: unknown = updates.sprintMaxTasks;
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            return { success: false, error: 'Invalid sprintMaxTasks payload' };
          }
          const raw = patch as Record<string, unknown>;
          const clean: SprintMaxTasksOverrides = {};
          for (const substrate of ['sdk', 'interactive'] as const) {
            const value = raw[substrate];
            if (value === undefined || value === null) continue;
            const clamped = clampSprintMaxTasks(value);
            if (clamped === null) {
              return { success: false, error: `Invalid sprintMaxTasks.${substrate}: expected a number` };
            }
            clean[substrate] = clamped;
          }
          normalized = { ...normalized, sprintMaxTasks: clean };
        }

        // Same treatment for the keyboard-shortcut overrides: reject a malformed
        // shape at the boundary, and iterate ONLY the known ShortcutAction keys
        // (never the caller's raw object keys) so a stray/unknown property can
        // never sneak into storage. A member the caller clears (undefined / null)
        // drops out entirely, which is how the Settings UI resets one action back
        // to its built-in default without touching the others.
        //
        // The per-member guard is isBindableKeybinding, NOT isValidKeybinding:
        // a modifier-less binding ('b', 'shift+b', 'alt+b') parses fine but is
        // unsafe to store, because the global key handler has no input guard and
        // would make that character untypeable app-wide. See
        // shared/types/keyboardShortcuts.ts.
        if (updates.keyboardShortcuts !== undefined) {
          const patch: unknown = updates.keyboardShortcuts;
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            return { success: false, error: 'Invalid keyboardShortcuts payload' };
          }
          const raw = patch as Record<string, unknown>;
          const clean: KeyboardShortcutOverrides = {};
          for (const action of SHORTCUT_ACTIONS) {
            const value = raw[action];
            if (value === undefined || value === null) continue;
            if (!isBindableKeybinding(value)) {
              return {
                success: false,
                error: `Invalid keyboardShortcuts.${action}: expected a keybinding including the 'mod' modifier and not reserved by the application menu`,
              };
            }
            clean[action] = value;
          }
          // An EMPTY cleaned map is stored as absent, not as `{}`: the map is
          // sparse by contract (main/src/types/config.ts promises config.json
          // stays byte-identical for an install that never remaps anything), and
          // every settings save sends this field. `undefined` survives the
          // shallow spread as an own key that JSON.stringify drops, so clearing
          // the last override also REMOVES the key rather than leaving `{}`.
          normalized = {
            ...normalized,
            keyboardShortcuts: Object.keys(clean).length === 0 ? undefined : clean,
          };
        }

        await configManager.updateConfig(normalized);

        // Clear Claude availability cache if the path changed
        if (claudePathChanged) {
          claudeCodeManager.clearAvailabilityCache();
          console.log('[Config] Claude executable path changed, cleared availability cache');
        }

        return { success: true };
      } catch (error) {
        console.error('Failed to update config:', error);
        return { success: false, error: 'Failed to update config' };
      }
    },

    async applyRunTypeDefault(key, op) {
      try {
        const result = await configManager.applyRunTypeDefault(key, op);
        return { success: true, data: result };
      } catch (error) {
        console.error('Failed to apply run type default:', error);
        return { success: false, error: 'Failed to apply run type default' };
      }
    },

    async getSessionPreferences() {
      try {
        const preferences = configManager.getSessionCreationPreferences();
        return { success: true, data: preferences as SessionCreationPreferences };
      } catch (error) {
        console.error('Failed to get session creation preferences:', error);
        return { success: false, error: 'Failed to get session creation preferences' };
      }
    },

    async updateSessionPreferences(preferences) {
      try {
        await configManager.updateConfig({ sessionCreationPreferences: preferences });
        return { success: true };
      } catch (error) {
        console.error('Failed to update session creation preferences:', error);
        return { success: false, error: 'Failed to update session creation preferences' };
      }
    },
  };
}
