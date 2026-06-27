/**
 * Unit tests for the cyboflow.mcps disk-read catalogue (readMcpEntries).
 *
 * The reader resolves `~/.claude.json` from `os.homedir()`, so we mock the home
 * directory to a throwaway temp dir and write real fixture files into it. The
 * never-throws contract is asserted via a missing file + malformed JSON → [].
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// vi.hoisted holder so the (hoisted) vi.mock factory can read a mutable home.
const homeHolder = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeHolder.dir };
});

import { readMcpEntries } from '../mcps';

describe('readMcpEntries', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-mcps-'));
    homeHolder.dir = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeClaudeJson(content: string): void {
    fs.writeFileSync(path.join(home, '.claude.json'), content);
  }

  it('returns [] when ~/.claude.json is absent', () => {
    expect(readMcpEntries()).toEqual([]);
  });

  it('returns [] on malformed JSON (never throws)', () => {
    writeClaudeJson('{ not valid json ');
    expect(readMcpEntries()).toEqual([]);
  });

  it('returns [] when the top-level value is not an object', () => {
    writeClaudeJson('"just a string"');
    expect(readMcpEntries()).toEqual([]);
  });

  it('adapts global http + stdio servers, defaulting transport to stdio', () => {
    writeClaudeJson(
      JSON.stringify({
        mcpServers: {
          'fal-ai': { type: 'http', url: 'https://mcp.fal.ai/mcp' },
          peekaboo: { command: 'npx', args: ['-y', 'peekaboo'] },
        },
      }),
    );
    const out = readMcpEntries();
    expect(out).toHaveLength(2);

    const fal = out.find((e) => e.name === 'fal-ai');
    expect(fal).toEqual({
      name: 'fal-ai',
      transport: 'http',
      url: 'https://mcp.fal.ai/mcp',
      command: null,
      args: [],
      scope: 'global',
    });

    const peekaboo = out.find((e) => e.name === 'peekaboo');
    expect(peekaboo).toEqual({
      name: 'peekaboo',
      transport: 'stdio',
      url: null,
      command: 'npx',
      args: ['-y', 'peekaboo'],
      scope: 'global',
    });
  });

  it('maps an sse server to the sse transport', () => {
    writeClaudeJson(
      JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://x/sse' } } }),
    );
    const [entry] = readMcpEntries();
    expect(entry.transport).toBe('sse');
    expect(entry.url).toBe('https://x/sse');
  });

  it('includes per-project servers tagged with the project path as scope', () => {
    writeClaudeJson(
      JSON.stringify({
        mcpServers: { global1: { command: 'a' } },
        projects: {
          '/Users/me/proj': { mcpServers: { local1: { type: 'http', url: 'http://l' } } },
        },
      }),
    );
    const out = readMcpEntries();
    const local = out.find((e) => e.name === 'local1');
    expect(local?.scope).toBe('/Users/me/proj');
    const global = out.find((e) => e.name === 'global1');
    expect(global?.scope).toBe('global');
  });

  it('skips non-object server definitions and non-string args', () => {
    writeClaudeJson(
      JSON.stringify({
        mcpServers: {
          bad: 42,
          good: { command: 'x', args: ['ok', 7, null] },
        },
      }),
    );
    const out = readMcpEntries();
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('good');
    expect(out[0].args).toEqual(['ok']);
  });
});
