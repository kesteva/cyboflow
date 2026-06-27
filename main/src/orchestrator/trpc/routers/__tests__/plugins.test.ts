/**
 * Unit tests for the cyboflow.plugins disk-read catalogue (readPluginEntries).
 *
 * The reader resolves `~/.claude/plugins/installed_plugins.json` from
 * `os.homedir()`, so we mock the home directory to a throwaway temp dir and
 * write real fixture files into it. The never-throws contract is asserted via a
 * missing file + malformed JSON → []. One plugin id can carry multiple install
 * records (per scope / project) — each yields its own PluginEntry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const homeHolder = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeHolder.dir };
});

import { readPluginEntries } from '../plugins';

describe('readPluginEntries', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-plugins-'));
    homeHolder.dir = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeInstalled(content: string): void {
    const dir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), content);
  }

  it('returns [] when the file is absent', () => {
    expect(readPluginEntries()).toEqual([]);
  });

  it('returns [] on malformed JSON (never throws)', () => {
    writeInstalled('{ broken ');
    expect(readPluginEntries()).toEqual([]);
  });

  it('returns [] when there is no plugins map', () => {
    writeInstalled(JSON.stringify({ version: 2 }));
    expect(readPluginEntries()).toEqual([]);
  });

  it('splits the id into name + marketplace and reads a user-scope record', () => {
    writeInstalled(
      JSON.stringify({
        version: 2,
        plugins: {
          'frontend-design@claude-plugins-official': [
            {
              scope: 'user',
              version: 'unknown',
              lastUpdated: '2026-06-26T23:20:44.559Z',
            },
          ],
        },
      }),
    );
    const out = readPluginEntries();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 'frontend-design@claude-plugins-official',
      name: 'frontend-design',
      marketplace: 'claude-plugins-official',
      scope: 'user',
      version: 'unknown',
      lastUpdated: '2026-06-26T23:20:44.559Z',
      projectPath: null,
    });
  });

  it('yields one PluginEntry per install record (multiple scopes / projects)', () => {
    writeInstalled(
      JSON.stringify({
        version: 2,
        plugins: {
          'soloflow-dev@soloflow': [
            { scope: 'local', projectPath: '/Users/me/tester', version: '0.9.12' },
            { scope: 'project', projectPath: '/Users/me/recipe', version: '0.11.0' },
          ],
        },
      }),
    );
    const out = readPluginEntries();
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.scope).sort()).toEqual(['local', 'project']);
    const local = out.find((e) => e.scope === 'local');
    expect(local?.projectPath).toBe('/Users/me/tester');
    expect(local?.version).toBe('0.9.12');
    expect(out.every((e) => e.id === 'soloflow-dev@soloflow')).toBe(true);
  });

  it('defaults missing fields (scope → user, version → unknown, lastUpdated → null) and skips non-object records', () => {
    writeInstalled(
      JSON.stringify({
        version: 2,
        plugins: {
          'p@m': [{}, 'not-a-record', 99],
        },
      }),
    );
    const out = readPluginEntries();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 'p@m',
      name: 'p',
      marketplace: 'm',
      scope: 'user',
      version: 'unknown',
      lastUpdated: null,
      projectPath: null,
    });
  });
});
