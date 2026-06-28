/**
 * PeekabooBackend (Rung 2) unit tests.
 *
 * NO real binary runs + NO real capture: a FAKE PeekabooClient is dependency-
 * injected (binaryAvailable / permissionsGranted / capture are all knobbed). The
 * fake drives the real backend orchestration — the ALWAYS verify:screen lease, the
 * two-gate healthCheck (binary absent OR a TCC grant declined ⇒ false, no throw,
 * no hang), a successful capture writing a PNG into a temp artifactsDir, and a
 * client error falling forward to ok:false (never a throw).
 *
 * Live peekaboo capture (real binary + 2 TCC grants on the host) is environmental
 * ⇒ smoke-only, NOT a unit-gate AC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeekabooBackend, type PeekabooClient } from '../peekabooBackend';
import { VERIFY_SCREEN_LEASE } from '../../../orchestrator/verify/verificationScheduler';
import type { CaptureContext } from '../../../../../shared/types/visualVerification';

/** Per-test behaviour knobs for the fake PeekabooClient. */
interface FakeOpts {
  /** Whether the `peekaboo` binary is on PATH. Default true. */
  binary?: boolean;
  /** Whether BOTH required TCC grants are held. Default true. */
  permissions?: boolean;
  /** When set, capture() rejects with this message (a CLI failure). */
  captureError?: string;
  /** Whether a successful capture writes a real PNG byte to outPath. Default true. */
  writePng?: boolean;
}

/** A recorded capture call against the fake client. */
interface FakeCalls {
  captures: Array<{ appTarget: string; outPath: string }>;
  binaryProbes: number;
  permissionProbes: number;
}

// The smallest valid PNG (the fake capture writes it to prove a real byte landed).
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function makeFakeClient(opts: FakeOpts, calls: FakeCalls): PeekabooClient {
  return {
    async binaryAvailable(): Promise<boolean> {
      calls.binaryProbes += 1;
      return opts.binary ?? true;
    },
    async permissionsGranted(): Promise<boolean> {
      calls.permissionProbes += 1;
      return opts.permissions ?? true;
    },
    async capture(args, _signal): Promise<void> {
      calls.captures.push({ appTarget: args.appTarget, outPath: args.outPath });
      if (opts.captureError) {
        throw new Error(opts.captureError);
      }
      if (opts.writePng ?? true) {
        await writeFile(args.outPath, ONE_PX_PNG);
      }
    },
  };
}

let artifactsDir: string;

beforeEach(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-pkb-'));
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

function freshCalls(): FakeCalls {
  return { captures: [], binaryProbes: 0, permissionProbes: 0 };
}

function ctx(): CaptureContext {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    artifactsDir,
    type: 'native-desktop',
    input: { intent: 'the app renders correctly' },
  };
}

describe('PeekabooBackend', () => {
  it('has the rung-2 native-desktop contract', () => {
    const b = new PeekabooBackend({ client: makeFakeClient({}, freshCalls()) });
    expect(b.id).toBe('peekaboo');
    expect(b.rung).toBe(2);
  });

  it('requiredLease ALWAYS returns the verify:screen lease (one display/focus/input)', () => {
    const b = new PeekabooBackend({ client: makeFakeClient({}, freshCalls()) });
    // Request-independent — every native-desktop capture contends for the one screen.
    expect(b.requiredLease({ intent: 'x' })).toBe(VERIFY_SCREEN_LEASE);
    expect(b.requiredLease({ intent: 'y', url: 'http://x', start: 'npm run dev' })).toBe(
      VERIFY_SCREEN_LEASE,
    );
    // It reuses the scheduler's exported constant, not a hardcoded string drift.
    expect(VERIFY_SCREEN_LEASE).toBe('verify:screen');
  });

  it('healthCheck returns true when the binary is present AND both TCC grants are held', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({ binary: true, permissions: true }, calls),
    });
    await expect(b.healthCheck()).resolves.toBe(true);
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(1);
  });

  it('healthCheck returns false when the binary is ABSENT (no throw, no hang) — degrade to SKIPPED', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({ binary: false, permissions: true }, calls),
    });
    await expect(b.healthCheck()).resolves.toBe(false);
    // Short-circuits before probing permissions (binary is the first gate).
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(0);
  });

  it('healthCheck returns false when a TCC grant is DECLINED (no throw) — a missing grant must never wedge a sprint', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({ binary: true, permissions: false }, calls),
    });
    await expect(b.healthCheck()).resolves.toBe(false);
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(1);
  });

  it('healthCheck soft-fails (false) when a probe THROWS — never propagates', async () => {
    const throwingClient: PeekabooClient = {
      async binaryAvailable(): Promise<boolean> {
        throw new Error('probe exploded');
      },
      async permissionsGranted(): Promise<boolean> {
        return true;
      },
      async capture(): Promise<void> {},
    };
    const b = new PeekabooBackend({ client: throwingClient });
    await expect(b.healthCheck()).resolves.toBe(false);
  });

  it('capture writes a PNG into artifactsDir and returns ok:true on success', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({}, calls),
      appTarget: 'Cyboflow',
    });
    const result = await b.capture(ctx(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.fileNames).toEqual(['Cyboflow.png']);
    expect(result.fileNames.every((f) => !f.includes('/'))).toBe(true);
    // The capture targeted the configured app + the real PNG landed in artifactsDir.
    expect(calls.captures).toHaveLength(1);
    expect(calls.captures[0].appTarget).toBe('Cyboflow');
    const written = await readdir(artifactsDir);
    expect(written).toContain('Cyboflow.png');
  });

  it('capture returns ok:false (fall-forward) when the client errors — NEVER throws', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({ captureError: 'peekaboo exited 1: no window' }, calls),
    });
    const result = await b.capture(ctx(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.fileNames).toEqual([]);
    expect(result.error).toContain('peekaboo exited 1');
    // No PNG was written on the failure path.
    const written = await readdir(artifactsDir);
    expect(written).toEqual([]);
  });

  it('capture returns ok:false when already aborted (no client call)', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({ client: makeFakeClient({}, calls) });
    const controller = new AbortController();
    controller.abort();
    const result = await b.capture(ctx(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('capture aborted');
    expect(calls.captures).toHaveLength(0);
  });
});
