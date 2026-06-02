/**
 * Unit tests for InteractiveSettingsWriter (IDEA-013 S5 / TASK-810).
 *
 * Covers the test_strategy target:
 *   "interactiveSettingsWriter writes a merge-safe '*' PreToolUse entry with a
 *    high timeout, preserves pre-existing user keys, removes only the cyboflow
 *    entry, and skips writing under permissionMode ignore/dontAsk."
 *
 * Concretely, per the acceptance criteria:
 *   (a) empty-dir write → a valid settings.json whose hooks.PreToolUse holds a
 *       '*'-matcher entry referencing the hook script with a high timeout;
 *   (b) write into a dir with a pre-existing settings.json (permissions.allow,
 *       env, unrelated hooks) preserves ALL user keys and only adds ours;
 *   (c) remove strips ONLY the cyboflow entry and leaves user keys intact;
 *   (d) permissionMode 'ignore'/'dontAsk' → no write occurs.
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree and a fixed
 * `hookDirOverride` so the resolved hook path is deterministic (the global
 * electron mock leaves app.isPackaged undefined → the dev resolver branch).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InteractiveSettingsWriter, resolveShellHookScriptPath } from '../interactiveSettingsWriter';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveSettingsWriter', () => {
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

  // -------------------------------------------------------------------------
  // (a) empty-dir write
  // -------------------------------------------------------------------------

  describe('write into an empty worktree', () => {
    it('creates a valid settings.json with a "*" PreToolUse entry referencing the hook with a high timeout', () => {
      const installed = writer.write(worktree, { hookDirOverride: HOOK_DIR });

      expect(installed).toBe(hookPath);
      expect(fs.existsSync(settingsPath(worktree))).toBe(true);

      const settings = readSettings(worktree);
      const groups = settings.hooks?.PreToolUse ?? [];
      const cyboflow = groups.find((g) => g.matcher === '*');
      expect(cyboflow).toBeDefined();

      const cmd = cyboflow!.hooks.find((h) => h.command === hookPath);
      expect(cmd).toBeDefined();
      expect(cmd!.type).toBe('command');
      // High timeout — the hook blocks for the full human-decision window.
      expect(cmd!.timeout).toBeGreaterThanOrEqual(60 * 5);
    });

    it('is idempotent — a second write does not duplicate the cyboflow entry', () => {
      writer.write(worktree, { hookDirOverride: HOOK_DIR });
      writer.write(worktree, { hookDirOverride: HOOK_DIR });

      const groups = readSettings(worktree).hooks?.PreToolUse ?? [];
      const cyboflowGroups = groups.filter(
        (g) => g.matcher === '*' && g.hooks.some((h) => h.command === hookPath),
      );
      expect(cyboflowGroups).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // (b) merge-safety against pre-existing user keys
  // -------------------------------------------------------------------------

  describe('write into a worktree with a pre-existing user settings.json', () => {
    it('preserves ALL user keys (permissions, env, unrelated hooks) and only adds the cyboflow entry', () => {
      const userHookCmd = '/usr/local/bin/user-hook.sh';
      writeUserSettings(worktree, {
        permissions: { allow: ['Bash(git status:*)'], deny: ['Bash(rm:*)'] },
        env: { MY_VAR: 'value' },
        customTopLevel: { nested: true },
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] }],
          PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: userHookCmd }] }],
        },
      });

      writer.write(worktree, { hookDirOverride: HOOK_DIR });
      const settings = readSettings(worktree);

      // User keys untouched.
      expect(settings.permissions).toEqual({ allow: ['Bash(git status:*)'], deny: ['Bash(rm:*)'] });
      expect(settings.env).toEqual({ MY_VAR: 'value' });
      expect(settings.customTopLevel).toEqual({ nested: true });

      // User's PostToolUse hook event preserved verbatim.
      expect(settings.hooks?.PostToolUse).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] },
      ]);

      // User's existing PreToolUse 'Edit' entry preserved; ours appended.
      const preGroups = settings.hooks?.PreToolUse ?? [];
      expect(preGroups).toContainEqual({
        matcher: 'Edit',
        hooks: [{ type: 'command', command: userHookCmd }],
      });
      const ours = preGroups.find((g) => g.matcher === '*' && g.hooks.some((h) => h.command === hookPath));
      expect(ours).toBeDefined();
    });

    it('does not clobber a user "*" matcher that points at a different command', () => {
      const userStarCmd = '/usr/local/bin/user-star-hook.sh';
      writeUserSettings(worktree, {
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: userStarCmd }] }] },
      });

      writer.write(worktree, { hookDirOverride: HOOK_DIR });
      const preGroups = readSettings(worktree).hooks?.PreToolUse ?? [];

      // The user's '*' entry survives (it points elsewhere) and ours is added.
      expect(preGroups.some((g) => g.hooks.some((h) => h.command === userStarCmd))).toBe(true);
      expect(preGroups.some((g) => g.hooks.some((h) => h.command === hookPath))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // (c) remove strips only the cyboflow entry
  // -------------------------------------------------------------------------

  describe('remove', () => {
    it('strips ONLY the cyboflow entry and leaves user keys intact', () => {
      const userHookCmd = '/usr/local/bin/user-hook.sh';
      writeUserSettings(worktree, {
        permissions: { allow: ['Bash(ls:*)'] },
        env: { KEEP: 'me' },
        hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: userHookCmd }] }] },
      });
      writer.write(worktree, { hookDirOverride: HOOK_DIR });

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

    it('prunes an empty PreToolUse container when only the cyboflow entry was present, preserving sibling hook events', () => {
      const userHookCmd = '/usr/local/bin/user-post-hook.sh';
      writeUserSettings(worktree, {
        env: { KEEP: 'me' },
        hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] }] },
      });
      writer.write(worktree, { hookDirOverride: HOOK_DIR });

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
  });

  // -------------------------------------------------------------------------
  // (d) permissionMode ignore/dontAsk skips the write
  // -------------------------------------------------------------------------

  describe('permissionMode skip', () => {
    it('skips writing under permissionMode "ignore" (no file created)', () => {
      const result = writer.write(worktree, { permissionMode: 'ignore', hookDirOverride: HOOK_DIR });
      expect(result).toBeNull();
      expect(fs.existsSync(settingsPath(worktree))).toBe(false);
    });

    it('skips writing under permissionMode "dontAsk" (no file created)', () => {
      const result = writer.write(worktree, { permissionMode: 'dontAsk', hookDirOverride: HOOK_DIR });
      expect(result).toBeNull();
      expect(fs.existsSync(settingsPath(worktree))).toBe(false);
    });

    it('does NOT mutate a pre-existing user settings file under "ignore"', () => {
      writeUserSettings(worktree, { permissions: { allow: ['Bash(ls:*)'] } });
      const before = fs.readFileSync(settingsPath(worktree), 'utf8');

      writer.write(worktree, { permissionMode: 'ignore', hookDirOverride: HOOK_DIR });

      expect(fs.readFileSync(settingsPath(worktree), 'utf8')).toBe(before);
    });
  });
});
