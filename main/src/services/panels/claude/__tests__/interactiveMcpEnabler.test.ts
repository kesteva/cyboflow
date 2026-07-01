/**
 * Unit tests for InteractiveMcpEnabler (IDEA-030 interactive launch fix).
 *
 * The interactive `claude` REPL blocks on a "N new MCP servers found — enable?"
 * modal at launch for any worktree `.mcp.json` server not yet listed in
 * `.claude/settings.local.json` `enabledMcpjsonServers`. An app-driven run has
 * no human to answer it, so the REPL hangs. This enabler unions the project
 * server names into settings.local.json so the modal is skipped (parity with
 * the SDK substrate's unconditional project-server injection).
 *
 * Covers:
 *   (a) `.mcp.json` servers + no settings.local.json → writes the enable list;
 *   (b) merge-safety: pre-existing settings.local.json keys are preserved and
 *       the enable list is UNIONED with any prior entries (no clobber, no dupes);
 *   (c) idempotent: a second enable() leaves the file byte-identical;
 *   (d) fail-soft: missing / malformed / empty `.mcp.json` → no-op, no file.
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InteractiveMcpEnabler } from '../interactiveMcpEnabler';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

interface SettingsLocal {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  permissions?: { allow?: string[] };
  env?: Record<string, string>;
  [k: string]: unknown;
}

function makeWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-mcpenable-${process.pid}-`));
}

function mcpJsonPath(worktree: string): string {
  return path.join(worktree, '.mcp.json');
}

function settingsLocalPath(worktree: string): string {
  return path.join(worktree, '.claude', 'settings.local.json');
}

function writeMcpJson(worktree: string, servers: string[]): void {
  const mcpServers: Record<string, unknown> = {};
  for (const name of servers) {
    mcpServers[name] = { type: 'stdio', command: 'noop', args: [] };
  }
  fs.writeFileSync(mcpJsonPath(worktree), JSON.stringify({ mcpServers }, null, 2), 'utf8');
}

function readSettingsLocal(worktree: string): SettingsLocal {
  return JSON.parse(fs.readFileSync(settingsLocalPath(worktree), 'utf8')) as SettingsLocal;
}

describe('InteractiveMcpEnabler', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = makeWorktree();
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('(a) writes enabledMcpjsonServers for project .mcp.json servers when no settings.local.json exists', () => {
    writeMcpJson(worktree, ['playwright', 'maestro']);
    const enabler = new InteractiveMcpEnabler(makeSpyLogger());

    const enabled = enabler.enable(worktree);

    expect(enabled).toEqual(['playwright', 'maestro']);
    expect(fs.existsSync(settingsLocalPath(worktree))).toBe(true);
    const settings = readSettingsLocal(worktree);
    expect(settings.enabledMcpjsonServers).toEqual(['playwright', 'maestro']);
  });

  it('(b) unions with prior entries and preserves unrelated settings.local.json keys', () => {
    writeMcpJson(worktree, ['playwright', 'maestro']);
    fs.mkdirSync(path.dirname(settingsLocalPath(worktree)), { recursive: true });
    fs.writeFileSync(
      settingsLocalPath(worktree),
      JSON.stringify({
        enabledMcpjsonServers: ['playwright', 'legacy'],
        permissions: { allow: ['Bash(ls:*)'] },
        env: { FOO: 'bar' },
      }),
      'utf8',
    );

    new InteractiveMcpEnabler().enable(worktree);

    const settings = readSettingsLocal(worktree);
    // Union, deduped, prior entry kept.
    expect([...(settings.enabledMcpjsonServers ?? [])].sort()).toEqual(['legacy', 'maestro', 'playwright']);
    // Unrelated user keys preserved verbatim.
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.env).toEqual({ FOO: 'bar' });
  });

  it('(c) is idempotent — a second enable() leaves the file byte-identical', () => {
    writeMcpJson(worktree, ['playwright', 'maestro']);
    const enabler = new InteractiveMcpEnabler();

    enabler.enable(worktree);
    const first = fs.readFileSync(settingsLocalPath(worktree), 'utf8');
    enabler.enable(worktree);
    const second = fs.readFileSync(settingsLocalPath(worktree), 'utf8');

    expect(second).toBe(first);
  });

  it('(d1) no-op when .mcp.json is absent (no modal to suppress)', () => {
    const enabled = new InteractiveMcpEnabler().enable(worktree);
    expect(enabled).toEqual([]);
    expect(fs.existsSync(settingsLocalPath(worktree))).toBe(false);
  });

  it('(d2) no-op on a malformed .mcp.json', () => {
    fs.writeFileSync(mcpJsonPath(worktree), '{ not valid json', 'utf8');
    const enabled = new InteractiveMcpEnabler().enable(worktree);
    expect(enabled).toEqual([]);
    expect(fs.existsSync(settingsLocalPath(worktree))).toBe(false);
  });

  it('(d3) no-op when .mcp.json declares no servers', () => {
    fs.writeFileSync(mcpJsonPath(worktree), JSON.stringify({ mcpServers: {} }), 'utf8');
    const enabled = new InteractiveMcpEnabler().enable(worktree);
    expect(enabled).toEqual([]);
    expect(fs.existsSync(settingsLocalPath(worktree))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Per-session MCP DENY (migration 039): denied project servers are EXCLUDED
  // from enabledMcpjsonServers and UNIONED into disabledMcpjsonServers, so the
  // interactive REPL rejects them (no load, no approval) — layer 1 of the deny
  // (layer 2 is buildCommandArgs' --disallowed-tools mcp__<srv>).
  // -------------------------------------------------------------------------
  it('(e) excludes denied servers from enabledMcpjsonServers and adds them to disabledMcpjsonServers', () => {
    writeMcpJson(worktree, ['playwright', 'maestro']);
    const enabler = new InteractiveMcpEnabler(makeSpyLogger());

    const enabled = enabler.enable(worktree, ['maestro']);

    // Only the non-denied server is returned as enabled.
    expect(enabled).toEqual(['playwright']);
    const settings = readSettingsLocal(worktree);
    expect(settings.enabledMcpjsonServers).toEqual(['playwright']);
    expect(settings.disabledMcpjsonServers).toEqual(['maestro']);
  });

  it('(f) a denied server that is not a project server is ignored (nothing to reject)', () => {
    writeMcpJson(worktree, ['playwright']);
    const settings0 = new InteractiveMcpEnabler().enable(worktree, ['not-a-project-server']);

    expect(settings0).toEqual(['playwright']);
    const settings = readSettingsLocal(worktree);
    expect(settings.enabledMcpjsonServers).toEqual(['playwright']);
    // No disabledMcpjsonServers key written when nothing project-present is denied.
    expect(settings.disabledMcpjsonServers).toBeUndefined();
  });

  it('(g) preserves unrelated keys and prior enabled/disabled entries when denying', () => {
    writeMcpJson(worktree, ['playwright', 'maestro']);
    fs.mkdirSync(path.dirname(settingsLocalPath(worktree)), { recursive: true });
    fs.writeFileSync(
      settingsLocalPath(worktree),
      JSON.stringify({
        enabledMcpjsonServers: ['legacy'],
        disabledMcpjsonServers: ['old-denied'],
        permissions: { allow: ['Bash(ls:*)'] },
      }),
      'utf8',
    );

    new InteractiveMcpEnabler().enable(worktree, ['maestro']);

    const settings = readSettingsLocal(worktree);
    expect([...(settings.enabledMcpjsonServers ?? [])].sort()).toEqual(['legacy', 'playwright']);
    expect([...(settings.disabledMcpjsonServers ?? [])].sort()).toEqual(['maestro', 'old-denied']);
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
  });

  it('(h) is idempotent with a deny-list — a second enable() leaves the file byte-identical', () => {
    writeMcpJson(worktree, ['playwright', 'maestro']);
    const enabler = new InteractiveMcpEnabler();

    enabler.enable(worktree, ['maestro']);
    const first = fs.readFileSync(settingsLocalPath(worktree), 'utf8');
    enabler.enable(worktree, ['maestro']);
    const second = fs.readFileSync(settingsLocalPath(worktree), 'utf8');

    expect(second).toBe(first);
  });
});
