/**
 * Unit tests for the `mobile` modality's gate arm and simulator-slot pool
 * (docs/proposals/mobile-verification-tier.md §8 / §10, T3).
 *
 * Two properties are worth a unit test of their own rather than only being
 * exercised through the scheduler: the slot clamp (a bad config value used to be
 * able to make the candidate list EMPTY, which `tryAcquireOneOf` answers `null`
 * to forever — a silent whole-feature outage), and the gate's four-way truth
 * table, whose THROW arm has to fail CLOSED and is the one arm the scheduler
 * suites cannot make obvious.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL,
  MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
  mobileSlotCount,
  mobileSlotNames,
  mobileToolchainDetail,
  verifyMobileSlot,
} from '../mobileGates';

describe('mobile simulator slot pool', () => {
  it('names slots verify:mobile:<i> from 0', () => {
    expect(verifyMobileSlot(0)).toBe('verify:mobile:0');
    expect(mobileSlotNames(3)).toEqual(['verify:mobile:0', 'verify:mobile:1', 'verify:mobile:2']);
  });

  it('clamps the configured count into [1,4] — an EMPTY candidate list is the outage', () => {
    expect(mobileSlotCount(0)).toBe(1);
    expect(mobileSlotCount(-7)).toBe(1);
    expect(mobileSlotCount(9)).toBe(4);
    expect(mobileSlotCount(2.9)).toBe(2);
    expect(mobileSlotCount(Number.NaN)).toBe(1);
    expect(mobileSlotNames(0)).toEqual(['verify:mobile:0']);
    expect(mobileSlotNames(9)).toHaveLength(4);
  });
});

describe('mobileToolchainDetail — gate 1 mobile arm', () => {
  it('answers the unprobed table detail when NO probe is wired', async () => {
    await expect(mobileToolchainDetail(undefined)).resolves.toBe(MOBILE_TOOLCHAIN_UNPROBED_DETAIL);
  });

  it('answers null (proceed) for a capable host', async () => {
    await expect(mobileToolchainDetail(async () => true)).resolves.toBeNull();
  });

  it('answers the actionable three-fact detail for an incapable host', async () => {
    const detail = await mobileToolchainDetail(async () => false);
    expect(detail).toBe(MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL);
    // The three separable facts, each with its own remedy.
    expect(detail).toContain('command-line tools');
    expect(detail).toContain('iOS runtime');
    expect(detail).toContain('device type');
  });

  it('FAILS CLOSED on a throwing probe, and warns', async () => {
    const warn = vi.fn();
    const detail = await mobileToolchainDetail(
      async () => {
        throw new Error('xcrun exploded');
      },
      { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    );
    // A broken probe must never open onto a 2 GB simulator create + boot.
    expect(detail).toBe(MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('mobile toolchain probe threw'),
      expect.objectContaining({ error: 'xcrun exploded' }),
    );
  });
});
