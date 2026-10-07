/**
 * PKCE (RFC 7636, S256) and the sign-in `state`. node:crypto only.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** verifier = 32 random bytes, base64url (43 chars); challenge = base64url(sha256(verifier)) (43 chars). */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 32 random bytes, base64url (43 chars). */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/** Length check first (timingSafeEqual throws on unequal lengths), then a constant-time compare. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
