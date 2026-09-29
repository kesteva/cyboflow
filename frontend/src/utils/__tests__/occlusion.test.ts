import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireOcclusion,
  getOcclusionCount,
  isOccluded,
  resetOcclusionForTests,
  subscribeOcclusion,
} from '../occlusion';

afterEach(() => resetOcclusionForTests());

describe('occlusion counter', () => {
  it('is occluded exactly while at least one lease is held', () => {
    expect(isOccluded()).toBe(false);
    const a = acquireOcclusion('a');
    const b = acquireOcclusion('b');
    expect(getOcclusionCount()).toBe(2);
    a();
    // Nested overlays close independently: the outer one still covers the view.
    expect(isOccluded()).toBe(true);
    b();
    expect(isOccluded()).toBe(false);
  });

  it('makes a release idempotent, so a double cleanup cannot un-hide the view under an open overlay', () => {
    const a = acquireOcclusion('a');
    const b = acquireOcclusion('b');
    a();
    a();
    expect(getOcclusionCount()).toBe(1);
    expect(isOccluded()).toBe(true);
    b();
  });

  it('notifies on the occluded/unoccluded transitions only', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOcclusion(listener);
    const a = acquireOcclusion();
    const b = acquireOcclusion();
    b();
    expect(listener).toHaveBeenCalledTimes(1);
    a();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    acquireOcclusion()();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
