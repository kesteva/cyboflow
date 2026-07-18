/**
 * Unit tests for canonicalJsonStringify / computeSpecHash — the CAS material
 * shared by cyboflow_propose_action (capture) and proposalExecutor
 * (re-verify) for edit-workflow proposals.
 *
 * Coverage:
 *   - Key-order permutations (including nested objects inside arrays) hash
 *     identically.
 *   - Different values hash differently.
 *   - Array order is significant (not sorted like object keys).
 *   - A hard-coded known-vector hash so accidental algorithm drift (e.g.
 *     swapping sha256 for sha1, or breaking canonicalization) fails loudly
 *     even if the differential tests above somehow still pass.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJsonStringify, computeSpecHash } from './specHash';

describe('canonicalJsonStringify', () => {
  it('sorts top-level object keys regardless of insertion order', () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonStringify(a)).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts nested object keys at every depth', () => {
    const a = { outer: { z: 1, y: { d: 4, c: 3 } } };
    const b = { outer: { y: { c: 3, d: 4 }, z: 1 } };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('sorts keys of objects nested inside arrays', () => {
    const a = { items: [{ b: 1, a: 2 }, { d: 4, c: 3 }] };
    const b = { items: [{ a: 2, b: 1 }, { c: 3, d: 4 }] };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('preserves array element order (does not sort array contents)', () => {
    const ascending = { items: [1, 2, 3] };
    const descending = { items: [3, 2, 1] };
    expect(canonicalJsonStringify(ascending)).not.toBe(canonicalJsonStringify(descending));
    expect(canonicalJsonStringify(ascending)).toBe('{"items":[1,2,3]}');
  });

  it('is sensitive to reordering objects WITHIN an array', () => {
    const first = { items: [{ id: 1 }, { id: 2 }] };
    const second = { items: [{ id: 2 }, { id: 1 }] };
    expect(canonicalJsonStringify(first)).not.toBe(canonicalJsonStringify(second));
  });

  it('omits undefined object values, like JSON.stringify', () => {
    const withUndefined = { a: 1, b: undefined, c: 3 };
    expect(canonicalJsonStringify(withUndefined)).toBe('{"a":1,"c":3}');
    expect(canonicalJsonStringify(withUndefined)).toBe(JSON.stringify({ a: 1, c: 3 }));
  });

  it('serializes primitives per JSON.stringify', () => {
    expect(canonicalJsonStringify('hello')).toBe(JSON.stringify('hello'));
    expect(canonicalJsonStringify(42)).toBe(JSON.stringify(42));
    expect(canonicalJsonStringify(true)).toBe(JSON.stringify(true));
    expect(canonicalJsonStringify(null)).toBe(JSON.stringify(null));
  });
});

describe('computeSpecHash', () => {
  it('is deterministic — the same value hashes to the same digest', () => {
    const value = { phases: [{ id: 'plan' }] };
    expect(computeSpecHash(value)).toBe(computeSpecHash(value));
  });

  it('returns a lowercase 64-character sha256 hex digest', () => {
    expect(computeSpecHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for key-order permutations, including nested objects inside arrays', () => {
    const a = { workflowId: 'planner', definition: { phases: [{ id: 'plan', steps: [{ name: 'z' }, { name: 'a' }] }], version: 2 } };
    const b = { definition: { version: 2, phases: [{ steps: [{ name: 'z' }, { name: 'a' }], id: 'plan' }] }, workflowId: 'planner' };
    expect(computeSpecHash(a)).toBe(computeSpecHash(b));
  });

  it('produces different hashes for different values', () => {
    expect(computeSpecHash({ a: 1 })).not.toBe(computeSpecHash({ a: 2 }));
  });

  it('produces different hashes when array order differs', () => {
    expect(computeSpecHash({ items: [1, 2, 3] })).not.toBe(computeSpecHash({ items: [3, 2, 1] }));
  });

  it('matches a hard-coded known-vector hash, so algorithm drift fails loudly', () => {
    // Independently verified: canonicalJsonStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}',
    // and sha256('{"a":2,"b":1}') === the hex below. If this ever fails, either the
    // canonicalization or the digest algorithm changed underneath this helper.
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(computeSpecHash({ b: 1, a: 2 })).toBe(
      'd3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772',
    );
  });

  it('matches a hand-computed sha256 of canonicalJsonStringify(value)', () => {
    const value = { nested: { z: 1, a: [3, 1, 2] } };
    const expected = createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
    expect(computeSpecHash(value)).toBe(expected);
  });
});
