import { describe, it, expect } from 'vitest';
import { HlcClock, compareHlc, formatHlc, hlcFromIso, parseHlc } from '../hlc';

describe('hlc format/parse', () => {
  it('round trips, including device ids containing colons', () => {
    const h = { ms: 1_700_000_000_123, ctr: 42, deviceId: 'dev:with:colons' };
    const s = formatHlc(h);
    expect(s).toBe('1700000000123:00042:dev:with:colons');
    expect(parseHlc(s)).toEqual(h);
  });
  it('pads small values', () => {
    expect(formatHlc({ ms: 5, ctr: 1, deviceId: 'a' })).toBe('0000000000005:00001:a');
  });
  it('rejects malformed strings', () => {
    expect(parseHlc('nope')).toBeNull();
    expect(parseHlc('1700000000123:00042:')).toBeNull();
  });
});

describe('compareHlc', () => {
  it('orders by ms, then ctr, then device id', () => {
    expect(compareHlc('1700000000000:00000:a', '1700000000001:00000:a')).toBe(-1);
    expect(compareHlc('1700000000000:00001:a', '1700000000000:00000:z')).toBe(1);
    expect(compareHlc('1700000000000:00000:a', '1700000000000:00000:b')).toBe(-1);
    expect(compareHlc('1700000000000:00000:b', '1700000000000:00000:a')).toBe(1);
    expect(compareHlc('1700000000000:00000:a', '1700000000000:00000:a')).toBe(0);
  });
  it('falls back to string compare when unparseable', () => {
    expect(compareHlc('a', 'b')).toBe(-1);
    expect(compareHlc('b', 'a')).toBe(1);
    expect(compareHlc('a', 'a')).toBe(0);
  });
});

describe('HlcClock', () => {
  it('is strictly increasing when the wall clock stands still', () => {
    const c = new HlcClock('dev', { now: () => 1_700_000_000_000 });
    const a = c.next();
    const b = c.next();
    expect(a).toBe('1700000000000:00000:dev');
    expect(b).toBe('1700000000000:00001:dev');
    expect(compareHlc(a, b)).toBe(-1);
    expect(c.last).toBe(b);
  });
  it('stays monotonic when the wall clock goes backwards', () => {
    let t = 1_700_000_005_000;
    const c = new HlcClock('dev', { now: () => t });
    const a = c.next();
    t = 1_700_000_000_000;
    const b = c.next();
    expect(compareHlc(a, b)).toBe(-1);
    expect(parseHlc(b)?.ms).toBe(1_700_000_005_000);
  });
  it('resumes from a persisted last value', () => {
    const c = new HlcClock('dev', { now: () => 1, last: '1700000000000:00007:dev' });
    expect(c.next()).toBe('1700000000000:00008:dev');
  });
  it('has null last until used', () => {
    expect(new HlcClock('dev', {}).last).toBeNull();
  });
  it('bumps ms on counter overflow', () => {
    const c = new HlcClock('dev', { now: () => 1_700_000_000_000, last: '1700000000000:99999:dev' });
    expect(c.next()).toBe('1700000000001:00000:dev');
  });
  it('observe() of a future remote makes the next HLC greater and keeps the local device id', () => {
    const c = new HlcClock('local', { now: () => 1_700_000_000_000 });
    const remote = '1700000099999:00003:remote';
    c.observe(remote);
    const n = c.next();
    expect(compareHlc(n, remote)).toBe(1);
    expect(parseHlc(n)?.deviceId).toBe('local');
  });
  it('observe() of an equal-ms remote with higher counter advances the counter', () => {
    const c = new HlcClock('local', { now: () => 1_700_000_000_000 });
    c.next();
    c.observe('1700000000000:00009:remote');
    expect(c.next()).toBe('1700000000000:00010:local');
  });
  it('observe() ignores older or malformed remotes', () => {
    const c = new HlcClock('local', { now: () => 1_700_000_000_000 });
    c.next();
    c.observe('garbage');
    c.observe('1600000000000:00000:remote');
    expect(c.next()).toBe('1700000000000:00001:local');
  });
});

describe('hlcFromIso', () => {
  it('parses ISO with a zone', () => {
    expect(hlcFromIso('2026-01-02T03:04:05.678Z', 'dev')).toBe(`${Date.UTC(2026, 0, 2, 3, 4, 5, 678)}:00000:dev`);
  });
  it('parses zone-less SQLite datetime as UTC', () => {
    expect(hlcFromIso('2026-01-02 03:04:05', 'dev')).toBe(`${Date.UTC(2026, 0, 2, 3, 4, 5)}:00000:dev`);
  });
  it('honours explicit offsets', () => {
    expect(hlcFromIso('2026-01-02T03:04:05+02:00', 'dev')).toBe(`${Date.UTC(2026, 0, 2, 1, 4, 5)}:00000:dev`);
  });
  it('returns null for garbage', () => {
    expect(hlcFromIso('not a date', 'dev')).toBeNull();
  });
});
