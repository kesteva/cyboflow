/**
 * Unit tests for the interactive gating-hook module (IDEA-013 S5 / TASK-810;
 * delivery mechanism revised to inline `--settings` for in-place sessions).
 *
 * Two units under contract:
 *
 *   resolveInlineGatingHooks — builds the `hooks` settings fragment the manager
 *   folds into its inline `--settings '<json>'` flag. Gating modes
 *   (undefined/'approve'/'default'/'acceptEdits') yield a '*'-matcher entry
 *   referencing the hook script with the high human-decision timeout; opt-out
 *   modes ('ignore'/'dontAsk'/'auto') yield null. It never touches the
 *   filesystem beyond the chmod self-heal on the hook script itself.
 *
 *   InteractiveSettingsWriter.remove — strips the LEGACY on-disk entry older
 *   builds wrote into `<worktree>/.claude/settings.json`, merge-safe (user keys
 *   preserved), matching by exact resolved path OR the cyboflow-unique hook
 *   filename suffix (so entries from a different build variant still match).
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree and a fixed
 * `hookDirOverride` so the resolved hook path is deterministic (the global
 * electron mock leaves app.isPackaged undefined → the dev resolver branch).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InteractiveSettingsWriter,
  resolveInlineGatingHooks,
  resolveShellHookScriptPath,
} from '../interactiveSettingsWriter';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_DIR = '/fake/dist/orchestrator/shellHooks';

interface HookCommandEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}
interface Settings {
  hooks?: { PreToolUse?: HookMatcherGroup[]; [k: string]: HookMatcherGroup[] | undefined };
  permissions?: { allow?: string[]; deny?: string[] };
  env?: Record<string, string>;
  [k: string]: unknown;
}

function makeWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-settings-${process.pid}-`));
}

function settingsPath(worktree: string): string {
  return path.join(worktree, '.claude', 'settings.json');
}

function readSettings(worktree: string): Settings {
  return JSON.parse(fs.readFileSync(settingsPath(worktree), 'utf8')) as Settings;
}

function writeUserSettings(worktree: string, settings: Settings): void {
  fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
  fs.writeFileSync(settingsPath(worktree), JSON.stringify(settings, null, 2), 'utf8');
}

/** The cyboflow entry exactly as legacy builds wrote it on disk. */
function legacyCyboflowGroup(command: string): HookMatcherGroup {
  return { matcher: '*', hooks: [{ type: 'command', command, timeout: 86_400 }] };
}

// ---------------------------------------------------------------------------
// resolveInlineGatingHooks — the inline `--settings` fragment builder
// ---------------------------------------------------------------------------

describe('resolveInlineGatingHooks', () => {
  const hookPath = resolveShellHookScriptPath(HOOK_DIR);

  it.each([undefined, 'approve', 'default', 'acceptEdits'] as const)(
    'gating mode %s → a "*" PreToolUse fragment referencing the hook script with the high timeout',
    (permissionMode) => {
      const fragment = resolveInlineGatingHooks(
        { permissionMode, hookDirOverride: HOOK_DIR },
        makeSpyLogger(),
      );

      expect(fragment).not.toBeNull();
      expect(fragment!.PreToolUse).toHaveLength(1);
      const group = fragment!.PreToolUse[0];
      expect(group.matcher).toBe('*');
      expect(group.hooks).toEqual([{ type: 'command', command: hookPath, timeout: 86_400 }]);
    },
  );

  it.each(['ignore', 'dontAsk', 'auto'] as const)(
    'opt-out mode %s → null (no gate; native/opted-out gating owns the decision)',
    (permissionMode) => {
      const fragment = resolveInlineGatingHooks(
        { permissionMode, hookDirOverride: HOOK_DIR },
        makeSpyLogger(),
      );
      expect(fragment).toBeNull();
    },
  );

  it('never creates a settings file in any worktree (inline-only delivery)', () => {
    const worktree = makeWorktree();
    try {
      resolveInlineGatingHooks({ hookDirOverride: HOOK_DIR }, makeSpyLogger());
      expect(fs.existsSync(settingsPath(worktree))).toBe(false);
      expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('logs the opt-out diagnostic through the provided logger', () => {
    const logger = makeSpyLogger();
    resolveInlineGatingHooks({ permissionMode: 'auto', hookDirOverride: HOOK_DIR }, logger);
    expect(
      logger.calls.some((c) => c.level === 'debug' && c.message.includes('opts out of gating')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// InteractiveSettingsWriter.remove — legacy on-disk entry strip
// ---------------------------------------------------------------------------

describe('InteractiveSettingsWriter.remove', () => {
  let worktree: string;
  let writer: InteractiveSettingsWriter;
  const hookPath = resolveShellHookScriptPath(HOOK_DIR);

  beforeEach(() => {
    worktree = makeWorktree();
    writer = new InteractiveSettingsWriter(makeSpyLogger());
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('strips ONLY the cyboflow entry and leaves user keys intact', () => {
    const userHookCmd = '/usr/local/bin/user-hook.sh';
    writeUserSettings(worktree, {
      permissions: { allow: ['Bash(ls:*)'] },
      env: { KEEP: 'me' },
      hooks: {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: userHookCmd }] },
          legacyCyboflowGroup(hookPath),
        ],
      },
    });

    writer.remove(worktree, { hookDirOverride: HOOK_DIR });
    const settings = readSettings(worktree);

    // Our entry is gone.
    const preGroups = settings.hooks?.PreToolUse ?? [];
    expect(preGroups.some((g) => g.hooks.some((h) => h.command === hookPath))).toBe(false);

    // User keys + the user's PreToolUse entry survive.
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.env).toEqual({ KEEP: 'me' });
    expect(preGroups).toContainEqual({
      matcher: 'Edit',
      hooks: [{ type: 'command', command: userHookCmd }],
    });
  });

  it('strips a legacy entry written by a DIFFERENT build variant (matched by hook-filename suffix)', () => {
    // A packaged build's asar-unpacked absolute path — nothing like this test's
    // dev-resolved hookPath, but the same trailing filename.
    const packagedPath =
      '/Applications/Cyboflow.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/shellHooks/preToolUseShellHook.js';
    writeUserSettings(worktree, {
      hooks: { PreToolUse: [legacyCyboflowGroup(packagedPath)] },
    });

    writer.remove(worktree, { hookDirOverride: HOOK_DIR });

    const settings = readSettings(worktree);
    expect(settings.hooks?.PreToolUse).toBeUndefined();
  });

  it('does NOT strip a user "*" matcher pointing at a different (non-cyboflow) command', () => {
    const userStarCmd = '/usr/local/bin/user-star-hook.sh';
    writeUserSettings(worktree, {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: userStarCmd }] },
          legacyCyboflowGroup(hookPath),
        ],
      },
    });

    writer.remove(worktree, { hookDirOverride: HOOK_DIR });
    const preGroups = readSettings(worktree).hooks?.PreToolUse ?? [];

    expect(preGroups.some((g) => g.hooks.some((h) => h.command === userStarCmd))).toBe(true);
    expect(preGroups.some((g) => g.hooks.some((h) => h.command === hookPath))).toBe(false);
  });

  it('prunes an empty PreToolUse container when only the cyboflow entry was present, preserving sibling hook events', () => {
    const userHookCmd = '/usr/local/bin/user-post-hook.sh';
    writeUserSettings(worktree, {
      env: { KEEP: 'me' },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] }],
        PreToolUse: [legacyCyboflowGroup(hookPath)],
      },
    });

    writer.remove(worktree, { hookDirOverride: HOOK_DIR });
    const settings = readSettings(worktree);

    // PreToolUse pruned (it held only ours); PostToolUse + env preserved.
    expect(settings.hooks?.PreToolUse).toBeUndefined();
    expect(settings.hooks?.PostToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] },
    ]);
    expect(settings.env).toEqual({ KEEP: 'me' });
  });

  it('is a no-op when no settings file exists', () => {
    expect(() => writer.remove(worktree, { hookDirOverride: HOOK_DIR })).not.toThrow();
    expect(fs.existsSync(settingsPath(worktree))).toBe(false);
  });

  it('does NOT rewrite the file when no cyboflow entry is present (byte-identical)', () => {
    writeUserSettings(worktree, { permissions: { allow: ['Bash(ls:*)'] } });
    const before = fs.readFileSync(settingsPath(worktree), 'utf8');

    writer.remove(worktree, { hookDirOverride: HOOK_DIR });

    expect(fs.readFileSync(settingsPath(worktree), 'utf8')).toBe(before);
  });
});
