/**
 * Unit tests for computeSpecHash — the spec_json content address (sha256 hex)
 * that backs workflow_runs.spec_hash and the workflow_revisions snapshot key
 * (spec-capture / migration 025).
 *
 * Coverage:
 *   - Determinism: same input → same digest across calls.
 *   - Shape: lowercase 64-char hex (sha256).
 *   - Null normalization: null / undefined / '{}' all collapse to the SAME hash
 *     (the floor is '{}' applied BEFORE hashing), and that hash matches a known
 *     sha256('{}') value computed independently.
 *   - Distinctness: byte-different spec text → different digest (no canonicalize).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeSpecHash } from '../specHash';

/** Independently-derived sha256('{}') reference for the null-normalization floor. */
const HASH_OF_EMPTY = createHash('sha256').update('{}', 'utf8').digest('hex');

describe('computeSpecHash', () => {
  it('is deterministic — the same string hashes to the same digest', () => {
    const spec = '{"phases":[{"id":"plan"}]}';
    expect(computeSpecHash(spec)).toBe(computeSpecHash(spec));
  });

  it('returns a lowercase 64-character sha256 hex digest', () => {
    const hash = computeSpecHash('{"a":1}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes null to '{}' before hashing", () => {
    expect(computeSpecHash(null)).toBe(HASH_OF_EMPTY);
  });

  it("normalizes undefined to '{}' before hashing", () => {
    expect(computeSpecHash(undefined)).toBe(HASH_OF_EMPTY);
  });

  it("hashes the literal '{}' to the same digest as null / undefined", () => {
    expect(computeSpecHash('{}')).toBe(HASH_OF_EMPTY);
  });

  it("collapses null, undefined, and '{}' to one identical hash", () => {
    const a = computeSpecHash(null);
    const b = computeSpecHash(undefined);
    const c = computeSpecHash('{}');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('hashes byte-different spec text to different digests (no parse/canonicalize)', () => {
    // Same JSON VALUE, different whitespace → different bytes → different hash.
    // This pins the documented "exact string, no canonicalization" contract.
    expect(computeSpecHash('{"a":1}')).not.toBe(computeSpecHash('{ "a": 1 }'));
  });

  it('hashes distinct specs to distinct digests', () => {
    expect(computeSpecHash('{"a":1}')).not.toBe(computeSpecHash('{"a":2}'));
  });

  it('matches a hand-computed sha256 of the exact input string', () => {
    const spec = '{"id":"planner","phases":[]}';
    const expected = createHash('sha256').update(spec, 'utf8').digest('hex');
    expect(computeSpecHash(spec)).toBe(expected);
  });
});
