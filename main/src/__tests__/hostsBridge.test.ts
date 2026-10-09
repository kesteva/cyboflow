import { describe, it, expect, afterEach } from 'vitest';
import {
  HOSTS_CHANNEL, HostsNotInitializedError, _resetHostsFacadeForTesting, emitHostsChanged,
  emitPreflightProgress, getHostsFacade, hostEvents, hostPreflightChannel, peekHostsFacade, setHostsFacade,
  type HostsFacade,
} from '../orchestrator/hostsBridge';

afterEach(() => {
  _resetHostsFacadeForTesting();
  hostEvents.removeAllListeners();
});

describe('hostsBridge', () => {
  it('facade is unset until injected', () => {
    expect(peekHostsFacade()).toBeNull();
    expect(() => getHostsFacade()).toThrow(HostsNotInitializedError);
    const f = {} as HostsFacade;
    setHostsFacade(f);
    expect(getHostsFacade()).toBe(f);
    _resetHostsFacadeForTesting();
    expect(peekHostsFacade()).toBeNull();
  });
  it('emits on the hosts and per-host preflight channels', () => {
    const changed: unknown[] = [];
    const progress: unknown[] = [];
    hostEvents.on(HOSTS_CHANNEL, (e) => changed.push(e));
    hostEvents.on(hostPreflightChannel('h1'), (e) => progress.push(e));
    emitHostsChanged({ kind: 'hosts', hostId: 'h1' });
    emitPreflightProgress({ hostId: 'h1', check: null, done: true });
    emitPreflightProgress({ hostId: 'h2', check: null, done: true });
    expect(changed).toEqual([{ kind: 'hosts', hostId: 'h1' }]);
    expect(progress).toEqual([{ hostId: 'h1', check: null, done: true }]);
  });
});
