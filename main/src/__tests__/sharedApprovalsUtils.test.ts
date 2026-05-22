/**
 * Unit tests for shared/utils/approvals.ts.
 *
 * Pins the PAYLOAD_PREVIEW_MAX_LEN constant and the truncatePayloadPreview
 * boundary behavior so that any future change to the 512-char invariant is
 * caught immediately (FIND-SPRINT-029-9 class of drift).
 *
 * Covered cases:
 *   1. PAYLOAD_PREVIEW_MAX_LEN is exactly 512
 *   2. 512-char string passes through unchanged
 *   3. 513-char string is truncated to 512 chars
 *   4. Empty string passes through unchanged
 */
import { describe, it, expect } from 'vitest';
import {
  PAYLOAD_PREVIEW_MAX_LEN,
  truncatePayloadPreview,
} from '../../../shared/utils/approvals';

describe('PAYLOAD_PREVIEW_MAX_LEN', () => {
  it('is exactly 512', () => {
    expect(PAYLOAD_PREVIEW_MAX_LEN).toBe(512);
  });
});

describe('truncatePayloadPreview', () => {
  it('returns a 512-char string unchanged', () => {
    const input = 'a'.repeat(512);
    expect(truncatePayloadPreview(input)).toBe(input);
    expect(truncatePayloadPreview(input)).toHaveLength(512);
  });

  it('truncates a 513-char string to 512 chars', () => {
    const input = 'b'.repeat(513);
    const result = truncatePayloadPreview(input);
    expect(result).toHaveLength(512);
    expect(result).toBe('b'.repeat(512));
  });

  it('returns an empty string unchanged', () => {
    expect(truncatePayloadPreview('')).toBe('');
  });
});
