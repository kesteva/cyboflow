/** hostsStore: init idempotency, gating, subscribe-then-seed, debounced signals, stale drops, preflight watch, mutations. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { DISABLED_HOSTS_STATUS, type HostsChangedEvent, type PreflightProgressEvent } from '../../../../shared/types/hosts';
import { makeCheck, makeHost, makeHostsStatus, makeLocalHost } from '../../components/agentsEnv/__tests__/fixtures';

type Handlers<T> = { onData: (v: T) => void; onError: (e: unknown) => void };

let order: string[];
let statusQuery: ReturnType<typeof vi.fn>;
let listQuery: ReturnType<typeof vi.fn>;
let addMutate: ReturnType<typeof vi.fn>;
let runPreflightMutate: ReturnType<typeof vi.fn>;
let hostsSubscribe: ReturnType<typeof vi.fn>;
let preflightSubscribe: ReturnType<typeof vi.fn>;
let hostsUnsub: ReturnType<typeof vi.fn>;
let preflightUnsub: ReturnType<typeof vi.fn>;
let hostsHandlers: Handlers<HostsChangedEvent> | null;
let preflightHandlers: Handlers<PreflightProgressEvent> | null;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      hosts: {
        status: { get query() { return statusQuery; } },
        list: { get query() { return listQuery; } },
        add: { get mutate() { return addMutate; } },
        runPreflight: { get mutate() { return runPreflightMutate; } },
        onHostsChanged: { get subscribe() { return hostsSubscribe; } },
        onPreflightProgress: { get subscribe() { return preflightSubscribe; } },
      },
    },
  },
}));

import { useHostsStore, useHostLookup, HOSTS_SIGNAL_DEBOUNCE_MS } from '../hostsStore';

const store = useHostsStore;
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  order = [];
  hostsHandlers = null;
  preflightHandlers = null;
  hostsUnsub = vi.fn();
  preflightUnsub = vi.fn();
  statusQuery = vi.fn().mockResolvedValue(makeHostsStatus());
  listQuery = vi.fn().mockImplementation(async () => {
    order.push('list');
    return [makeLocalHost(), makeHost()];
  });
  addMutate = vi.fn().mockResolvedValue({ ok: true, id: 'h9' });
  runPreflightMutate = vi.fn().mockResolvedValue({ ok: true, result: {} });
  hostsSubscribe = vi.fn().mockImplementation((_i: undefined, h: Handlers<HostsChangedEvent>) => {
    order.push('subscribe');
    hostsHandlers = h;
    return { unsubscribe: hostsUnsub };
  });
  preflightSubscribe = vi.fn().mockImplementation((_i: { id: string }, h: Handlers<PreflightProgressEvent>) => {
    preflightHandlers = h;
    return { unsubscribe: preflightUnsub };
  });
  store.setState({ featureStatus: null, hosts: [], hostsStatus: 'idle', hostsError: null, preflightLive: {} });
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

describe('hostsStore', () => {
  it('init is idempotent and returns the same teardown', () => {
    teardown = store.getState().init();
    expect(store.getState().init()).toBe(teardown);
    expect(statusQuery).toHaveBeenCalledTimes(1);
  });

  it('subscribes BEFORE seeding when running', async () => {
    teardown = store.getState().init();
    await advance(0);
    expect(order.slice(0, 2)).toEqual(['subscribe', 'list']);
    expect(store.getState().hosts).toHaveLength(2);
    expect(store.getState().hostsStatus).toBe('ready');
  });

  it('stays inert when the feature is not running', async () => {
    statusQuery.mockResolvedValue(DISABLED_HOSTS_STATUS);
    teardown = store.getState().init();
    await advance(0);
    expect(hostsSubscribe).not.toHaveBeenCalled();
    expect(listQuery).not.toHaveBeenCalled();
  });

  it('a status query failure reads as disabled', async () => {
    statusQuery.mockRejectedValue(new Error('no router'));
    teardown = store.getState().init();
    await advance(0);
    expect(store.getState().featureStatus).toEqual(DISABLED_HOSTS_STATUS);
  });

  it('debounces change signals into one re-query', async () => {
    teardown = store.getState().init();
    await advance(0);
    listQuery.mockClear();
    hostsHandlers?.onData({ kind: 'hosts' });
    hostsHandlers?.onData({ kind: 'hosts', hostId: 'h2' });
    await advance(HOSTS_SIGNAL_DEBOUNCE_MS + 1);
    expect(listQuery).toHaveBeenCalledTimes(1);
  });

  it('a status signal re-reads the feature status', async () => {
    teardown = store.getState().init();
    await advance(0);
    statusQuery.mockClear();
    hostsHandlers?.onData({ kind: 'status' });
    await advance(0);
    expect(statusQuery).toHaveBeenCalledTimes(1);
  });

  it('drops a stale list response', async () => {
    teardown = store.getState().init();
    await advance(0);
    let resolveSlow: (v: unknown[]) => void = () => {};
    listQuery.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    listQuery.mockImplementationOnce(async () => [makeLocalHost()]);
    const slow = store.getState().refreshHosts();
    await store.getState().refreshHosts();
    resolveSlow([makeLocalHost(), makeHost(), makeHost({ id: 'h3' })]);
    await slow;
    expect(store.getState().hosts).toHaveLength(1);
  });

  it('a failed list keeps existing rows and errors an empty list', async () => {
    teardown = store.getState().init();
    await advance(0);
    listQuery.mockRejectedValue(new Error('boom'));
    await store.getState().refreshHosts();
    expect(store.getState().hostsStatus).toBe('ready');
    store.setState({ hosts: [] });
    await store.getState().refreshHosts();
    expect(store.getState().hostsStatus).toBe('error');
    expect(store.getState().hostsError).toContain('boom');
  });

  it('watchPreflight is ref-counted and collects live checks until done', async () => {
    teardown = store.getState().init();
    await advance(0);
    const r1 = store.getState().watchPreflight('h2');
    const r2 = store.getState().watchPreflight('h2');
    expect(preflightSubscribe).toHaveBeenCalledTimes(1);
    preflightHandlers?.onData({ hostId: 'h2', check: makeCheck({ id: 'arch' }), done: false });
    preflightHandlers?.onData({ hostId: 'h2', check: makeCheck({ id: 'git' }), done: false });
    preflightHandlers?.onData({ hostId: 'h2', check: makeCheck({ id: 'arch', status: 'warn' }), done: false });
    expect(store.getState().preflightLive.h2.map((c) => `${c.id}:${c.status}`)).toEqual(['arch:warn', 'git:pass']);
    listQuery.mockClear();
    preflightHandlers?.onData({ hostId: 'h2', check: null, done: true });
    expect(store.getState().preflightLive.h2).toBeUndefined();
    await advance(HOSTS_SIGNAL_DEBOUNCE_MS + 1);
    expect(listQuery).toHaveBeenCalled();
    r1();
    expect(preflightUnsub).not.toHaveBeenCalled();
    r2();
    r2();
    expect(preflightUnsub).toHaveBeenCalledTimes(1);
  });

  it('the last watcher release drops partial live rows, and a (re)opened stream starts clean', async () => {
    teardown = store.getState().init();
    await advance(0);
    store.setState({ preflightLive: { h2: [makeCheck({ id: 'disk-free' })] } });
    const r1 = store.getState().watchPreflight('h2');
    // Opening the progress stream clears rows left from a previous (unwatched) run.
    expect(store.getState().preflightLive.h2).toBeUndefined();
    preflightHandlers?.onData({ hostId: 'h2', check: makeCheck({ id: 'arch' }), done: false });
    expect(store.getState().preflightLive.h2).toHaveLength(1);
    r1();
    // No done frame arrived, but nobody is watching: the partial rows must not survive into a later run.
    expect(store.getState().preflightLive.h2).toBeUndefined();
    const r2 = store.getState().watchPreflight('h2');
    preflightHandlers?.onData({ hostId: 'h2', check: makeCheck({ id: 'git' }), done: false });
    expect(store.getState().preflightLive.h2.map((c) => c.id)).toEqual(['git']);
    r2();
  });

  it('mutations re-list on success and wrap a throw as a local failure', async () => {
    teardown = store.getState().init();
    await advance(0);
    listQuery.mockClear();
    const ok = await store.getState().add({ label: 'Box', sshTarget: 'box' });
    expect(ok).toEqual({ ok: true, id: 'h9' });
    expect(listQuery).toHaveBeenCalled();
    addMutate.mockRejectedValue(new Error('ipc down'));
    const bad = await store.getState().add({ label: 'Box', sshTarget: 'box' });
    expect(bad).toMatchObject({ ok: false, error: 'unknown' });
  });

  it('runPreflight clears stale live rows first', async () => {
    store.setState({ preflightLive: { h2: [makeCheck()] } });
    await store.getState().runPreflight('h2');
    expect(store.getState().preflightLive.h2).toBeUndefined();
    expect(runPreflightMutate).toHaveBeenCalledWith({ id: 'h2' });
  });

  it('teardown closes subscriptions', async () => {
    teardown = store.getState().init();
    await advance(0);
    teardown();
    teardown = null;
    expect(hostsUnsub).toHaveBeenCalled();
  });

  it('useHostLookup resolves ids and tolerates null/unknown', () => {
    store.setState({ hosts: [makeHost()] });
    expect(renderHook(() => useHostLookup('h2')).result.current?.label).toBe('Build box');
    expect(renderHook(() => useHostLookup(null)).result.current).toBeUndefined();
    expect(renderHook(() => useHostLookup('nope')).result.current).toBeUndefined();
  });
});
