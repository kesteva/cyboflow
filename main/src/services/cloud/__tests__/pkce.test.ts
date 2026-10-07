import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkcePair, createState, timingSafeEqualStr } from '../pkce';

describe('pkce', () => {
  it('creates a 43-char verifier in the RFC 7636 charset', () => {
    const { verifier } = createPkcePair();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  });

  it('derives the challenge as base64url(sha256(verifier)), 43 chars', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('creates a different verifier each time', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });

  it('createState matches the server charset and length window', () => {
    for (let i = 0; i < 20; i += 1) expect(createState()).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(createState()).not.toBe(createState());
  });

  it('timingSafeEqualStr compares equal strings, differing strings and length mismatches', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', 'a')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});
