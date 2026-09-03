import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseUserMcpServerNames,
  readUserMcpServerNames,
  resolveCodexHome,
} from '../userMcpServers';

describe('parseUserMcpServerNames', () => {
  it('collects bare, quoted, and sub-table headers once each, in order', () => {
    const toml = `
model = "gpt-5.5"

[mcp_servers.node_repl]
command = "/bin/node_repl"

[mcp_servers.node_repl.env]
FOO = "bar"

[ mcp_servers."with space" ]
command = "x"

[mcp_servers.'single']
command = "y"

[projects."/Users/me/repo"]
trust_level = "trusted"
`;
    expect(parseUserMcpServerNames(toml)).toEqual(['node_repl', 'with space', 'single']);
  });

  it('ignores lines that merely mention mcp_servers', () => {
    expect(parseUserMcpServerNames('# [mcp_servers.commented]\nmcp_servers = 1\n')).toEqual([]);
  });
});

describe('readUserMcpServerNames', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home !== null) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('reads config.toml under the given home and drops the injected cyboflow entry', () => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    writeFileSync(
      join(home, 'config.toml'),
      '[mcp_servers.cyboflow]\ncommand = "x"\n[mcp_servers.repl]\ncommand = "y"\n',
    );
    expect(readUserMcpServerNames(home)).toEqual(['repl']);
  });

  it('is fail-soft: a missing config yields nothing to disable', () => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    expect(readUserMcpServerNames(home)).toEqual([]);
  });
});

describe('resolveCodexHome', () => {
  it('prefers CODEX_HOME and falls back to ~/.codex', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/custom/codex' })).toBe('/custom/codex');
    expect(resolveCodexHome({ CODEX_HOME: '  ' })).toMatch(/\.codex$/);
    expect(resolveCodexHome({})).toMatch(/\.codex$/);
  });
});
