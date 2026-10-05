import { describe, expect, it } from 'vitest';
import { resolveWatchedPorts } from '../systemViewComposition';

const watched = (port: number) => ({ port, label: 'watched' });

describe('resolveWatchedPorts', () => {
  it('defaults to 3000, 5000, 8080 in a packaged build', () => {
    expect(resolveWatchedPorts(undefined, false, { CYBOFLOW_VITE_PORT: '4600' })).toEqual([
      watched(3000),
      watched(5000),
      watched(8080),
    ]);
  });

  it("adds cyboflow's own dev ports to the defaults in a dev build, defaulting to 4521 / 9223", () => {
    expect(resolveWatchedPorts(undefined, true, {})).toEqual([
      watched(3000),
      watched(5000),
      watched(8080),
      { port: 4521, label: 'cyboflow dev renderer' },
      { port: 9223, label: 'cyboflow CDP' },
    ]);
  });

  it('resolves the dev ports from the env vars a verify instance launches with', () => {
    expect(resolveWatchedPorts(undefined, true, { CYBOFLOW_VITE_PORT: '4600', CYBOFLOW_CDP_PORT: '9300' }).slice(3)).toEqual([
      { port: 4600, label: 'cyboflow dev renderer' },
      { port: 9300, label: 'cyboflow CDP' },
    ]);
  });

  it('uses a saved list as-is, so the dev ports can be removed', () => {
    expect(resolveWatchedPorts([3000], true, {})).toEqual([watched(3000)]);
    expect(resolveWatchedPorts([], true, {})).toEqual([]);
  });

  it('labels a saved cyboflow port in a dev build only', () => {
    expect(resolveWatchedPorts([9223, 3000], true, {})).toEqual([{ port: 9223, label: 'cyboflow CDP' }, watched(3000)]);
    expect(resolveWatchedPorts([9223], false, {})).toEqual([watched(9223)]);
  });

  it('skips a dev port env var that is not a port', () => {
    expect(resolveWatchedPorts(undefined, true, { CYBOFLOW_VITE_PORT: 'abc' }).slice(3)).toEqual([
      { port: 9223, label: 'cyboflow CDP' },
    ]);
  });
});
