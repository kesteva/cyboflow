/**
 * Unit tests for permissionModeResolver — the single resolution point for the
 * agent permission-mode choice governing workflow runs on both CLI substrates.
 *
 * Behaviors covered (mirroring substrateResolver.test.ts):
 *  1. resolvePermissionMode honors the override ladder in precedence order
 *     (requestedMode > frontmatterMode > globalDefaultMode > 'default' floor):
 *     one case per level winning, a full-precedence case, the floor case, and
 *     an invalid-value-ignored case (fail-soft fall-through).
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePermissionMode,
  DEFAULT_PERMISSION_MODE,
} from '../permissionModeResolver';

describe('resolvePermissionMode — override ladder', () => {
  it("floors to 'default' when nothing is set (zero-behavior-change invariant)", () => {
    expect(resolvePermissionMode({})).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({})).toBe('default');
  });

  it('requestedMode (explicit per-run UI choice) wins over every lower level', () => {
    const result = resolvePermissionMode({
      requestedMode: 'dontAsk',
      frontmatterMode: 'acceptEdits',
      globalDefaultMode: 'auto',
    });
    expect(result).toBe('dontAsk');
  });

  it('an absent/invalid requestedMode falls through to the next level (fail-soft)', () => {
    // Per-run override not supplied (undefined) → frontmatter wins.
    expect(
      resolvePermissionMode({ requestedMode: undefined, frontmatterMode: 'auto' }),
    ).toBe('auto');
    // Garbage requested value is ignored → falls through to global default.
    expect(
      resolvePermissionMode({ requestedMode: 'garbage', globalDefaultMode: 'acceptEdits' }),
    ).toBe('acceptEdits');
  });

  it('frontmatterMode wins when set, even with the global default present', () => {
    const result = resolvePermissionMode({
      frontmatterMode: 'acceptEdits',
      globalDefaultMode: 'auto',
    });
    expect(result).toBe('acceptEdits');
  });

  it('globalDefaultMode wins when requested + frontmatter are absent', () => {
    expect(resolvePermissionMode({ globalDefaultMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ globalDefaultMode: 'dontAsk' })).toBe('dontAsk');
  });

  it('full precedence: requested beats frontmatter beats globalDefault', () => {
    // Highest set level should win. Distinct valid values at every rung.
    expect(
      resolvePermissionMode({
        requestedMode: 'dontAsk',
        frontmatterMode: 'acceptEdits',
        globalDefaultMode: 'auto',
      }),
    ).toBe('dontAsk');

    // Drop requested → frontmatter wins.
    expect(
      resolvePermissionMode({ frontmatterMode: 'acceptEdits', globalDefaultMode: 'auto' }),
    ).toBe('acceptEdits');

    // Drop frontmatter → globalDefault wins.
    expect(resolvePermissionMode({ globalDefaultMode: 'auto' })).toBe('auto');
  });

  it("'auto' is a recognized mode and resolves through every level", () => {
    expect(resolvePermissionMode({ requestedMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ frontmatterMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ globalDefaultMode: 'auto' })).toBe('auto');
  });

  it('an invalid value at a level is ignored and resolution falls through (fail-soft)', () => {
    // A typo at the highest level must NOT throw and must NOT win — resolution
    // falls through to the next valid level (here frontmatter).
    const result = resolvePermissionMode({
      requestedMode: 'acceptEdit', // typo — invalid
      frontmatterMode: 'acceptEdits',
      globalDefaultMode: 'default',
    });
    expect(result).toBe('acceptEdits');
  });

  it('an invalid value at every level falls through to the default floor', () => {
    const result = resolvePermissionMode({
      requestedMode: 'yolo',
      frontmatterMode: 'bogus',
      globalDefaultMode: '',
    });
    expect(result).toBe('default');
  });

  it('null at any level is ignored (fail-soft, not a value)', () => {
    expect(
      resolvePermissionMode({
        requestedMode: null,
        frontmatterMode: null,
        globalDefaultMode: 'dontAsk',
      }),
    ).toBe('dontAsk');
  });
});
