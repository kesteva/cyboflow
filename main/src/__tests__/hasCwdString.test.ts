/**
 * Unit tests for the hasCwdString type guard exported from shared/types/panels.ts.
 *
 * The guard narrows ToolPanelState['customState'] to `{ cwd: string }` when
 * the value is an object with a non-empty string `cwd` property.
 *
 * Covered cases (per TASK-677 test strategy):
 *   1. { cwd: '/some/path' }            → true  (happy path)
 *   2. null                             → false
 *   3. undefined                        → false
 *   4. {}                               → false (no cwd property)
 *   5. { cwd: '' }                      → false (empty string rejected)
 *   6. { cwd: 123 }                     → false (non-string cwd rejected)
 *   7. { cwd: '/path', other: 'data' }  → true  (extra properties allowed)
 */
import { describe, it, expect } from 'vitest';
import { hasCwdString } from '../../../shared/types/panels';

describe('hasCwdString', () => {
  it('returns true for an object with a non-empty string cwd', () => {
    expect(hasCwdString({ cwd: '/some/path' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(hasCwdString(null as unknown as Parameters<typeof hasCwdString>[0])).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasCwdString(undefined)).toBe(false);
  });

  it('returns false for an empty object (no cwd property)', () => {
    expect(hasCwdString({})).toBe(false);
  });

  it('returns false for an object with an empty string cwd', () => {
    expect(hasCwdString({ cwd: '' })).toBe(false);
  });

  it('returns false for an object with a non-string cwd (number)', () => {
    expect(hasCwdString({ cwd: 123 } as unknown as Parameters<typeof hasCwdString>[0])).toBe(false);
  });

  it('returns true for an object with extra properties alongside a valid cwd', () => {
    expect(hasCwdString({ cwd: '/path', other: 'data' })).toBe(true);
  });
});
