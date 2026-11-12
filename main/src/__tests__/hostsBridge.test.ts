import { describe, it, expect, afterEach } from 'vitest';
import {
  HOSTS_CHANNEL, HostsNotInitializedError, _resetHostsFacadeForTesting, emitHostsChanged,
  emitHostTerminalExit, emitPreflightProgress, emitToolchainProgress, getHostsFacade, hostEvents, hostPreflightChannel,
  hostTerminalChannel, hostToolchainChannel, peekHostsFacade, remoteRuntimeKnownUnavailable, setHostsFacade,
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
  it('reports a runtime unavailable only on a definite "no" from the last check', () => {
    expect(remoteRuntimeKnownUnavailable('h1', 'claude-sdk')).toBe(false); // no facade
    const views: Record<string, unknown> = {
      h1: { preflight: { runtimes: { claudeSdk: false, codexSdk: true } } },
      h2: { preflight: null },
    };
    setHostsFacade({
      get: (id: string) => {
        if (!(id in views)) throw new Error('not found');
        return views[id];
      },
    } as unknown as HostsFacade);
    expect(remoteRuntimeKnownUnavailable('h1', 'claude-sdk')).toBe(true);
    expect(remoteRuntimeKnownUnavailable('h1', 'codex-sdk')).toBe(false);
    expect(remoteRuntimeKnownUnavailable('h1', 'omp-sdk')).toBe(false);
    expect(remoteRuntimeKnownUnavailable('h2', 'claude-sdk')).toBe(false); // never checked
    expect(remoteRuntimeKnownUnavailable('gone', 'claude-sdk')).toBe(false); // unknown host
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
  it('emits toolchain progress on that host\'s own channel only', () => {
    const seen: unknown[] = [];
    hostEvents.on(hostToolchainChannel('h1'), (e) => seen.push(e));
    emitToolchainProgress({ hostId: 'h1', phase: 'hashing', bytesSent: 0, bytesTotal: 0, message: null });
    emitToolchainProgress({ hostId: 'h2', phase: 'done', bytesSent: 1, bytesTotal: 1, message: null });
    expect(seen).toEqual([{ hostId: 'h1', phase: 'hashing', bytesSent: 0, bytesTotal: 0, message: null }]);
  });
  it('emits a terminal exit on that terminal\'s own channel only', () => {
    const exits: unknown[] = [];
    hostEvents.on(hostTerminalChannel('host::h1::t1'), (e) => exits.push(e));
    emitHostTerminalExit({ terminalId: 'host::h1::t1', exitCode: 255 });
    emitHostTerminalExit({ terminalId: 'host::h1::t2', exitCode: 0 });
    expect(exits).toEqual([{ terminalId: 'host::h1::t1', exitCode: 255 }]);
  });
});
