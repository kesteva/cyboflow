/**
 * PeekabooGrantProbe unit tests.
 *
 * NO real binary runs: a FAKE PeekabooProbeClient is dependency-injected
 * (binaryAvailable / permissions are knobbed). The fake drives the real probe
 * orchestration — the two-gate healthCheck (binary absent OR a TCC grant
 * declined ⇒ false, no throw, no hang) and probeGrants' three-way split
 * (granted / declined / could-not-ask).
 *
 * parsePermissionsJson is tested against the REAL shapes the CLI emits — the
 * v2.x `{ success, data: { permissions } }` envelope included, since reading
 * only the un-nested shapes is what made every probe report both grants denied.
 */
import { describe, expect, it } from 'vitest';
import { PeekabooGrantProbe, parsePermissionsJson, type PeekabooProbeClient } from '../peekabooGrantProbe';
import type { NativeGrants } from '../../../../../shared/types/visualVerification';

/** Per-test behaviour knobs for the fake PeekabooProbeClient. */
interface FakeOpts {
  /** Whether the `peekaboo` binary runs. Default true. */
  binary?: boolean;
  /** When set, binaryAvailable() rejects with this message. */
  binaryError?: string;
  /** The grants the CLI reports. Default: both held. */
  permissions?: NativeGrants;
  /** When set, permissions() rejects with this message (the CLI could not answer). */
  permissionsError?: string;
}

/** Recorded probe calls against the fake client. */
interface FakeCalls {
  binaryProbes: number;
  permissionProbes: number;
}

function makeFakeClient(opts: FakeOpts, calls: FakeCalls): PeekabooProbeClient {
  return {
    async binaryAvailable(): Promise<boolean> {
      calls.binaryProbes += 1;
      if (opts.binaryError) throw new Error(opts.binaryError);
      return opts.binary ?? true;
    },
    async permissions(): Promise<NativeGrants> {
      calls.permissionProbes += 1;
      if (opts.permissionsError) throw new Error(opts.permissionsError);
      return opts.permissions ?? { screenRecording: true, accessibility: true };
    },
  };
}

function freshCalls(): FakeCalls {
  return { binaryProbes: 0, permissionProbes: 0 };
}

describe('PeekabooGrantProbe', () => {
  it('healthCheck returns true when the binary is present AND both TCC grants are held', async () => {
    const calls = freshCalls();
    const b = new PeekabooGrantProbe({ client: makeFakeClient({ binary: true }, calls) });
    await expect(b.healthCheck()).resolves.toBe(true);
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(1);
  });

  it('healthCheck returns false when the binary is ABSENT (no throw, no hang) — degrade to SKIPPED', async () => {
    const calls = freshCalls();
    const b = new PeekabooGrantProbe({ client: makeFakeClient({ binary: false }, calls) });
    await expect(b.healthCheck()).resolves.toBe(false);
    // Short-circuits before probing permissions (binary is the first gate).
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(0);
  });

  it('healthCheck returns false when EITHER grant is declined — a missing grant must never wedge a sprint', async () => {
    // Each grant alone is insufficient: capture needs Screen Recording, and the
    // gate additionally requires Accessibility because that is what any future
    // drive step would need.
    for (const permissions of [
      { screenRecording: true, accessibility: false },
      { screenRecording: false, accessibility: true },
      { screenRecording: false, accessibility: false },
    ]) {
      const b = new PeekabooGrantProbe({ client: makeFakeClient({ permissions }, freshCalls()) });
      await expect(b.healthCheck()).resolves.toBe(false);
    }
  });

  it('healthCheck soft-fails (false) when a probe THROWS — never propagates', async () => {
    const b = new PeekabooGrantProbe({
      client: makeFakeClient({ binaryError: 'probe exploded' }, freshCalls()),
    });
    await expect(b.healthCheck()).resolves.toBe(false);
  });

  it('healthCheck folds an UNANSWERABLE permissions probe to false, where probeGrants keeps it distinct', async () => {
    // The gate cannot proceed on an unverified grant (that would hang a sprint
    // on a permission dialog) but the panel must not call it a denial.
    const client = makeFakeClient({ permissionsError: 'peekaboo exited 64' }, freshCalls());
    const b = new PeekabooGrantProbe({ client });
    await expect(b.healthCheck()).resolves.toBe(false);
    expect(await b.probeGrants()).toEqual({
      kind: 'inconclusive',
      detail: 'peekaboo exited 64',
    });
  });

  it('probeGrants reports the two grants SEPARATELY, not as one conjunction', async () => {
    const b = new PeekabooGrantProbe({
      client: makeFakeClient(
        { permissions: { screenRecording: true, accessibility: false } },
        freshCalls(),
      ),
    });
    expect(await b.probeGrants()).toEqual({
      kind: 'ok',
      screenRecording: true,
      accessibility: false,
    });
  });

  it('probeGrants distinguishes a MISSING BINARY from a declined grant', async () => {
    const calls = freshCalls();
    const b = new PeekabooGrantProbe({ client: makeFakeClient({ binary: false }, calls) });
    const probe = await b.probeGrants();
    expect(probe.kind).toBe('binary-missing');
    // Nothing to hold a grant, so the grant probe is never even attempted.
    expect(calls.permissionProbes).toBe(0);
  });

  it('probeGrants treats a THROWING binary probe as inconclusive, not as absent', async () => {
    // preflight.ts's fail-open rule: a probe that could not answer is not
    // evidence the binary is gone.
    const b = new PeekabooGrantProbe({
      client: makeFakeClient({ binaryError: 'EPERM' }, freshCalls()),
    });
    expect(await b.probeGrants()).toEqual({ kind: 'inconclusive', detail: 'EPERM' });
  });
});

describe('parsePermissionsJson', () => {
  it('reads the REAL v2.x envelope — { success, data: { permissions } }', () => {
    // Verbatim from `peekaboo permissions --json-output` (v2.0.3), the shape the
    // previous reader could not see: it looked only at `permissions` and the
    // root, found neither, and reported both grants denied on a host holding
    // both. That is the bug this case exists to keep fixed.
    const stdout = JSON.stringify({
      success: true,
      data: { permissions: { accessibility: true, screen_recording: true } },
      debug_logs: [],
    });
    expect(parsePermissionsJson(stdout)).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  });

  it('reads v3\'s LIST of named grants, so the version bump is not a parser rewrite', () => {
    // Verbatim shape from `@steipete/peekaboo` v3: an array of named grants
    // rather than a keyed object, with extra grants we do not require.
    const stdout = JSON.stringify({
      success: true,
      data: {
        source: 'bridge',
        permissions: [
          { name: 'Screen Recording', isGranted: true, isRequired: true },
          { name: 'Accessibility', isGranted: false, isRequired: true },
          { name: 'Event Synthesizing', isGranted: true, isRequired: false },
        ],
      },
    });
    expect(parsePermissionsJson(stdout)).toEqual({
      screenRecording: true,
      accessibility: false,
    });
  });

  it('THROWS on a grant list whose booleans are spelled some other way', () => {
    // The failure this guards: an entry naming a grant we recognise but
    // carrying nothing readable used to be stored verbatim, which satisfied the
    // "is this the grants object?" check and parsed into BOTH grants denied. On
    // a host holding both, that sends the user to re-grant permissions they
    // already have and hard-disables a working capability — a confident denial
    // invented from output we did not understand. An unreadable list must reach
    // the caller as `inconclusive`, which only a throw produces.
    const stdout = JSON.stringify({
      success: true,
      data: {
        permissions: [
          { name: 'Screen Recording', is_granted: true },
          { name: 'Accessibility', is_granted: true },
        ],
      },
    });
    expect(() => parsePermissionsJson(stdout)).toThrow(/no recognisable permissions object/);
  });

  it('drops only the unreadable ENTRIES when the rest of the list is fine', () => {
    const stdout = JSON.stringify({
      success: true,
      data: {
        permissions: [
          { name: 'Screen Recording', isGranted: true },
          { name: 'Accessibility', isGranted: 'yes' },
        ],
      },
    });
    // Accessibility never lands, so it reads as not-granted — the same as an
    // absent key, which the docblock already declares a denial.
    expect(parsePermissionsJson(stdout)).toEqual({ screenRecording: true, accessibility: false });
  });

  it('still reads the un-nested shapes older versions emitted', () => {
    expect(
      parsePermissionsJson(JSON.stringify({ permissions: { screenRecording: true, accessibility: false } })),
    ).toEqual({ screenRecording: true, accessibility: false });
    expect(parsePermissionsJson(JSON.stringify({ screenCapture: true, accessibility: true }))).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  });

  it('reports the grants SEPARATELY rather than conjoining them', () => {
    const stdout = JSON.stringify({
      data: { permissions: { screen_recording: true, accessibility: false } },
    });
    expect(parsePermissionsJson(stdout)).toEqual({ screenRecording: true, accessibility: false });
  });

  it('treats an absent or non-true grant within a recognised object as DENIED', () => {
    // Absence inside a shape we understand is real evidence — unlike a shape we
    // do not understand, which throws.
    expect(parsePermissionsJson(JSON.stringify({ data: { permissions: { accessibility: true } } }))).toEqual({
      screenRecording: false,
      accessibility: true,
    });
    expect(
      parsePermissionsJson(JSON.stringify({ data: { permissions: { accessibility: 'yes', screen_recording: 1 } } })),
    ).toEqual({ screenRecording: false, accessibility: false });
  });

  it('THROWS on output it cannot read, rather than answering "both denied" for the host', () => {
    // Answering on the host's behalf is what sends a user to re-grant a
    // permission they already hold.
    expect(() => parsePermissionsJson('Error: Unknown option')).toThrow(/not JSON/);
    expect(() => parsePermissionsJson('null')).toThrow(/no recognisable permissions/);
    expect(() => parsePermissionsJson(JSON.stringify({ success: true, data: {} }))).toThrow(
      /no recognisable permissions/,
    );
    expect(() => parsePermissionsJson(JSON.stringify([{ accessibility: true }]))).toThrow(
      /no recognisable permissions/,
    );
  });
});
