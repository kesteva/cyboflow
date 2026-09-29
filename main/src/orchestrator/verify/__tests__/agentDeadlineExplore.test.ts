/**
 * `resolveAgentDeadlineMs`'s EXPLORE floor
 * (docs/proposals/runbook-optional-verification.md §A1.1): an explore request
 * is floored at `max(modality floor, exploreFloorMs)`, the ceiling still wins,
 * and a request that passes no explore floor (pinned, legacy) is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveAgentDeadlineMs } from '../mobileGates';

const BASE = { defaultMs: 600_000, ceilingMs: 1_200_000, mobileFloorMs: 300_000 };

describe('resolveAgentDeadlineMs — explore floor', () => {
  it('no explore floor: the pre-explore answer, byte for byte', () => {
    expect(resolveAgentDeadlineMs({ ...BASE, task: {}, modality: 'web' })).toBe(600_000);
    expect(resolveAgentDeadlineMs({ ...BASE, task: { timeoutMs: 700_000 }, modality: 'web' })).toBe(700_000);
  });

  it('raises the floor for an explore request, and a composer guess can still only raise it', () => {
    expect(resolveAgentDeadlineMs({ ...BASE, task: {}, modality: 'web', exploreFloorMs: 900_000 })).toBe(900_000);
    expect(resolveAgentDeadlineMs({ ...BASE, task: { timeoutMs: 60_000 }, modality: 'web', exploreFloorMs: 900_000 })).toBe(
      900_000,
    );
    expect(
      resolveAgentDeadlineMs({ ...BASE, task: { timeoutMs: 1_000_000 }, modality: 'web', exploreFloorMs: 900_000 }),
    ).toBe(1_000_000);
  });

  it('takes the LARGER of the mobile and explore floors', () => {
    const mobile = { ...BASE, mobileFloorMs: 1_000_000, task: {}, modality: 'mobile' as const };
    expect(resolveAgentDeadlineMs({ ...mobile, exploreFloorMs: 900_000 })).toBe(1_000_000);
    expect(resolveAgentDeadlineMs({ ...mobile, exploreFloorMs: 1_100_000 })).toBe(1_100_000);
  });

  it('the ceiling wins over the explore floor, with one warn', () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
    expect(
      resolveAgentDeadlineMs({ ...BASE, task: {}, modality: 'web', exploreFloorMs: 1_500_000, logger }),
    ).toBe(1_200_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deadline floor clipped'),
      expect.objectContaining({ floorMs: 1_500_000, ceilingMs: 1_200_000, explore: true }),
    );
  });
});
