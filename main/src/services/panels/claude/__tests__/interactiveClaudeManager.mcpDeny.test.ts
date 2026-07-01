/**
 * Per-session MCP-deny + plugin-allow enforcement on the INTERACTIVE (PTY)
 * substrate — buildCommandArgs unit tests (SDK parity for
 * sessions.disabled_mcp_servers_json / enabled_plugins_json, migration 039).
 *
 * Mirrors the harness in interactiveClaudeManager.test.ts: a TestableInteractive-
 * ClaudeManager subclass exposing buildCommandArgs, constructed with a fake
 * sessionManager whose getDbSession returns a row carrying the deny/allow columns.
 *
 * Covers:
 *  (i)   disabled_mcp_servers_json → `--disallowed-tools mcp__<srv>` BEFORE `--settings`;
 *  (ii)  a denied list that includes 'cyboflow' never emits `mcp__cyboflow`;
 *  (iii) no deny column → no `--disallowed-tools`;
 *  (iv)  enabled_plugins_json → the `--settings` JSON's enabledPlugins map
 *        (additive fallback with no catalogue; EXCLUSIVE map when installed set known);
 *  (v)   no plugins column → the `--settings` JSON has no enabledPlugins key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeRawEventsDb } from '../../../../orchestrator/__test_fixtures__/rawEvents';
import { InteractiveClaudeManager } from '../interactiveClaudeManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConfigManager } from '../../../configManager';

// ---------------------------------------------------------------------------
// Testable subclass — exposes the protected buildCommandArgs for direct calls.
// ---------------------------------------------------------------------------
class TestableInteractiveClaudeManager extends InteractiveClaudeManager {
  /** Test-controlled installed-plugin universe for the exclusive enabledPlugins map. */
  public installedPluginIdsStub: string[] = [];
  protected override getInstalledPluginIds(): string[] {
    return this.installedPluginIdsStub;
  }

  callBuildCommandArgs(options: Record<string, unknown>): string[] {
    return (this as unknown as { buildCommandArgs(o: Record<string, unknown>): string[] }).buildCommandArgs(options);
  }
}

/** A DB session row shape carrying the migration-039 deny/allow columns. */
interface FakeSessionRow {
  disabled_mcp_servers_json?: string;
  enabled_plugins_json?: string;
}

function createMockSessionManager(row?: FakeSessionRow): SessionManager {
  return {
    getDbSession: vi.fn(() => row),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    db: { updateSession: vi.fn() },
  } as unknown as SessionManager;
}

function createMockConfigManager(): ConfigManager {
  return {
    getConfig: vi.fn(() => ({})),
    getDefaultAgentPermissionMode: vi.fn(() => undefined),
  } as unknown as ConfigManager;
}

function createLoggerSpy(): { verbose: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { verbose: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeManager(row?: FakeSessionRow, db?: Database.Database, installed: string[] = []): TestableInteractiveClaudeManager {
  const mgr = new TestableInteractiveClaudeManager(
    createMockSessionManager(row),
    createLoggerSpy() as unknown as import('../../../../utils/logger').Logger,
    createMockConfigManager(),
    db as Database.Database,
  );
  mgr.installedPluginIdsStub = installed;
  return mgr;
}

const baseOpts = { panelId: 'p1', sessionId: 's1', worktreePath: '/tmp/wt', prompt: 'hi' };

describe('InteractiveClaudeManager — per-session MCP deny / plugin allow in buildCommandArgs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeRawEventsDb();
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  // (i)
  it('emits --disallowed-tools mcp__<srv> for each denied server, BEFORE --settings', () => {
    const mgr = makeManager({ disabled_mcp_servers_json: JSON.stringify(['playwright', 'maestro']) }, db);
    const args = mgr.callBuildCommandArgs(baseOpts);

    expect(args).toContain('--disallowed-tools');
    expect(args).toContain('mcp__playwright');
    expect(args).toContain('mcp__maestro');

    // Ordering: --disallowed-tools + its variadic values MUST precede --settings so
    // the following --settings flag terminates the variadic <tools...> collection.
    const disallowIdx = args.indexOf('--disallowed-tools');
    const settingsIdx = args.indexOf('--settings');
    expect(disallowIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(disallowIdx).toBeLessThan(settingsIdx);
    // The tool values sit between the flag and --settings.
    expect(args.indexOf('mcp__playwright')).toBeLessThan(settingsIdx);
    expect(args.indexOf('mcp__maestro')).toBeLessThan(settingsIdx);
  });

  // (ii)
  it("never emits mcp__cyboflow even when the deny list includes 'cyboflow'", () => {
    const mgr = makeManager({ disabled_mcp_servers_json: JSON.stringify(['cyboflow', 'playwright']) }, db);
    const args = mgr.callBuildCommandArgs(baseOpts);

    expect(args).toContain('--disallowed-tools');
    expect(args).toContain('mcp__playwright');
    expect(args).not.toContain('mcp__cyboflow');
  });

  it("omits --disallowed-tools entirely when the ONLY denied server is 'cyboflow'", () => {
    const mgr = makeManager({ disabled_mcp_servers_json: JSON.stringify(['cyboflow']) }, db);
    const args = mgr.callBuildCommandArgs(baseOpts);
    expect(args).not.toContain('--disallowed-tools');
    expect(args).not.toContain('mcp__cyboflow');
  });

  // (iii)
  it('emits no --disallowed-tools when there is no deny column', () => {
    const mgr = makeManager(undefined, db);
    const args = mgr.callBuildCommandArgs(baseOpts);
    expect(args).not.toContain('--disallowed-tools');
  });

  it('emits no --disallowed-tools for an empty deny array', () => {
    const mgr = makeManager({ disabled_mcp_servers_json: JSON.stringify([]) }, db);
    const args = mgr.callBuildCommandArgs(baseOpts);
    expect(args).not.toContain('--disallowed-tools');
  });

  // (iv) additive fallback — no installed catalogue → only the selected → true.
  it('threads enabled_plugins_json into the --settings JSON as an enabledPlugins map', () => {
    const mgr = makeManager({ enabled_plugins_json: JSON.stringify(['formatter@acme']) }, db);
    const args = mgr.callBuildCommandArgs(baseOpts);

    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[settingsIdx + 1]) as { enabledPlugins?: Record<string, boolean> };
    expect(parsed.enabledPlugins).toEqual({ 'formatter@acme': true });
  });

  // (iv-exclusive) selected → true, every OTHER installed plugin → false, so the
  // interactive session deterministically runs only the selected set (CLI honors
  // `{id:false}` at the flag tier — verified empirically).
  it('emits the EXCLUSIVE enabledPlugins map (other installed plugins → false)', () => {
    const mgr = makeManager(
      { enabled_plugins_json: JSON.stringify(['formatter@acme']) },
      db,
      ['formatter@acme', 'context7@official', 'warp@wm'],
    );
    const args = mgr.callBuildCommandArgs(baseOpts);

    const settingsIdx = args.indexOf('--settings');
    const parsed = JSON.parse(args[settingsIdx + 1]) as { enabledPlugins?: Record<string, boolean> };
    expect(parsed.enabledPlugins).toEqual({
      'formatter@acme': true,
      'context7@official': false,
      'warp@wm': false,
    });
  });

  // (v)
  it('omits enabledPlugins from the --settings JSON when there is no plugins column', () => {
    const mgr = makeManager(undefined, db);
    const args = mgr.callBuildCommandArgs(baseOpts);

    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[settingsIdx + 1]) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('enabledPlugins');
    // The default fast-mode keys still ride the single --settings flag.
    expect(parsed).toMatchObject({ fastMode: false, fastModePerSessionOptIn: true });
  });

  it('omits enabledPlugins for an empty plugins array', () => {
    const mgr = makeManager({ enabled_plugins_json: JSON.stringify([]) }, db);
    const args = mgr.callBuildCommandArgs(baseOpts);

    const settingsIdx = args.indexOf('--settings');
    const parsed = JSON.parse(args[settingsIdx + 1]) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('enabledPlugins');
  });
});
