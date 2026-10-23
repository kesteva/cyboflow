/**
 * Unit tests for the orch.sock per-run bearer-token registry.
 *
 * The registry is the only thing standing between a self-declared runId on the
 * wire and that run's powers, so the properties pinned here are the ones the
 * socket server's refusal path depends on: tokens are unguessable, stable per
 * run, never shared across runs, and compared without a length oracle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  OrchTokenRegistry,
  ORCH_TOKEN_ENV_VAR,
  ORCH_TOKEN_FILE_ENV_VAR,
  ORCH_AUTH_KILL_SWITCH_ENV_VAR,
  isOrchSockAuthDisabled,
  mintOrchToken,
  orchTokenEnv,
  orchTokenRegistry,
  readOrchToken,
} from '../orchAuthToken';

describe('OrchTokenRegistry', () => {
  let registry: OrchTokenRegistry;

  beforeEach(() => {
    registry = new OrchTokenRegistry();
  });

  it('mints a 64-char hex token', () => {
    const token = registry.mint('run-1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the SAME token for a runId it has already minted', () => {
    // Load-bearing: a run spawns several clients at different times (MCP
    // subprocess, PTY, shell hooks) and every one must present one secret.
    const first = registry.mint('run-1');
    expect(registry.mint('run-1')).toBe(first);
    expect(registry.mint('run-1')).toBe(first);
  });

  it('mints a distinct token per runId', () => {
    expect(registry.mint('run-1')).not.toBe(registry.mint('run-2'));
  });

  it('verifies the matching token and rejects everything else', () => {
    const token = registry.mint('run-1');
    const other = registry.mint('run-2');

    expect(registry.verify('run-1', token)).toBe(true);
    expect(registry.verify('run-1', other)).toBe(false);
    expect(registry.verify('run-1', undefined)).toBe(false);
    expect(registry.verify('run-1', '')).toBe(false);
    // A near-miss must not pass: no prefix comparison anywhere.
    expect(registry.verify('run-1', token.slice(0, -1))).toBe(false);
    expect(registry.verify('run-1', token + '0')).toBe(false);
    expect(registry.verify('run-1', token.toUpperCase())).toBe(false);
  });

  it('rejects any token for a runId that was never minted', () => {
    const token = registry.mint('run-1');
    expect(registry.verify('run-unknown', token)).toBe(false);
    expect(registry.verify('run-unknown', undefined)).toBe(false);
  });

  it('compares tokens of the wrong LENGTH without throwing (no length oracle)', () => {
    // crypto.timingSafeEqual throws on a length mismatch, which is why both
    // sides are hashed first. A throw here would escape into the receive loop.
    registry.mint('run-1');
    expect(() => registry.verify('run-1', 'x')).not.toThrow();
    expect(registry.verify('run-1', 'x')).toBe(false);
    expect(registry.verify('run-1', 'y'.repeat(4096))).toBe(false);
  });

  it('revoke() drops the token and clear() empties the registry', () => {
    const token = registry.mint('run-1');
    registry.revoke('run-1');
    expect(registry.has('run-1')).toBe(false);
    expect(registry.verify('run-1', token)).toBe(false);

    registry.mint('run-2');
    registry.clear();
    expect(registry.has('run-2')).toBe(false);
  });
});

describe('env helpers', () => {
  const priorKill = process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR];

  afterEach(() => {
    if (priorKill === undefined) delete process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR];
    else process.env[ORCH_AUTH_KILL_SWITCH_ENV_VAR] = priorKill;
    orchTokenRegistry.revoke('run-env-helper');
  });

  it('orchTokenEnv yields the run token under CYBOFLOW_ORCH_TOKEN and agrees with mintOrchToken', () => {
    const env = orchTokenEnv('run-env-helper');
    expect(Object.keys(env)).toEqual([ORCH_TOKEN_ENV_VAR]);
    // Same process-wide registry — a spawn seam and the server must agree.
    expect(env[ORCH_TOKEN_ENV_VAR]).toBe(mintOrchToken('run-env-helper'));
    expect(orchTokenRegistry.verify('run-env-helper', env[ORCH_TOKEN_ENV_VAR])).toBe(true);
  });

  it('readOrchToken treats an unset or empty var as absent', () => {
    expect(readOrchToken({ [ORCH_TOKEN_ENV_VAR]: 'abc' })).toBe('abc');
    expect(readOrchToken({})).toBeUndefined();
    expect(readOrchToken({ [ORCH_TOKEN_ENV_VAR]: '' })).toBeUndefined();
  });

  describe('readOrchToken file fallback', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'orch-token-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('env var wins over the file', () => {
      const f = join(dir, 't');
      writeFileSync(f, 'from-file');
      expect(readOrchToken({ [ORCH_TOKEN_ENV_VAR]: 'from-env', [ORCH_TOKEN_FILE_ENV_VAR]: f })).toBe('from-env');
    });

    it('falls back to the file when the env var is unset or empty, trimming whitespace', () => {
      const f = join(dir, 't');
      writeFileSync(f, '  filetok\n');
      expect(readOrchToken({ [ORCH_TOKEN_FILE_ENV_VAR]: f })).toBe('filetok');
      expect(readOrchToken({ [ORCH_TOKEN_ENV_VAR]: '', [ORCH_TOKEN_FILE_ENV_VAR]: f })).toBe('filetok');
    });

    it('returns undefined for a missing, empty, or oversize file', () => {
      expect(readOrchToken({ [ORCH_TOKEN_FILE_ENV_VAR]: join(dir, 'nope') })).toBeUndefined();
      const empty = join(dir, 'empty');
      writeFileSync(empty, ' \n');
      expect(readOrchToken({ [ORCH_TOKEN_FILE_ENV_VAR]: empty })).toBeUndefined();
      const big = join(dir, 'big');
      writeFileSync(big, 'a'.repeat(4097));
      expect(readOrchToken({ [ORCH_TOKEN_FILE_ENV_VAR]: big })).toBeUndefined();
      const ok = join(dir, 'ok');
      writeFileSync(ok, 'a'.repeat(4096));
      expect(readOrchToken({ [ORCH_TOKEN_FILE_ENV_VAR]: ok })).toHaveLength(4096);
    });

    it('treats an unset file var as absent', () => {
      expect(readOrchToken({ [ORCH_TOKEN_FILE_ENV_VAR]: '' })).toBeUndefined();
    });
  });

  it('isOrchSockAuthDisabled only fires on an exact "1"', () => {
    expect(isOrchSockAuthDisabled({})).toBe(false);
    expect(isOrchSockAuthDisabled({ [ORCH_AUTH_KILL_SWITCH_ENV_VAR]: '1' })).toBe(true);
    // Anything else stays SAFE — a stray 'true'/'0'/'' must not disable auth.
    expect(isOrchSockAuthDisabled({ [ORCH_AUTH_KILL_SWITCH_ENV_VAR]: 'true' })).toBe(false);
    expect(isOrchSockAuthDisabled({ [ORCH_AUTH_KILL_SWITCH_ENV_VAR]: '0' })).toBe(false);
    expect(isOrchSockAuthDisabled({ [ORCH_AUTH_KILL_SWITCH_ENV_VAR]: '' })).toBe(false);
  });
});
