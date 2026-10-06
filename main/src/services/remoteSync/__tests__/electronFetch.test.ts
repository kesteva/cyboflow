import { describe, it, expect, vi } from 'vitest';
import { createElectronFetch } from '../electronFetch';
import type { FetchLike } from '../syncHttpClient';

const ok = () => new Response('{}');

describe('createElectronFetch', () => {
  it('passes through to net.fetch', async () => {
    const netFetch = vi.fn(async () => ok());
    const f = createElectronFetch({ getNet: () => ({ fetch: netFetch as unknown as FetchLike }) });
    await f('https://x/y', { method: 'GET' });
    expect(netFetch).toHaveBeenCalledWith('https://x/y', { method: 'GET' });
  });

  it('retries once on a net error with the fresh fetch and reuses it afterwards', async () => {
    const netFetch = vi.fn(async () => {
      throw new Error('net::ERR_FAILED');
    });
    const fresh = vi.fn(async () => ok());
    const create = vi.fn(() => fresh as unknown as FetchLike);
    const warn = vi.fn();
    const f = createElectronFetch({
      getNet: () => ({ fetch: netFetch as unknown as FetchLike }),
      createFreshSessionFetch: create,
      logger: { warn },
    });
    await f('https://x/1');
    await f('https://x/2');
    expect(netFetch).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors without recovering', async () => {
    const netFetch = vi.fn(async () => {
      throw new Error('boom');
    });
    const create = vi.fn();
    const f = createElectronFetch({
      getNet: () => ({ fetch: netFetch as unknown as FetchLike }),
      createFreshSessionFetch: create as unknown as () => FetchLike,
    });
    await expect(f('https://x')).rejects.toThrow('boom');
    expect(create).not.toHaveBeenCalled();
  });

  it('rethrows a net error when no fresh-session factory is given', async () => {
    const netFetch = vi.fn(async () => {
      throw new Error('net::ERR_FAILED');
    });
    const f = createElectronFetch({ getNet: () => ({ fetch: netFetch as unknown as FetchLike }) });
    await expect(f('https://x')).rejects.toThrow('net::ERR_FAILED');
  });
});
