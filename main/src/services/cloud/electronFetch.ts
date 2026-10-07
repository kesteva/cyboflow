/**
 * fetch for the cyboflow cloud client and relay client, backed by Electron's `net` module (honours system
 * proxy/certs) with one recovery path: if the network service has died or the
 * session is wedged, retry ONCE on a fresh-session fetch and keep using it.
 * `net` is passed in so this file never imports `electron` and stays testable.
 */

import type { FetchLike } from './fetchLike';

const RECOVERABLE = /net::ERR_|network service|crashed/i;

export function createElectronFetch(deps: {
  getNet: () => { fetch: FetchLike };
  createFreshSessionFetch?: () => FetchLike;
  logger?: { warn(msg: string, meta?: unknown): void };
}): FetchLike {
  let recovered: FetchLike | null = null;
  const fn = async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]): Promise<Response> => {
    if (recovered) return recovered(input, init);
    try {
      return await deps.getNet().fetch(input, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!deps.createFreshSessionFetch || !RECOVERABLE.test(message)) throw err;
      deps.logger?.warn('cyboflow cloud: net fetch failed, retrying on a fresh session', { message });
      recovered = deps.createFreshSessionFetch();
      return recovered(input, init);
    }
  };
  return fn as FetchLike;
}
