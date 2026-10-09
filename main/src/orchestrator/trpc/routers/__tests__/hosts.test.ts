/**
 * cyboflow.hosts router: the "off" answers for an unset / not-running facade, zod input rejection, the
 * by-NAME error conversion (every HOSTS_ERROR_NAMES entry) and the two subscriptions. The facade is a fake;
 * this file never touches services/*.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import {
  _resetHostsFacadeForTesting,
  emitHostsChanged,
  emitPreflightProgress,
  hostEvents,
  hostPreflightChannel,
  HOSTS_CHANNEL,
  setHostsFacade,
  type HostsFacade,
} from '../../../hostsBridge';
import {
  DISABLED_HOSTS_STATUS,
  HOSTS_ERROR_NAMES,
  type HostsChangedEvent,
  type HostsFeatureStatus,
  type HostView,
  type PreflightProgressEvent,
  type PreflightResult,
} from '../../../../../../shared/types/hosts';

const COLD_ROUTER_IMPORT_TIMEOUT_MS = 30_000;

const RUNNING: HostsFeatureStatus = { available: true, enabled: true, killed: false, scheduleKilled: false, running: true };

function unexpected(): never {
  throw new Error('unexpected facade call');
}

class FakeFacade implements HostsFacade {
  statusValue: HostsFeatureStatus = RUNNING;
  calls: Array<{ method: string; args: unknown[] }> = [];
  failWith: Error | null = null;
  private rec<T>(method: string, args: unknown[], value: T): T {
    this.calls.push({ method, args });
    if (this.failWith) throw this.failWith;
    return value;
  }
  status(): HostsFeatureStatus { return this.statusValue; }
  list(opts: { includeArchived: boolean }): HostView[] { return this.rec('list', [opts], []); }
  get(id: string): HostView {
    this.rec('get', [id], undefined);
    return unexpected();
  }
  async addSsh(input: { label: string; sshTarget: string }): Promise<{ id: string }> { return this.rec('addSsh', [input], { id: 'h1' }); }
  async update(id: string, patch: { label?: string; sshTarget?: string }): Promise<void> { this.rec('update', [id, patch], undefined); }
  async setUserCap(id: string, cap: 'cli' | 'full' | null): Promise<void> { this.rec('setUserCap', [id, cap], undefined); }
  async runPreflight(id: string): Promise<PreflightResult> { return this.rec('runPreflight', [id], { hostId: id } as PreflightResult); }
  async archive(id: string): Promise<void> { this.rec('archive', [id], undefined); }
  async setProjectDefault(projectId: number, hostId: string | null): Promise<void> { this.rec('setProjectDefault', [projectId, hostId], undefined); }
  async terminalOpen(hostId: string): Promise<{ terminalId: string }> { return this.rec('terminalOpen', [hostId], { terminalId: 't1' }); }
  terminalInput(terminalId: string, text: string): void { this.rec('terminalInput', [terminalId, text], undefined); }
  terminalResize(terminalId: string, cols: number, rows: number): void { this.rec('terminalResize', [terminalId, cols, rows], undefined); }
  terminalBacklog(terminalId: string): { backlog: string; exited: boolean; exitCode: number | null } {
    return this.rec('terminalBacklog', [terminalId], { backlog: 'hi', exited: false, exitCode: null });
  }
  terminalClose(terminalId: string): void { this.rec('terminalClose', [terminalId], undefined); }
}

function caller(signal?: AbortSignal) {
  return appRouter.createCaller(createContext(), signal ? { signal } : undefined).cyboflow.hosts;
}

function named(name: string, message = 'boom'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    return (err as TRPCError).code;
  }
  return 'NO_ERROR';
}

let fake: FakeFacade;

beforeEach(() => {
  fake = new FakeFacade();
  setHostsFacade(fake);
});

afterEach(() => {
  _resetHostsFacadeForTesting();
});

describe('unset / not running', () => {
  it('status never throws and reads all-false when unset', async () => {
    _resetHostsFacadeForTesting();
    expect(await caller().status()).toEqual(DISABLED_HOSTS_STATUS);
  }, COLD_ROUTER_IMPORT_TIMEOUT_MS);

  it('list is [] when unset', async () => {
    _resetHostsFacadeForTesting();
    expect(await caller().list()).toEqual([]);
  });

  it('mutations answer feature_disabled when unset', async () => {
    _resetHostsFacadeForTesting();
    expect(await caller().add({ label: 'a', sshTarget: 'host' })).toMatchObject({ ok: false, error: 'feature_disabled' });
    expect(await caller().terminalInput({ terminalId: 't', text: 'x' })).toMatchObject({ ok: false, error: 'feature_disabled' });
  });

  it('mutations answer feature_disabled when the facade is not running, without calling it', async () => {
    fake.statusValue = { ...RUNNING, enabled: false, running: false };
    expect(await caller().archive({ id: 'h1' })).toMatchObject({ ok: false, error: 'feature_disabled' });
    expect(await caller().terminalBacklog({ terminalId: 't' })).toMatchObject({ ok: false, error: 'feature_disabled' });
    expect(fake.calls).toEqual([]);
  });

  it('get is PRECONDITION_FAILED when unset', async () => {
    _resetHostsFacadeForTesting();
    expect(await codeOf(caller().get({ id: 'h1' }))).toBe('PRECONDITION_FAILED');
  });
});

describe('happy paths', () => {
  it('list passes includeArchived (default false)', async () => {
    await caller().list();
    await caller().list({ includeArchived: true });
    expect(fake.calls.map((c) => c.args[0])).toEqual([{ includeArchived: false }, { includeArchived: true }]);
  });

  it('add / update / setUserCap / runPreflight / setProjectDefault / terminals delegate', async () => {
    expect(await caller().add({ label: ' Studio ', sshTarget: 'me@studio.local' })).toEqual({ ok: true, id: 'h1' });
    expect(fake.calls[0]).toEqual({ method: 'addSsh', args: [{ label: 'Studio', sshTarget: 'me@studio.local' }] });
    expect(await caller().update({ id: 'h1', label: 'New' })).toEqual({ ok: true });
    expect(fake.calls[1]).toEqual({ method: 'update', args: ['h1', { label: 'New' }] });
    expect(await caller().setUserCap({ id: 'h1', cap: 'cli' })).toEqual({ ok: true });
    expect(await caller().setUserCap({ id: 'h1', cap: null })).toEqual({ ok: true });
    expect(await caller().runPreflight({ id: 'h1' })).toEqual({ ok: true, result: { hostId: 'h1' } });
    expect(await caller().setProjectDefault({ projectId: 3, hostId: null })).toEqual({ ok: true });
    expect(await caller().terminalOpen({ hostId: 'h1' })).toEqual({ ok: true, terminalId: 't1' });
    expect(await caller().terminalInput({ terminalId: 't1', text: 'ls\r' })).toEqual({ ok: true });
    expect(await caller().terminalResize({ terminalId: 't1', cols: 100, rows: 30 })).toEqual({ ok: true });
    expect(await caller().terminalBacklog({ terminalId: 't1' })).toEqual({ ok: true, backlog: 'hi', exited: false, exitCode: null });
    expect(await caller().terminalClose({ terminalId: 't1' })).toEqual({ ok: true });
  });
});

describe('input validation', () => {
  it('rejects unknown keys (.strict)', async () => {
    expect(await codeOf(caller().add({ label: 'a', sshTarget: 'h', extra: 1 } as never))).toBe('BAD_REQUEST');
  });

  it('rejects bad labels', async () => {
    expect(await codeOf(caller().add({ label: '', sshTarget: 'h' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller().add({ label: 'x'.repeat(49), sshTarget: 'h' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller().add({ label: 'a\u0007b', sshTarget: 'h' }))).toBe('BAD_REQUEST');
  });

  it('rejects ssh targets that fail SSH_TARGET_RE', async () => {
    for (const sshTarget of ['-oProxyCommand=x', 'a b', 'a;b', '']) {
      expect(await codeOf(caller().add({ label: 'a', sshTarget }))).toBe('BAD_REQUEST');
      expect(await codeOf(caller().update({ id: 'h', sshTarget }))).toBe('BAD_REQUEST');
    }
  });

  it("restricts cap to 'cli' | null", async () => {
    expect(await codeOf(caller().setUserCap({ id: 'h', cap: 'full' } as never))).toBe('BAD_REQUEST');
    expect(await codeOf(caller().setUserCap({ id: 'h' } as never))).toBe('BAD_REQUEST');
  });

  it('requires positive integer cols/rows', async () => {
    for (const [cols, rows] of [[0, 10], [10, 0], [1.5, 10], [-1, 10]]) {
      expect(await codeOf(caller().terminalResize({ terminalId: 't', cols, rows }))).toBe('BAD_REQUEST');
    }
  });

  it('caps terminal text at 64 KB', async () => {
    expect(await codeOf(caller().terminalInput({ terminalId: 't', text: 'x'.repeat(64 * 1024 + 1) }))).toBe('BAD_REQUEST');
    expect(await caller().terminalInput({ terminalId: 't', text: 'x'.repeat(64 * 1024) })).toEqual({ ok: true });
  });
});

describe('error conversion by name', () => {
  const EXPECTED: Record<keyof typeof HOSTS_ERROR_NAMES, string> = {
    notFound: 'not_found',
    labelTaken: 'label_taken',
    invalidTarget: 'invalid_target',
    capAboveDetected: 'cap_above_detected',
    localImmutable: 'local_immutable',
    hasActiveWork: 'has_active_work',
    killed: 'remote_hosts_disabled',
    terminalUnavailable: 'terminal_unavailable',
    invalidLabel: 'invalid_label',
    disabled: 'feature_disabled',
  };

  for (const key of Object.keys(HOSTS_ERROR_NAMES) as Array<keyof typeof HOSTS_ERROR_NAMES>) {
    it(`${HOSTS_ERROR_NAMES[key]} -> ${EXPECTED[key]}`, async () => {
      fake.failWith = named(HOSTS_ERROR_NAMES[key], 'fixed message');
      expect(await caller().archive({ id: 'h1' })).toEqual({ ok: false, error: EXPECTED[key], message: 'fixed message' });
    });
  }

  it('maps errors from sync terminal procedures too', async () => {
    fake.failWith = named(HOSTS_ERROR_NAMES.killed);
    expect(await caller().terminalInput({ terminalId: 't', text: 'x' })).toMatchObject({ ok: false, error: 'remote_hosts_disabled' });
  });

  it('rethrows an unknown error as INTERNAL_SERVER_ERROR', async () => {
    fake.failWith = new Error('kaboom');
    expect(await codeOf(caller().archive({ id: 'h1' }))).toBe('INTERNAL_SERVER_ERROR');
  });

  it('get maps not-found to NOT_FOUND and disabled to PRECONDITION_FAILED', async () => {
    fake.failWith = named(HOSTS_ERROR_NAMES.notFound);
    expect(await codeOf(caller().get({ id: 'h1' }))).toBe('NOT_FOUND');
    fake.failWith = named(HOSTS_ERROR_NAMES.disabled);
    expect(await codeOf(caller().get({ id: 'h1' }))).toBe('PRECONDITION_FAILED');
    fake.failWith = new Error('kaboom');
    expect(await codeOf(caller().get({ id: 'h1' }))).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('subscriptions', () => {
  it('onHostsChanged yields emitted events and detaches on abort', async () => {
    const ac = new AbortController();
    const sub = await caller(ac.signal).onHostsChanged();
    const received: HostsChangedEvent[] = [];
    const done = (async () => {
      for await (const ev of sub as AsyncIterable<HostsChangedEvent>) {
        received.push(ev);
        if (received.length === 2) ac.abort();
      }
    })();
    setImmediate(() => {
      emitHostsChanged({ kind: 'hosts', hostId: 'h1' });
      emitHostsChanged({ kind: 'status' });
    });
    await done;
    expect(received).toEqual([{ kind: 'hosts', hostId: 'h1' }, { kind: 'status' }]);
    expect(hostEvents.listenerCount(HOSTS_CHANNEL)).toBe(0);
  });

  it('onPreflightProgress yields only its host and detaches on abort', async () => {
    const ac = new AbortController();
    const sub = await caller(ac.signal).onPreflightProgress({ id: 'h1' });
    const received: PreflightProgressEvent[] = [];
    const done = (async () => {
      for await (const ev of sub as AsyncIterable<PreflightProgressEvent>) {
        received.push(ev);
        if (ev.done) ac.abort();
      }
    })();
    setImmediate(() => {
      emitPreflightProgress({ hostId: 'h2', check: null, done: false });
      emitPreflightProgress({ hostId: 'h1', check: null, done: true });
    });
    await done;
    expect(received).toEqual([{ hostId: 'h1', check: null, done: true }]);
    expect(hostEvents.listenerCount(hostPreflightChannel('h1'))).toBe(0);
  });
});
