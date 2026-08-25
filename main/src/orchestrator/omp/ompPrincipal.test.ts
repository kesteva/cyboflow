/**
 * Tests for `resolveOmpPrincipal` — the fail-closed supervise opt-in.
 */
import { describe, expect, it } from 'vitest';
import { resolveOmpPrincipal } from './ompPrincipal';
import { OMP_SUPERVISE_CAPABILITY } from '../../../../shared/types/ompCommand';

const KEY = 'CYBOFLOW_OMP_SUPERVISE';

function withEnv(value: string | undefined): () => void {
  const saved = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  return () => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  };
}

describe('resolveOmpPrincipal', () => {
  it('grants no capability by default (fail closed)', () => {
    const restore = withEnv(undefined);
    try {
      const principal = resolveOmpPrincipal();
      expect(principal.userId).toBe('local');
      expect(principal.capabilities.size).toBe(0);
    } finally {
      restore();
    }
  });

  it('grants omp:supervise when the env is truthy', () => {
    for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      const restore = withEnv(value);
      try {
        expect(resolveOmpPrincipal().capabilities.has(OMP_SUPERVISE_CAPABILITY)).toBe(true);
      } finally {
        restore();
      }
    }
  });

  it('does not grant supervise for falsy values', () => {
    for (const value of ['0', 'false', 'off', 'no', '', '   ']) {
      const restore = withEnv(value);
      try {
        expect(resolveOmpPrincipal().capabilities.has(OMP_SUPERVISE_CAPABILITY)).toBe(false);
      } finally {
        restore();
      }
    }
  });

  it('grants omp:supervise from Aria mode with no env var set', () => {
    const restore = withEnv(undefined);
    try {
      // The Settings toggle IS the grant: an operator turning on remote-fleet
      // supervision is exactly the person authorizing it, so a desktop feature
      // does not need a shell incantation to switch on.
      expect(resolveOmpPrincipal(true).capabilities.has(OMP_SUPERVISE_CAPABILITY)).toBe(true);
      expect(resolveOmpPrincipal(false).capabilities.has(OMP_SUPERVISE_CAPABILITY)).toBe(false);
    } finally {
      restore();
    }
  });

  it('keeps the env var as an override for hosts with no Settings UI', () => {
    const restore = withEnv('1');
    try {
      // Aria mode off but the env explicitly on — a headless/CI host. Either
      // source alone grants; they are OR-ed, not AND-ed.
      expect(resolveOmpPrincipal(false).capabilities.has(OMP_SUPERVISE_CAPABILITY)).toBe(true);
    } finally {
      restore();
    }
  });

  it('defaults ariaMode to false so an unaware caller still fails closed', () => {
    const restore = withEnv(undefined);
    try {
      expect(resolveOmpPrincipal().capabilities.size).toBe(0);
    } finally {
      restore();
    }
  });
});
