/**
 * Contract pins for the provider-aware reasoning-effort vocabulary (IDEA-029).
 *
 * The two providers expose DIFFERENT effort scales, and a stale cross-provider
 * value must be dropped rather than forwarded to a spawn that would reject it —
 * the same silent-corruption class as `normalizeAgentModelSelection`. Pin the
 * scales and the normalize behaviour so a regression fails the build.
 */
import { describe, it, expect } from 'vitest';
import {
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  effortLevelsForProvider,
  isValidEffortForProvider,
  normalizeEffortSelection,
} from '../../../shared/types/reasoningEffort';

describe('reasoningEffort vocabulary', () => {
  it('exposes the documented per-provider scales', () => {
    expect([...CLAUDE_EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect([...CODEX_EFFORT_LEVELS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('keys the picker option list to the provider', () => {
    expect(effortLevelsForProvider('claude')).toBe(CLAUDE_EFFORT_LEVELS);
    expect(effortLevelsForProvider('codex')).toBe(CODEX_EFFORT_LEVELS);
  });

  it('validates against the owning provider only', () => {
    // `max` is Claude-only; `none`/`minimal` are Codex-only.
    expect(isValidEffortForProvider('claude', 'max')).toBe(true);
    expect(isValidEffortForProvider('codex', 'max')).toBe(false);
    expect(isValidEffortForProvider('codex', 'minimal')).toBe(true);
    expect(isValidEffortForProvider('claude', 'minimal')).toBe(false);
    // shared middle
    expect(isValidEffortForProvider('claude', 'high')).toBe(true);
    expect(isValidEffortForProvider('codex', 'high')).toBe(true);
  });
});

describe('normalizeEffortSelection', () => {
  it('treats empty / default as no explicit selection', () => {
    expect(normalizeEffortSelection('claude', undefined)).toBeUndefined();
    expect(normalizeEffortSelection('claude', null)).toBeUndefined();
    expect(normalizeEffortSelection('claude', '')).toBeUndefined();
    expect(normalizeEffortSelection('codex', 'default')).toBeUndefined();
  });

  it('preserves a valid value for the provider (case/space-insensitive)', () => {
    expect(normalizeEffortSelection('claude', 'xhigh')).toBe('xhigh');
    expect(normalizeEffortSelection('claude', ' High ')).toBe('high');
    expect(normalizeEffortSelection('codex', 'minimal')).toBe('minimal');
  });

  it('drops a value outside the provider scale (stale cross-provider carry-over)', () => {
    // Codex agent left with Claude's `max`, or Claude agent left with `minimal`.
    expect(normalizeEffortSelection('codex', 'max')).toBeUndefined();
    expect(normalizeEffortSelection('claude', 'minimal')).toBeUndefined();
    expect(normalizeEffortSelection('claude', 'garbage')).toBeUndefined();
  });
});
