/**
 * `AppConfig.keyboardShortcuts` — the user-remappable keyboard-shortcut
 * override map, validated at the `config:update` boundary
 * (main/src/ipc/configOps.ts). Modeled on
 * configManagerSprintMaxTasks.test.ts's coverage shape for the sibling
 * sprintMaxTasks validation block.
 *
 * What is pinned here:
 *   - the field round-trips through the REAL IPC path (config:update →
 *     config:get → a fresh initialize() off disk);
 *   - a malformed payload (non-object, or a member that isn't a valid
 *     keybinding) is rejected at the boundary instead of persisting;
 *   - a member that PARSES but carries no 'mod' modifier ('b', 'shift+b',
 *     'alt+b') is rejected too — the engine has no input guard, so storing one
 *     would make that character untypeable app-wide;
 *   - an EMPTY cleaned map is stored as ABSENT, not as `{}`, so the ordinary
 *     settings save (which always carries this field) leaves config.json
 *     byte-identical and clearing the last override removes the key;
 *   - only the six known ShortcutAction keys are ever written — a stray
 *     property in the payload is silently dropped, never persisted;
 *   - a cleared member (undefined / null) drops out, which is how the
 *     Settings UI resets one action back to its built-in default;
 *   - with the field absent, config.json stays free of the key;
 *   - main's AppConfig / UpdateConfigRequest and the frontend AppConfig
 *     mirror declare the same shape (the silent-drop class the repo's IPC
 *     type-parity rules guard against).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppServices } from '../../ipc/types';
import { createConfigOps } from '../../ipc/configOps';
import type { ConfigOpsLike } from '../../orchestrator/trpc/contracts/configOps';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';
import type { AppConfig as MainAppConfig, UpdateConfigRequest } from '../../types/config';
import type { AppConfig as FrontendAppConfig } from '../../../../frontend/src/types/config';
import { KEYBOARD_SHORTCUT_DEFAULTS } from '../../../../shared/types/keyboardShortcuts';

// --- compile-time type parity across every layer that declares the shape -----
type MainField = MainAppConfig['keyboardShortcuts'];
type FrontendField = FrontendAppConfig['keyboardShortcuts'];
type UpdateField = UpdateConfigRequest['keyboardShortcuts'];

const keyboardShortcutsParity: [MainField] extends [FrontendField]
  ? [FrontendField] extends [MainField]
    ? [MainField] extends [UpdateField]
      ? [UpdateField] extends [MainField]
        ? true
        : never
      : never
    : never
  : never = true;

function configOpsFor(manager: ConfigManager): ConfigOpsLike {
  return createConfigOps({
    configManager: manager,
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
  });
}

async function readPersisted(dir: string): Promise<{ keyboardShortcuts?: Record<string, string> }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as {
    keyboardShortcuts?: Record<string, string>;
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-shortcuts-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('AppConfig.keyboardShortcuts type parity', () => {
  it('declares the same shape on every layer that carries it', () => {
    expect(keyboardShortcutsParity).toBe(true);
  });
});

describe('configOps.updateConfig — keyboardShortcuts validation', () => {
  it('round-trips a valid override through config:update -> config:get -> a fresh load off disk', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    const updated = await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'mod+shift+n', toggleBacklog: 'mod+shift+l' },
    } satisfies UpdateConfigRequest);
    expect(updated).toEqual({ success: true });

    const fetched = (await configOps.getConfig()) as { success: boolean; data: MainAppConfig };
    expect(fetched.data.keyboardShortcuts).toEqual({
      newSession: 'mod+shift+n',
      toggleBacklog: 'mod+shift+l',
    });
    expect((await readPersisted(tempDir)).keyboardShortcuts).toEqual({
      newSession: 'mod+shift+n',
      toggleBacklog: 'mod+shift+l',
    });

    // A relaunch reads the same values (config is a plain JSON file).
    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.getConfig().keyboardShortcuts).toEqual({
      newSession: 'mod+shift+n',
      toggleBacklog: 'mod+shift+l',
    });
  });

  it('rejects a non-object payload instead of persisting it', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    const wrongType = await configOps.updateConfig({
      keyboardShortcuts: 'mod+n',
    } as unknown as UpdateConfigRequest);
    expect(wrongType).toEqual({ success: false, error: 'Invalid keyboardShortcuts payload' });

    const arrayPayload = await configOps.updateConfig({
      keyboardShortcuts: ['mod+n'],
    } as unknown as UpdateConfigRequest);
    expect(arrayPayload).toEqual({ success: false, error: 'Invalid keyboardShortcuts payload' });

    expect((await readPersisted(tempDir)).keyboardShortcuts).toBeUndefined();
  });

  it('rejects a member whose value is not a valid keybinding', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    const result = (await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'mod+shift' }, // modifier-only — no key
    } as unknown as UpdateConfigRequest)) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('keyboardShortcuts.newSession');

    expect((await readPersisted(tempDir)).keyboardShortcuts).toBeUndefined();
    expect(manager.getConfig().keyboardShortcuts).toBeUndefined();
  });

  it('rejects a modifier-less binding even though it parses', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    // A bare key would fire the action on EVERY press of that character and
    // preventDefault it — the engine has no input/textarea guard.
    const bare = (await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'b' },
    } satisfies UpdateConfigRequest)) as { success: boolean; error?: string };
    expect(bare.success).toBe(false);
    expect(bare.error).toContain('keyboardShortcuts.newSession');
    expect(bare.error).toContain('mod');

    // Shift-only is just typing a capital B.
    const shiftOnly = (await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'shift+b' },
    } satisfies UpdateConfigRequest)) as { success: boolean; error?: string };
    expect(shiftOnly.success).toBe(false);
    expect(shiftOnly.error).toContain('keyboardShortcuts.newSession');

    // Alt-only composes glyphs on macOS.
    const altOnly = (await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'alt+b' },
    } satisfies UpdateConfigRequest)) as { success: boolean; error?: string };
    expect(altOnly.success).toBe(false);

    expect((await readPersisted(tempDir)).keyboardShortcuts).toBeUndefined();
    expect(manager.getConfig().keyboardShortcuts).toBeUndefined();
  });

  it('drops a stray/unknown key from the payload instead of persisting it', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    await configOps.updateConfig({
      keyboardShortcuts: {
        newSession: 'mod+shift+n',
        notARealAction: 'mod+z',
      } as unknown as UpdateConfigRequest['keyboardShortcuts'],
    } as UpdateConfigRequest);

    expect(manager.getConfig().keyboardShortcuts).toEqual({ newSession: 'mod+shift+n' });
  });

  it('drops a cleared member so the action falls back to its built-in default', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'mod+shift+n', toggleBacklog: undefined },
    } satisfies UpdateConfigRequest);

    expect(manager.getConfig().keyboardShortcuts).toEqual({ newSession: 'mod+shift+n' });
  });

  it('an EMPTY cleaned map leaves config.json without the key (every save carries the field)', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    const result = await configOps.updateConfig({
      keyboardShortcuts: {},
    } satisfies UpdateConfigRequest);
    expect(result).toEqual({ success: true });

    const persisted = await readPersisted(tempDir);
    expect('keyboardShortcuts' in persisted).toBe(false);
    expect(manager.getConfig().keyboardShortcuts).toBeUndefined();
  });

  it('clearing the LAST override removes the key rather than leaving {}', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    await configOps.updateConfig({
      keyboardShortcuts: { newSession: 'mod+shift+n' },
    } satisfies UpdateConfigRequest);
    expect((await readPersisted(tempDir)).keyboardShortcuts).toEqual({ newSession: 'mod+shift+n' });

    // The Settings UI resets the row: the map it sends back is now empty.
    await configOps.updateConfig({ keyboardShortcuts: {} } satisfies UpdateConfigRequest);

    const persisted = await readPersisted(tempDir);
    expect('keyboardShortcuts' in persisted).toBe(false);
    expect(manager.getConfig().keyboardShortcuts).toBeUndefined();

    // …and a relaunch off disk agrees.
    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.getConfig().keyboardShortcuts).toBeUndefined();
  });

  it('with the field absent, config.json stays free of the key and the defaults hold', async () => {
    const manager = new ConfigManager();
    await manager.initialize();

    expect(manager.getConfig().keyboardShortcuts).toBeUndefined();
    expect((await readPersisted(tempDir)).keyboardShortcuts).toBeUndefined();
    expect(KEYBOARD_SHORTCUT_DEFAULTS.newSession).toBe('mod+n');
  });
});
