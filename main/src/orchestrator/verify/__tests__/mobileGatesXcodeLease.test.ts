/**
 * The §B3 concurrency rule (docs/proposals/runbook-optional-verification.md):
 * with more than one simulator slot, a mobile row that may drive through Xcode
 * also takes the count-1 `verify:xcode` lease, and a miss leaves it QUEUED
 * (never a degraded rung). Driven over a real ResourceLeasePool on a private
 * mutex, so the leases are the ones the scheduler would take.
 */
import { describe, expect, it } from 'vitest';
import { Mutex } from '../../../utils/mutex';
import { acquireModalityLeases, mobileNeedsXcodeLease, VERIFY_XCODE_LEASE } from '../mobileGates';
import { ResourceLeasePool } from '../verificationLeases';
import type { MobileDriveEngine } from '../../../../../shared/types/visualVerification';

function lease(pool: ResourceLeasePool, slots: number, engine?: MobileDriveEngine) {
  return acquireModalityLeases({
    leasePool: pool,
    modality: 'mobile',
    mobileSimSlots: slots,
    ...(engine !== undefined ? { mobileDriveEngine: engine } : {}),
    devServerPorts: [],
    portFromLease: () => null,
    requestId: 'vr-x',
  });
}

describe('mobileNeedsXcodeLease', () => {
  it('only with more than one slot, and only when the engine may choose xcode', () => {
    expect(mobileNeedsXcodeLease(1, 'auto')).toBe(false);
    expect(mobileNeedsXcodeLease(2, 'auto')).toBe(true);
    expect(mobileNeedsXcodeLease(2, undefined)).toBe(true);
    expect(mobileNeedsXcodeLease(3, 'xcode')).toBe(true);
    expect(mobileNeedsXcodeLease(2, 'maestro')).toBe(false);
    expect(mobileNeedsXcodeLease(2, 'none')).toBe(false);
  });
});

describe('acquireModalityLeases — the verify:xcode lease', () => {
  it('with two slots, a second xcode-capable mobile row stays queued until the first releases', async () => {
    const pool = new ResourceLeasePool(new Mutex());
    const first = await lease(pool, 2, 'auto');
    expect(first?.mobileLease).not.toBeNull();
    // A free simulator slot exists, but the xcode lease does not: QUEUED.
    expect(await lease(pool, 2, 'auto')).toBeNull();
    first?.mobileLease?.release();
    const second = await lease(pool, 2, 'auto');
    expect(second?.mobileLease).not.toBeNull();
    second?.mobileLease?.release();
  });

  it('a miss on the xcode lease gives the simulator slot back', async () => {
    const mutex = new Mutex();
    const pool = new ResourceLeasePool(mutex);
    const held = await pool.tryAcquire(VERIFY_XCODE_LEASE);
    expect(await lease(pool, 2, 'xcode')).toBeNull();
    expect(mutex.isLocked('verify:mobile:0')).toBe(false);
    held?.release();
  });

  it('one slot, or a maestro/none engine, never takes it — mobile concurrency is unchanged', async () => {
    const pool = new ResourceLeasePool(new Mutex());
    const a = await lease(pool, 2, 'maestro');
    const b = await lease(pool, 2, 'maestro');
    expect(a?.mobileLease).not.toBeNull();
    expect(b?.mobileLease).not.toBeNull();
    a?.mobileLease?.release();
    b?.mobileLease?.release();
    const only = await lease(pool, 1, 'auto');
    expect(only?.mobileLease).not.toBeNull();
    expect(pool.sharedMutex.isLocked(VERIFY_XCODE_LEASE)).toBe(false);
    only?.mobileLease?.release();
  });
});
