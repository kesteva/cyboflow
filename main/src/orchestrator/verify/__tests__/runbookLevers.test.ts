import { describe, expect, it } from 'vitest';
import { isBindableLeverName, resolveLeverEnv } from '../runbookLevers';

const BASE = Object.freeze({ VERIFY_PORT: '4300', VERIFY_ATTEST_NONCE: 'nonce-1', VERIFY_MODALITY: 'web' });
const VALUES = {
  port: '4300',
  nonce: 'nonce-1',
  dataDir: '/artifacts/data/vr-1',
  simUdid: null,
  derivedData: null,
} as const;

/** The mobile half: a leased device and its private DerivedData, as one request sees them. */
const MOBILE_VALUES = {
  ...VALUES,
  port: null,
  simUdid: 'B1C0FFEE-0000-4000-8000-0123456789AB',
  derivedData: '/data/verify-mobile/vr-1/DerivedData',
} as const;

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
      {
        portEnv: 'PORT',
        nonceEnv: 'APP_BUILD_ID',
        dataDirEnv: 'CYBOFLOW_DIR',
        simUdidEnv: 'ACME_SIM',
        derivedDataEnv: 'ACME_DERIVED',
        cdpPortFlag: '--x',
      },
      { ...MOBILE_VALUES, port: '4300' },
    );
    // cdpPortFlag is a CLI flag, not an env var — there is no environment for
    // this seam to put it in, so it stays permanently unbound.
    expect(additions).toEqual({
      PORT: '4300',
      APP_BUILD_ID: 'nonce-1',
      CYBOFLOW_DIR: '/artifacts/data/vr-1',
      ACME_SIM: MOBILE_VALUES.simUdid,
      ACME_DERIVED: MOBILE_VALUES.derivedData,
    });
  });

  // §6.3 — the mobile tier's two levers. NAMES only: a persisted UDID is exactly
  // the resolved value §5.3 forbids, so these bind per request and nowhere else.
  describe('the mobile levers', () => {
    it('binds a declared simUdidEnv to THIS request leased device', () => {
      const { additions, dropped } = resolveLeverEnv(BASE, { simUdidEnv: 'ACME_SIM' }, MOBILE_VALUES);
      expect(additions).toEqual({ ACME_SIM: MOBILE_VALUES.simUdid });
      expect(dropped).toEqual([]);
    });

    it('binds a declared derivedDataEnv to this request private DerivedData', () => {
      const { additions, dropped } = resolveLeverEnv(
        BASE,
        { derivedDataEnv: 'ACME_DERIVED' },
        MOBILE_VALUES,
      );
      expect(additions).toEqual({ ACME_DERIVED: MOBILE_VALUES.derivedData });
      expect(dropped).toEqual([]);
    });

    // Off the mobile path there is no device and no DerivedData, so a runbook
    // that declares both levers is a silent no-op rather than a drop.
    it('exports neither when the request leased no simulator', () => {
      const { additions, dropped } = resolveLeverEnv(
        BASE,
        { simUdidEnv: 'ACME_SIM', derivedDataEnv: 'ACME_DERIVED' },
        VALUES,
      );
      expect(additions).toEqual({});
      expect(dropped).toEqual([]);
    });

    // The newer levers go through the SAME bind as the older ones — a runbook
    // cannot reach the execution environment by coming in through this door.
    it.each(['PATH', 'DYLD_INSERT_LIBRARIES'])('drops a simUdidEnv naming %s', (name) => {
      const { additions, dropped } = resolveLeverEnv(BASE, { simUdidEnv: name }, MOBILE_VALUES);
      expect(additions).toEqual({});
      expect(dropped).toEqual([{ lever: 'simUdidEnv', name, reason: 'denied' }]);
    });

    it('drops a malformed derivedDataEnv name', () => {
      const { additions, dropped } = resolveLeverEnv(
        BASE,
        { derivedDataEnv: 'derived data' },
        MOBILE_VALUES,
      );
      expect(additions).toEqual({});
      expect(dropped).toEqual([
        { lever: 'derivedDataEnv', name: 'derived data', reason: 'malformed' },
      ]);
    });

    it('refuses to let simUdidEnv shadow a harness variable', () => {
      const { additions, dropped } = resolveLeverEnv(
        { ...BASE, VERIFY_SIM_UDID: 'harness-owned' },
        { simUdidEnv: 'VERIFY_SIM_UDID' },
        MOBILE_VALUES,
      );
      expect(additions).toEqual({});
      expect(dropped).toEqual([
        { lever: 'simUdidEnv', name: 'VERIFY_SIM_UDID', reason: 'shadows-harness' },
      ]);
    });

    it('treats simUdidEnv naming the harness var that already carries the udid as a no-op', () => {
      const { additions, dropped } = resolveLeverEnv(
        { ...BASE, VERIFY_SIM_UDID: MOBILE_VALUES.simUdid },
        { simUdidEnv: 'VERIFY_SIM_UDID' },
        MOBILE_VALUES,
      );
      expect(additions).toEqual({});
      expect(dropped).toEqual([]);
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
      { port: null, nonce: 'n', dataDir: null, simUdid: null, derivedData: null },
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

describe('isBindableLeverName', () => {
  /**
   * The runner's harness env as a cdp-app request sees it: every key is
   * `VERIFY_*` or the (denied) PATH, and VERIFY_DATA_DIR carries the data dir.
   */
  const HARNESS_BASE = Object.freeze({
    VERIFY_ARTIFACTS_DIR: '/artifacts/run-1',
    PATH: '/usr/bin',
    VERIFY_DATA_DIR: VALUES.dataDir,
    VERIFY_DRIVER_PORT: '9300',
    VERIFY_DRIVER: '/driver.mjs',
    VERIFY_ATTEST_NONCE: VALUES.nonce,
    VERIFY_MODALITY: 'cdp-app',
    VERIFY_PEEKABOO_BIN: '/peekaboo',
    VERIFY_PORT: VALUES.port,
  });

  it.each([
    ['CYBOFLOW_DIR', true],
    ['APP_DATA_DIR', true],
    // The lever's own harness var already carries the value: a correct no-op.
    ['VERIFY_DATA_DIR', true],
    ['cyboflow_dir', false],
    ['CYBOFLOW DIR', false],
    ['', false],
    ['HOME', false],
    ['NODE_OPTIONS', false],
    ['VERIFY_PORT', false],
    ['VERIFY_ARTIFACTS_DIR', false],
  ] as const)('dataDirEnv %j → %s, and agrees with what resolveLeverEnv exports', (name, bindable) => {
    expect(isBindableLeverName('dataDirEnv', name)).toBe(bindable);
    const { additions, dropped } = resolveLeverEnv(HARNESS_BASE, { dataDirEnv: name }, VALUES);
    const exported = additions[name] === VALUES.dataDir || (dropped.length === 0 && HARNESS_BASE[name as keyof typeof HARNESS_BASE] === VALUES.dataDir);
    expect(exported).toBe(bindable);
  });

  it("treats each lever's own harness var as bound and every other VERIFY_* name as a shadow", () => {
    expect(isBindableLeverName('portEnv', 'VERIFY_PORT')).toBe(true);
    expect(isBindableLeverName('portEnv', 'VERIFY_DATA_DIR')).toBe(false);
    expect(isBindableLeverName('nonceEnv', 'VERIFY_ATTEST_NONCE')).toBe(true);
    expect(isBindableLeverName('simUdidEnv', 'VERIFY_SIM_UDID')).toBe(true);
    expect(isBindableLeverName('derivedDataEnv', 'VERIFY_DERIVED_DATA')).toBe(true);
  });
});
