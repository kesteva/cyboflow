/**
 * createContext principal resolution — the regression behind the "Aria mode
 * takes effect without a relaunch" claim.
 *
 * The wiring passes a RESOLVER (currentOmpPrincipal), because the supervise
 * capability comes from Aria mode, a runtime setting. createContext must call
 * that resolver ONCE PER REQUEST: a value frozen at window-attach left
 * availability.launchable and the ompCommand gate stale until relaunch — the
 * exact defect class this suite pins shut.
 */
import { describe, expect, it } from 'vitest';
import type { OmpPrincipal } from '../../../../../shared/types/ompCommand';
import { OMP_SUPERVISE_CAPABILITY } from '../../../../../shared/types/ompCommand';
import { createContext } from '../context';

const privileged: OmpPrincipal = {
  userId: 'local',
  capabilities: new Set([OMP_SUPERVISE_CAPABILITY]),
};
const unprivileged: OmpPrincipal = { userId: 'local', capabilities: new Set<string>() };

describe('createContext principal', () => {
  it('passes a plain value through untouched (test convenience shape)', () => {
    const ctx = createContext({ principal: unprivileged });
    expect(ctx.principal).toBe(unprivileged);
  });

  it('resolves a thunk at creation time and reflects later mutations on the NEXT call', () => {
    let supervise = false;
    const resolve = (): OmpPrincipal =>
      supervise ? privileged : unprivileged;

    // Request 1: capability withheld.
    expect(
      createContext({ principal: resolve }).principal?.capabilities.has(OMP_SUPERVISE_CAPABILITY),
    ).toBe(false);

    // The setting flips between requests — no rebuild, no relaunch.
    supervise = true;

    // Request 2: same resolver, live answer.
    expect(
      createContext({ principal: resolve }).principal?.capabilities.has(OMP_SUPERVISE_CAPABILITY),
    ).toBe(true);

    // And back: revoking forbids the very next request.
    supervise = false;
    expect(createContext({ principal: resolve }).principal).toEqual(unprivileged);
  });

  it('omits principal entirely when the deps omit it (fail-closed default)', () => {
    const ctx = createContext({});
    expect(ctx.principal).toBeUndefined();
  });
});
