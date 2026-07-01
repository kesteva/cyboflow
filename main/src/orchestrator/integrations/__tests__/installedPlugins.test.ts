/**
 * Unit tests for buildExclusiveEnabledPluginsMap — the shared deterministic
 * enabledPlugins builder used by BOTH the SDK and interactive substrates.
 * (readPluginEntries / readInstalledPluginIds hit the real ~/.claude catalogue
 * and are covered by trpc/routers/__tests__/plugins.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import { buildExclusiveEnabledPluginsMap } from '../installedPlugins';

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

  it('returns undefined for an empty selection array', () => {
    expect(buildExclusiveEnabledPluginsMap('[]', installed)).toBeUndefined();
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
