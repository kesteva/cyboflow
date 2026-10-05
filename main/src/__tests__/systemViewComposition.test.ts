import { describe, expect, it } from 'vitest';
import { resolveWatchedPorts } from '../systemViewComposition';

describe('resolveWatchedPorts', () => {
  it('watches only the configured ports in a packaged build', () => {
    expect(resolveWatchedPorts([3000, 8080], false, { CYBOFLOW_VITE_PORT: '4600' })).toEqual([
      { port: 3000, label: 'watched' },
      { port: 8080, label: 'watched' },
    ]);
  });

  it("adds cyboflow's own dev ports in a dev build, defaulting to 4521 / 9223", () => {
    expect(resolveWatchedPorts([3000], true, {})).toEqual([
      { port: 3000, label: 'watched' },
      { port: 4521, label: 'cyboflow dev renderer' },
      { port: 9223, label: 'cyboflow CDP' },
    ]);
  });

  it('resolves the dev ports from the env vars a verify instance launches with', () => {
    expect(resolveWatchedPorts([], true, { CYBOFLOW_VITE_PORT: '4600', CYBOFLOW_CDP_PORT: '9300' })).toEqual([
      { port: 4600, label: 'cyboflow dev renderer' },
      { port: 9300, label: 'cyboflow CDP' },
    ]);
  });

  it('relabels a configured port that is also a cyboflow port instead of listing it twice', () => {
    expect(resolveWatchedPorts([9223, 3000], true, {})).toEqual([
      { port: 9223, label: 'cyboflow CDP' },
      { port: 3000, label: 'watched' },
      { port: 4521, label: 'cyboflow dev renderer' },
    ]);
  });

  it('skips a dev port env var that is not a port', () => {
    expect(resolveWatchedPorts([], true, { CYBOFLOW_VITE_PORT: 'abc', CYBOFLOW_CDP_PORT: '9223' })).toEqual([
      { port: 9223, label: 'cyboflow CDP' },
    ]);
  });
});
