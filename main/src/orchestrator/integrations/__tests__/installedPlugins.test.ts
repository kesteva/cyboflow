/**
 * Unit tests for buildExclusiveEnabledPluginsMap — the shared deterministic
 * enabledPlugins builder used by BOTH the SDK and interactive substrates.
 * (readPluginEntries / readInstalledPluginIds hit the real ~/.claude catalogue
 * and are covered by trpc/routers/__tests__/plugins.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildExclusiveEnabledPluginsMap } from '../installedPlugins';

const homeHolder = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeHolder.dir };
});

// Imported AFTER the mock is registered so os.homedir() resolves to homeHolder.
import { readPluginEntries } from '../installedPlugins';

describe('buildExclusiveEnabledPluginsMap', () => {
  const installed = ['a@m', 'b@m', 'c@m'];

  it('exclusive: selected → true, every other installed → false', () => {
    expect(buildExclusiveEnabledPluginsMap(JSON.stringify(['a@m']), installed)).toEqual({
      'a@m': true,
      'b@m': false,
      'c@m': false,
    });
  });

  it('multiple selected are all true; the rest false', () => {
    expect(buildExclusiveEnabledPluginsMap(JSON.stringify(['a@m', 'c@m']), installed)).toEqual({
      'a@m': true,
      'b@m': false,
      'c@m': true,
    });
  });

  it('additive fallback: empty installed catalogue → only the selected → true', () => {
    expect(buildExclusiveEnabledPluginsMap(JSON.stringify(['a@m', 'b@m']), [])).toEqual({
      'a@m': true,
      'b@m': true,
    });
  });

  it('a selected plugin absent from the installed catalogue is still force-enabled', () => {
    expect(buildExclusiveEnabledPluginsMap(JSON.stringify(['ghost@m']), installed)).toEqual({
      'a@m': false,
      'b@m': false,
      'c@m': false,
      'ghost@m': true,
    });
  });

  it('returns undefined for missing / empty / whitespace-only raw (inherit default)', () => {
    expect(buildExclusiveEnabledPluginsMap(undefined, installed)).toBeUndefined();
    expect(buildExclusiveEnabledPluginsMap(null, installed)).toBeUndefined();
    expect(buildExclusiveEnabledPluginsMap('', installed)).toBeUndefined();
  });

  it('explicit empty selection [] → disables ALL installed plugins (not inherit)', () => {
    expect(buildExclusiveEnabledPluginsMap('[]', installed)).toEqual({
      'a@m': false,
      'b@m': false,
      'c@m': false,
    });
  });

  it('explicit empty selection over an EMPTY catalogue → undefined (nothing to disable)', () => {
    expect(buildExclusiveEnabledPluginsMap('[]', [])).toBeUndefined();
  });

  it('returns undefined for malformed JSON or a non-array', () => {
    expect(buildExclusiveEnabledPluginsMap('not-json', installed)).toBeUndefined();
    expect(buildExclusiveEnabledPluginsMap('{"x":1}', installed)).toBeUndefined();
  });

  it('ignores non-string entries in the selection array', () => {
    // Only the string ids are honored; 42 / null are dropped.
    expect(buildExclusiveEnabledPluginsMap(JSON.stringify(['a@m', 42, null]), installed)).toEqual({
      'a@m': true,
      'b@m': false,
      'c@m': false,
    });
  });
});

/**
 * Disk-layer gaps for readPluginEntries not covered by the router's
 * plugins.test.ts: an id with no '@' (marketplace defaults to ''), a non-object
 * `plugins` value, and the enabled-flag derivation from a malformed / non-object
 * / non-boolean `enabledPlugins` map (readUserEnabledPluginsMap, exercised via
 * the resulting `enabled` field).
 */
describe('readPluginEntries — disk-layer edge cases', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-installed-'));
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

  function writeSettings(content: string): void {
    const dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), content);
  }

  it('an id with no "@" keeps the whole id as name and empties the marketplace', () => {
    writeInstalled(
      JSON.stringify({ version: 2, plugins: { 'bareplugin': [{ scope: 'user' }] } }),
    );
    const out = readPluginEntries();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('bareplugin');
    expect(out[0].name).toBe('bareplugin');
    expect(out[0].marketplace).toBe('');
  });

  it('returns [] when `plugins` is present but not an object (e.g. a number)', () => {
    writeInstalled(JSON.stringify({ version: 2, plugins: 5 }));
    expect(readPluginEntries()).toEqual([]);
  });

  it('a non-object enabledPlugins map leaves every plugin disabled ({} default)', () => {
    writeInstalled(JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user' }] } }));
    writeSettings(JSON.stringify({ enabledPlugins: 'not-an-object' }));
    expect(readPluginEntries().map((e) => e.enabled)).toEqual([false]);
  });

  it('malformed settings.json leaves every plugin disabled (reader never throws)', () => {
    writeInstalled(JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user' }] } }));
    writeSettings('{ broken');
    expect(readPluginEntries().map((e) => e.enabled)).toEqual([false]);
  });

  it('coerces a non-boolean enabledPlugins value to disabled (strict === true)', () => {
    writeInstalled(
      JSON.stringify({
        version: 2,
        plugins: {
          'truthy@m': [{ scope: 'user' }],
          'real@m': [{ scope: 'user' }],
        },
      }),
    );
    // 'truthy@m' maps to the string "true" (truthy but not === true) → disabled;
    // only a real boolean true enables.
    writeSettings(JSON.stringify({ enabledPlugins: { 'truthy@m': 'true', 'real@m': true } }));
    const byId = Object.fromEntries(readPluginEntries().map((e) => [e.id, e.enabled]));
    expect(byId).toEqual({ 'truthy@m': false, 'real@m': true });
  });
});
