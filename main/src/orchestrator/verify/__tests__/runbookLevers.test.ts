import { describe, expect, it } from 'vitest';
import { resolveLeverEnv } from '../runbookLevers';

const BASE = Object.freeze({ VERIFY_PORT: '4300', VERIFY_ATTEST_NONCE: 'nonce-1', VERIFY_MODALITY: 'web' });
const VALUES = { port: '4300', nonce: 'nonce-1', dataDir: '/artifacts/data/vr-1' } as const;

describe('resolveLeverEnv', () => {
  it('exports a declared portEnv bound to the leased port', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: 'PORT' }, VALUES);
    expect(additions).toEqual({ PORT: '4300' });
    expect(dropped).toEqual([]);
  });

  it('exports a declared nonceEnv bound to this request nonce', () => {
    const { additions } = resolveLeverEnv(BASE, { nonceEnv: 'APP_BUILD_ID' }, VALUES);
    expect(additions).toEqual({ APP_BUILD_ID: 'nonce-1' });
  });

  it('exports every bindable lever at once, and never the CLI flag', () => {
    const { additions } = resolveLeverEnv(
      BASE,
      { portEnv: 'PORT', nonceEnv: 'APP_BUILD_ID', dataDirEnv: 'CYBOFLOW_DIR', cdpPortFlag: '--x' },
      VALUES,
    );
    // cdpPortFlag is a CLI flag, not an env var — there is no environment for
    // this seam to put it in, so it stays permanently unbound.
    expect(additions).toEqual({
      PORT: '4300',
      APP_BUILD_ID: 'nonce-1',
      CYBOFLOW_DIR: '/artifacts/data/vr-1',
    });
  });

  // F3 / RC4 — dataDirEnv was parsed, hashed and documented while being bound
  // by nothing, which is how an app under verification kept re-reading the
  // PREVIOUS attempt's state.
  it('exports a declared dataDirEnv bound to this request fresh data dir', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { dataDirEnv: 'CYBOFLOW_DIR' }, VALUES);
    expect(additions).toEqual({ CYBOFLOW_DIR: '/artifacts/data/vr-1' });
    expect(dropped).toEqual([]);
  });

  it('skips dataDirEnv when the harness provisioned no data dir', () => {
    const { additions, dropped } = resolveLeverEnv(
      BASE,
      { dataDirEnv: 'CYBOFLOW_DIR' },
      { ...VALUES, dataDir: null },
    );
    expect(additions).toEqual({});
    expect(dropped).toEqual([]);
  });

  it('refuses to let dataDirEnv shadow a harness variable', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { dataDirEnv: 'VERIFY_MODALITY' }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([
      { lever: 'dataDirEnv', name: 'VERIFY_MODALITY', reason: 'shadows-harness' },
    ]);
  });

  it.each(['PATH', 'NODE_PATH', 'HOME'])('drops dataDirEnv naming %s', (name) => {
    const { additions, dropped } = resolveLeverEnv(BASE, { dataDirEnv: name }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([{ lever: 'dataDirEnv', name, reason: 'denied' }]);
  });

  it('drops a malformed dataDirEnv name', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { dataDirEnv: 'cyboflow dir' }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([{ lever: 'dataDirEnv', name: 'cyboflow dir', reason: 'malformed' }]);
  });

  it('exports nothing when the runbook declares no levers', () => {
    expect(resolveLeverEnv(BASE, undefined, VALUES)).toEqual({ additions: {}, dropped: [] });
  });

  it('skips portEnv when the task implies no server', () => {
    const { additions, dropped } = resolveLeverEnv(
      BASE,
      { portEnv: 'PORT' },
      { port: null, nonce: 'n', dataDir: null },
    );
    expect(additions).toEqual({});
    expect(dropped).toEqual([]);
  });

  // Rule 1 — a lever can never rewrite the harness's own contract.
  it('refuses to shadow a harness variable that carries a different value', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { nonceEnv: 'VERIFY_PORT' }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([{ lever: 'nonceEnv', name: 'VERIFY_PORT', reason: 'shadows-harness' }]);
  });

  it('treats a lever naming the harness variable that already carries the value as a silent no-op', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: 'VERIFY_PORT' }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([]);
  });

  // Rule 2 — a machine-authored name that configures execution is not a lever.
  it.each(['PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'IFS'])(
    'drops %s as a denied execution-environment name',
    (name) => {
      const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: name }, VALUES);
      expect(additions).toEqual({});
      expect(dropped).toEqual([{ lever: 'portEnv', name, reason: 'denied' }]);
    },
  );

  it.each(['Path', 'port', 'PORT-1', 'PORT ', '', '1PORT', 'PORT=4300'])(
    'drops %o as a malformed env identifier',
    (name) => {
      const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: name }, VALUES);
      expect(additions).toEqual({});
      expect(dropped).toEqual([{ lever: 'portEnv', name, reason: 'malformed' }]);
    },
  );

  it('does not mutate the base env it is given', () => {
    const base = { VERIFY_PORT: '4300' };
    resolveLeverEnv(base, { portEnv: 'PORT', nonceEnv: 'BUILD_ID' }, VALUES);
    expect(base).toEqual({ VERIFY_PORT: '4300' });
  });
});
