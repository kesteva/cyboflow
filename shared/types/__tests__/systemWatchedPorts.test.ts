import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM_WATCHED_PORTS,
  isDefaultSystemWatchedPorts,
  normalizeSystemWatchedPorts,
  parseSystemWatchedPortsText,
  resolveSystemWatchedPorts,
} from '../systemWatchedPorts';

describe('systemWatchedPorts', () => {
  it('normalizes a valid list, deduplicating in first-seen order', () => {
    expect(normalizeSystemWatchedPorts([8080, 3000, 8080])).toEqual([8080, 3000]);
    expect(normalizeSystemWatchedPorts([])).toEqual([]);
  });

  it('rejects anything malformed', () => {
    expect(normalizeSystemWatchedPorts(undefined)).toBeNull();
    expect(normalizeSystemWatchedPorts({ 0: 3000 })).toBeNull();
    expect(normalizeSystemWatchedPorts([0])).toBeNull();
    expect(normalizeSystemWatchedPorts([65536])).toBeNull();
    expect(normalizeSystemWatchedPorts([80.5])).toBeNull();
    expect(normalizeSystemWatchedPorts(['80'])).toBeNull();
    expect(normalizeSystemWatchedPorts(Array.from({ length: 33 }, (_, i) => i + 1))).toBeNull();
  });

  it('resolves absent or malformed values to a fresh copy of the defaults', () => {
    const resolved = resolveSystemWatchedPorts(undefined);
    expect(resolved).toEqual([3000, 5000, 8080]);
    expect(resolved).not.toBe(DEFAULT_SYSTEM_WATCHED_PORTS);
    expect(resolveSystemWatchedPorts(['x'])).toEqual([3000, 5000, 8080]);
    expect(resolveSystemWatchedPorts([])).toEqual([]);
  });

  it('recognizes the default list only in its default order', () => {
    expect(isDefaultSystemWatchedPorts([3000, 5000, 8080])).toBe(true);
    expect(isDefaultSystemWatchedPorts([8080, 5000, 3000])).toBe(false);
    expect(isDefaultSystemWatchedPorts([3000])).toBe(false);
  });

  it('parses comma/space separated text and names every invalid token', () => {
    expect(parseSystemWatchedPortsText('3000, 5000 8080,,3000')).toEqual({ ports: [3000, 5000, 8080], invalid: [] });
    expect(parseSystemWatchedPortsText('  ')).toEqual({ ports: [], invalid: [] });
    expect(parseSystemWatchedPortsText('3000, abc, 70000, 0, 12.5')).toEqual({
      ports: [3000],
      invalid: ['abc', '70000', '0', '12.5'],
    });
  });
});
