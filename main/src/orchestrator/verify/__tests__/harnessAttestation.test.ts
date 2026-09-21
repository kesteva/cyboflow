/**
 * harnessAttestation unit tests — the §7.1 identity probe the HARNESS performs
 * itself, now that `.driver/attest.json` is agent-forgeable and no longer read.
 *
 * Everything that touches the outside world is injected (an HTTP GET, a CDP
 * evaluate, a window listing), so this suite dials no socket, launches no
 * browser, and spawns no peekaboo. `sleep` is injected too — the retry loop is
 * asserted by counting attempts and delays, not by spending real seconds.
 *
 * The invariants worth protecting here, in priority order:
 *  1. A probe THROW is `verified: false`, never an exception. An escape lands in
 *     the runner's outer catch, which fails OPEN (`skipped` ADVANCES the lane) —
 *     the exact hole this module exists to close.
 *  2. `verified: true` requires the surface to hand back something only THIS
 *     request's deliverable could know; a 200, a rendered page, or a window
 *     existing is never enough on its own.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  performHarnessAttestation,
  HARNESS_ATTEST_ATTEMPTS,
  HARNESS_ATTEST_RETRY_DELAY_MS,
  BUNDLE_IDENTITY_RESIDUAL,
  MOBILE_INSTALL_RECORD_FILE,
  type HarnessAttestationDeps,
  type MobileAttestationContext,
} from '../harnessAttestation';
import type { AttestationSpec } from '../../../../../shared/types/visualVerification';

const NONCE = 'nonce-9f3c-4a21-bb70';
const VERIFY_PORT = 29260;
const DRIVER_PORT = 29261;

interface Probes {
  deps: HarnessAttestationDeps;
  httpGetBody: ReturnType<typeof vi.fn>;
  cdpEvaluate: ReturnType<typeof vi.fn>;
  listNativeWindows: ReturnType<typeof vi.fn>;
  sleeps: number[];
}

/**
 * What each probe ANSWERS — implementations, not whole deps. The spy wrapper is
 * always built here, so `probes.cdpEvaluate` is guaranteed to be the very
 * function the module called (a test that swapped in its own `vi.fn` via a deps
 * override would leave the returned spy silently unused, and every
 * `toHaveBeenCalled` on it would be a lie).
 */
interface ProbeAnswers {
  httpGetBody?: (url: string, timeoutMs: number) => Promise<string>;
  cdpEvaluate?: (port: number, expression: string, timeoutMs: number) => Promise<string>;
  listNativeWindows?: (app: string) => Promise<string[]>;
}

/** All three probes as spies, defaulting to answers that FAIL to verify (opt into success per test). */
function makeProbes(answers: ProbeAnswers = {}): Probes {
  const sleeps: number[] = [];
  const httpGetBody = vi.fn(answers.httpGetBody ?? (async (): Promise<string> => 'nothing useful here'));
  const cdpEvaluate = vi.fn(answers.cdpEvaluate ?? (async (): Promise<string> => ''));
  const listNativeWindows = vi.fn(answers.listNativeWindows ?? (async (): Promise<string[]> => []));
  const deps: HarnessAttestationDeps = {
    httpGetBody,
    cdpEvaluate,
    listNativeWindows,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { deps, httpGetBody, cdpEvaluate, listNativeWindows, sleeps };
}

function run(spec: AttestationSpec, probes: Probes, verifyPort: number | null = VERIFY_PORT) {
  return performHarnessAttestation(spec, {
    verifyPort,
    driverPort: DRIVER_PORT,
    nonce: NONCE,
    deps: probes.deps,
  });
}

// ---------------------------------------------------------------------------
// The kind matrix — one channel at a time, verified and not
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — http-endpoint', () => {
  it('GETs the leased port at the declared path and verifies on a body carrying the nonce', async () => {
    const probes = makeProbes({ httpGetBody: (async () => `{"verify":"${NONCE}"}`) });
    const result = await run({ kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' }, probes);

    expect(result).toMatchObject({ verified: true, kind: 'http-endpoint' });
    expect(probes.deps.httpGetBody).toHaveBeenCalledWith(
      `http://127.0.0.1:${VERIFY_PORT}/__cyboflow_verify__`,
      expect.any(Number),
    );
  });

  it('normalizes a path missing its leading slash', async () => {
    const probes = makeProbes({ httpGetBody: (async () => NONCE) });
    await run({ kind: 'http-endpoint', urlPath: '__cyboflow_verify__' }, probes);
    expect(probes.deps.httpGetBody).toHaveBeenCalledWith(
      `http://127.0.0.1:${VERIFY_PORT}/__cyboflow_verify__`,
      expect.any(Number),
    );
  });

  it('does NOT verify a port that answers without the nonce — that is the stale-server case', async () => {
    const probes = makeProbes({ httpGetBody: (async () => '<html>some other app</html>') });
    const result = await run({ kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' }, probes);

    expect(result.verified).toBe(false);
    expect(result.detail).toContain('is NOT this deliverable');
  });

  it('does not verify when no server port was leased (nothing to ask)', async () => {
    const probes = makeProbes({ httpGetBody: (async () => NONCE) });
    const result = await run({ kind: 'http-endpoint', urlPath: '/x' }, probes, null);

    expect(result.verified).toBe(false);
    expect(probes.deps.httpGetBody).not.toHaveBeenCalled();
  });
});

describe('performHarnessAttestation — dom-marker', () => {
  it('evaluates over the DRIVER port and verifies when the element carries the nonce', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => `build ${NONCE}`) });
    const result = await run({ kind: 'dom-marker', selector: '[data-verify]' }, probes);

    expect(result).toMatchObject({ verified: true, kind: 'dom-marker' });
    const [port, expression] = probes.cdpEvaluate.mock.calls[0];
    expect(port).toBe(DRIVER_PORT);
    // Reads BOTH channels the spec allows, with the selector embedded as a
    // string literal (a quote in the selector must not rewrite the expression).
    expect(expression).toContain('document.querySelector("[data-verify]")');
    expect(expression).toContain('textContent');
    expect(expression).toContain('data-verify-nonce');
  });

  it('does not verify when the marker renders without the nonce', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => 'Settings ') });
    const result = await run({ kind: 'dom-marker', selector: '#root' }, probes);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('#root');
  });

  it('embeds a quote-bearing selector safely', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => NONCE) });
    await run({ kind: 'dom-marker', selector: '[data-x="a b"]' }, probes);
    expect(probes.cdpEvaluate.mock.calls[0][1]).toContain(String.raw`document.querySelector("[data-x=\"a b\"]")`);
  });
});

describe('performHarnessAttestation — cdp-token', () => {
  it('verifies on an EXACT match of the declared expected value', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => 'v1-abc') });
    const result = await run(
      { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1-abc' },
      probes,
    );
    expect(result).toMatchObject({ verified: true, kind: 'cdp-token' });
    expect(probes.cdpEvaluate).toHaveBeenCalledWith(DRIVER_PORT, 'window.__BUILD__', expect.any(Number));
  });

  it('does not verify a near-miss, and says what it saw', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => 'v0-old') });
    const result = await run(
      { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1-abc' },
      probes,
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('v0-old');
    expect(result.detail).toContain('v1-abc');
  });
});

describe('performHarnessAttestation — window-identity', () => {
  it('verifies on a title matching the pattern as a REGEX', async () => {
    const probes = makeProbes({ listNativeWindows: (async () => ['Finder', 'Cyboflow — dev']) });
    const result = await run(
      { kind: 'window-identity', titlePattern: 'Cyboflow.*dev', app: 'Cyboflow' },
      probes,
    );
    expect(result).toMatchObject({ verified: true, kind: 'window-identity' });
    expect(result.detail).toContain('weakest channel');
    // The listing is SCOPED to the declared app — peekaboo has no host-wide
    // form, and an unscoped match would not be an identity check.
    expect(probes.listNativeWindows).toHaveBeenCalledWith('Cyboflow');
  });

  it('falls back to a substring test for an invalid regex (never a probe failure)', async () => {
    const probes = makeProbes({ listNativeWindows: (async () => ['My App (v1)']) });
    const result = await run(
      { kind: 'window-identity', titlePattern: '(v1)', app: 'My App' },
      probes,
    );
    expect(result.verified).toBe(true);
  });

  it('does not verify when no listed window matches', async () => {
    const probes = makeProbes({ listNativeWindows: (async () => ['Finder', 'Safari']) });
    const result = await run(
      { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
      probes,
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('2 window(s) of "Cyboflow"');
  });
});

describe('performHarnessAttestation — file-identity', () => {
  it('is verified by construction and probes NOTHING', async () => {
    const probes = makeProbes();
    const result = await run({ kind: 'file-identity' }, probes);

    expect(result).toMatchObject({ verified: true, kind: 'file-identity' });
    expect(probes.httpGetBody).not.toHaveBeenCalled();
    expect(probes.cdpEvaluate).not.toHaveBeenCalled();
    expect(probes.listNativeWindows).not.toHaveBeenCalled();
    expect(probes.sleeps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The retry loop (§5.4 flakiness guard)
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — retries', () => {
  it('re-probes up to HARNESS_ATTEST_ATTEMPTS, spaced by the retry delay', async () => {
    const probes = makeProbes();
    const result = await run({ kind: 'http-endpoint', urlPath: '/x' }, probes);

    expect(probes.httpGetBody).toHaveBeenCalledTimes(HARNESS_ATTEST_ATTEMPTS);
    expect(probes.sleeps).toEqual(
      Array.from({ length: HARNESS_ATTEST_ATTEMPTS - 1 }, () => HARNESS_ATTEST_RETRY_DELAY_MS),
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain(`${HARNESS_ATTEST_ATTEMPTS}×`);
  });

  it('STOPS at the first verified attempt and does not sleep afterwards', async () => {
    // The realistic shape: a dev server still restarting on the first ask.
    let call = 0;
    const probes = makeProbes({
      httpGetBody: async () => {
        call += 1;
        if (call === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:29260');
        return `ok ${NONCE}`;
      },
    });
    const result = await run({ kind: 'http-endpoint', urlPath: '/x' }, probes);

    expect(result.verified).toBe(true);
    expect(probes.httpGetBody).toHaveBeenCalledTimes(2);
    expect(probes.sleeps).toEqual([HARNESS_ATTEST_RETRY_DELAY_MS]);
  });

  it('retries a DEFINITIVE-looking disagreement too — from outside, "wrong" and "not yet" are the same observation', async () => {
    let call = 0;
    const probes = makeProbes({
      cdpEvaluate: async () => {
        call += 1;
        return call < 3 ? 'undefined' : 'v1';
      },
    });
    const result = await run({ kind: 'cdp-token', expression: 'window.__B__', expected: 'v1' }, probes);
    expect(result.verified).toBe(true);
    expect(probes.cdpEvaluate).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// A throw is an ANSWER, never an exception
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — probe failures', () => {
  const throwers: Array<[string, AttestationSpec, ProbeAnswers]> = [
    [
      'a refused HTTP connection',
      { kind: 'http-endpoint', urlPath: '/x' },
      {
        httpGetBody: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:29260');
        },
      },
    ],
    [
      'an unreachable CDP endpoint (the agent shut its own surface down)',
      { kind: 'cdp-token', expression: 'window.__B__', expected: 'v1' },
      {
        cdpEvaluate: async () => {
          throw new Error('CDP endpoint on port 29261 exposes no page (the surface was closed?)');
        },
      },
    ],
    [
      'a missing peekaboo binary',
      { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
      {
        listNativeWindows: async () => {
          throw new Error('spawn peekaboo ENOENT');
        },
      },
    ],
  ];

  for (const [label, spec, answers] of throwers) {
    it(`resolves verified:false with the error in detail for ${label}`, async () => {
      const probes = makeProbes(answers);
      const result = await run(spec, probes);
      expect(result.verified).toBe(false);
      expect(result.kind).toBe(spec.kind);
      expect(result.detail).toContain('probe failed');
    });
  }

  it('never rejects, whatever a probe does — a throw here would fail OPEN in the runner', async () => {
    const probes = makeProbes({
      httpGetBody: () => Promise.reject(new Error('a rejection with no message shape')),
    });
    await expect(run({ kind: 'http-endpoint', urlPath: '/x' }, probes)).resolves.toMatchObject({
      verified: false,
    });
  });
});

// ---------------------------------------------------------------------------
// §9 bundle-identity — the mobile channel. The harness re-derives what it can
// and treats the driver's own record as a CLAIM, so a forged record can only
// make this probe FAIL.
// ---------------------------------------------------------------------------

const SIM_UDID = 'B1C0FFEE-0000-4000-8000-0123456789AB';
const DERIVED = '/data/verify-mobile/vr-1/DerivedData';
const BUILT = `${DERIVED}/Build/Products/Debug-iphonesimulator/Acme.app`;
const INSTALLED = '/sim/data/Containers/Bundle/Application/ABC/Acme.app';
const SHA = 'a'.repeat(64);
const SPEC = { kind: 'bundle-identity', bundleId: 'com.acme.ios' } as const;

interface InstallRecordOverrides {
  builtPath?: string;
  installedPath?: string;
  builtSha256?: string;
  installedSha256?: string;
  bundleId?: string;
  executable?: string;
}

function installRecord(overrides: InstallRecordOverrides = {}): string {
  return JSON.stringify({
    builtPath: BUILT,
    installedPath: INSTALLED,
    builtSha256: SHA,
    installedSha256: SHA,
    bundleId: 'com.acme.ios',
    executable: 'Acme',
    installedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  });
}

interface MobileAnswers {
  /** What the record file read answers; a rejection means "no record on disk". */
  readTextFile?: (absPath: string) => Promise<string>;
  realpath?: (absPath: string) => Promise<string>;
  sha256File?: (absPath: string) => Promise<string>;
  exec?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** The happy-path mobile probes, each overridable one at a time. */
function makeMobileProbes(answers: MobileAnswers = {}): Probes & {
  readTextFile: ReturnType<typeof vi.fn>;
  sha256File: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
} {
  const base = makeProbes();
  const readTextFile = vi.fn(answers.readTextFile ?? (async (): Promise<string> => installRecord()));
  const realpath = vi.fn(answers.realpath ?? (async (p: string): Promise<string> => p));
  const sha256File = vi.fn(answers.sha256File ?? (async (): Promise<string> => SHA));
  const exec = vi.fn(
    answers.exec ??
      (async (): Promise<{ code: number | null; stdout: string; stderr: string }> => ({
        code: 0,
        stdout: `${INSTALLED}\n`,
        stderr: '',
      })),
  );
  const deps: HarnessAttestationDeps = { ...base.deps, readTextFile, realpath, sha256File, exec };
  return { ...base, deps, readTextFile, sha256File, exec };
}

const MOBILE_CTX: MobileAttestationContext = {
  artifactsDir: '/artifacts/run-1',
  derivedDataDir: DERIVED,
  simUdid: SIM_UDID,
};

// `null` (not `undefined`) is the no-context spelling: passing `undefined`
// explicitly would re-trigger the default and silently test the happy path.
function runBundle(probes: Probes, mobile: MobileAttestationContext | null = MOBILE_CTX) {
  return performHarnessAttestation(SPEC, {
    verifyPort: null,
    driverPort: null,
    nonce: NONCE,
    ...(mobile ? { mobile } : {}),
    deps: probes.deps,
  });
}

/*
 * iOS Simulator only, so these model a DARWIN host: the fixtures are POSIX
 * absolute paths (`/Users/tester/...`, `/sim/data/Containers/...`) and the code
 * under test joins them with `node:path`. On a win32 runner that join yields
 * `\Users\tester\...`, which can never match the fixture — the suite would be
 * measuring the runner's path separator, not the behaviour. The production
 * paths are already darwin-gated (`if (this.platform !== 'darwin') return
 * null`), so there is nothing here for Windows to cover.
 */
describe.skipIf(process.platform === 'win32')('performHarnessAttestation — bundle-identity', () => {
  it('verifies when staged, recorded and RE-HASHED live all agree', async () => {
    const probes = makeMobileProbes();
    const result = await runBundle(probes);

    expect(result).toMatchObject({ verified: true, kind: 'bundle-identity' });
    // The record is READ from the artifacts dir, and the container is ASKED for
    // rather than taken from the record's own `installedPath`.
    expect(probes.readTextFile).toHaveBeenCalledWith(`/artifacts/run-1/${MOBILE_INSTALL_RECORD_FILE}`);
    expect(probes.exec).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'get_app_container', SIM_UDID, 'com.acme.ios', 'app'],
      expect.any(Number),
    );
    // The live hash is taken of the CONTAINER's executable, never the staged one.
    expect(probes.sha256File).toHaveBeenCalledWith(`${INSTALLED}/Acme`);
  });

  it('records both paths, both hashes and the two-part residual on the verdict', async () => {
    const result = await runBundle(makeMobileProbes());
    expect(result.detail).toContain(BUILT);
    expect(result.detail).toContain(INSTALLED);
    expect(result.detail).toContain(SHA);
    expect(result.detail).toContain(BUNDLE_IDENTITY_RESIDUAL);
  });

  it('does not verify when mobile-install never ran (no record on disk)', async () => {
    const probes = makeMobileProbes({
      readTextFile: async (): Promise<string> => {
        throw new Error('ENOENT');
      },
    });
    const result = await runBundle(probes);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('nothing was installed through the driver');
    expect(probes.exec).not.toHaveBeenCalled();
  });

  it('treats an unparseable / wrong-shaped record the same as no record', async () => {
    for (const body of ['not json at all', '{"builtPath":"/x"}']) {
      const result = await runBundle(makeMobileProbes({ readTextFile: async (): Promise<string> => body }));
      expect(result.verified).toBe(false);
      expect(result.detail).toContain('nothing was installed through the driver');
    }
  });

  // The escape this closes: a prebuilt bundle staged OUTSIDE the request dir,
  // reached through a symlink, would otherwise hash consistently on both sides.
  it('does not verify a staged product whose realpath escapes DerivedData', async () => {
    const probes = makeMobileProbes({
      realpath: async (p: string): Promise<string> =>
        p === BUILT ? '/Users/dev/prebuilt/Acme.app' : p,
    });
    const result = await runBundle(probes);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('escapes');
    expect(probes.exec).not.toHaveBeenCalled();
  });

  it('does not verify when the staged product is gone', async () => {
    const result = await runBundle(
      makeMobileProbes({
        realpath: async (p: string): Promise<string> => {
          if (p === BUILT) throw new Error('ENOENT');
          return p;
        },
      }),
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('is gone');
  });

  // The recorded `installedSha256` is never TRUSTED — it is cross-checked, and
  // the live re-hash is what decides.
  it('does not verify when the live installed hash differs from the recorded one', async () => {
    const result = await runBundle(makeMobileProbes({ sha256File: async (): Promise<string> => 'b'.repeat(64) }));
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('NOT the product staged for this request');
    expect(result.detail).toContain('b'.repeat(64));
  });

  it("does not verify when the driver's own two recorded hashes disagree", async () => {
    const result = await runBundle(
      makeMobileProbes({ readTextFile: async (): Promise<string> => installRecord({ installedSha256: 'c'.repeat(64) }) }),
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('disagrees with itself');
  });

  it('does not verify when the installed bundle id is not the declared one', async () => {
    const probes = makeMobileProbes({
      readTextFile: async (): Promise<string> => installRecord({ bundleId: 'com.other.app' }),
    });
    const result = await runBundle(probes);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('com.other.app');
    expect(probes.exec).not.toHaveBeenCalled();
  });

  it('does not verify when simctl cannot name a container', async () => {
    const result = await runBundle(
      makeMobileProbes({
        exec: async (): Promise<{ code: number | null; stdout: string; stderr: string }> => ({
          code: 2,
          stdout: '',
          stderr: 'No such file or directory',
        }),
      }),
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('get_app_container');
    expect(result.detail).toContain('No such file or directory');
  });

  it('does not verify when the harness holds no simulator context at all', async () => {
    const probes = makeMobileProbes();
    const result = await runBundle(probes, null);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('no simulator context');
    expect(probes.readTextFile).not.toHaveBeenCalled();
  });

  it('does not verify when the mobile probes were never wired', async () => {
    const result = await performHarnessAttestation(SPEC, {
      verifyPort: null,
      driverPort: null,
      nonce: NONCE,
      mobile: MOBILE_CTX,
      deps: makeProbes().deps,
    });
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('no simulator context');
  });

  it('NEVER throws, whatever a probe does', async () => {
    const result = await runBundle(
      makeMobileProbes({
        exec: async (): Promise<{ code: number | null; stdout: string; stderr: string }> => {
          throw new Error('xcrun exploded');
        },
      }),
    );
    expect(result).toMatchObject({ verified: false, kind: 'bundle-identity' });
    expect(result.detail).toContain('xcrun exploded');
  });
});

// ---------------------------------------------------------------------------
// A portless request — the two CDP-mediated channels have nothing to talk to
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — a null driver port', () => {
  it.each([
    { kind: 'dom-marker', selector: '#root' } as const,
    { kind: 'cdp-token', expression: 'window.__B__', expected: 'x' } as const,
  ])('does not verify $kind, and never dials CDP', async (spec) => {
    const probes = makeProbes({ cdpEvaluate: (async () => NONCE) });
    const result = await performHarnessAttestation(spec, {
      verifyPort: null,
      driverPort: null,
      nonce: NONCE,
      deps: probes.deps,
    });
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('no driver port was leased');
    expect(probes.cdpEvaluate).not.toHaveBeenCalled();
  });
});
