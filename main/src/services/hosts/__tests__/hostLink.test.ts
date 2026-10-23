import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  HOST_LINK_BACKOFF_MS,
  HostLink,
  HostLinkDownError,
  HostLinkNotReadyError,
  HostLinkPool,
  RemoteSocketPathTooLongError,
  remoteOrchSocketPath,
  type HostLinkEvent,
  type HostLinkTimers,
} from '../hostLink';
import { ForwardFailedError, type ForwardHandle, type ForwardSpec } from '../sshTransport';

/** A forward the test drives by hand: up(), fail(), drop(). Honours the ForwardHandle contract. */
class FakeForward implements ForwardHandle {
  readonly emitter = new EventEmitter();
  exited = false;
  closed = false;
  readonly ready: Promise<void>;
  private settle!: (err?: Error) => void;
  constructor(readonly spec: ForwardSpec) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = (err) => (err ? reject(err) : resolve());
    });
    this.ready.catch(() => undefined);
  }
  up(): void {
    this.settle();
  }
  fail(why = 'refused'): void {
    this.settle(new ForwardFailedError(why));
    this.drop(255, why);
  }
  drop(code: number | null = 255, tail = 'Connection reset'): void {
    if (this.exited) return;
    this.exited = true;
    this.settle(new ForwardFailedError('exited'));
    this.emitter.emit('exit', code, tail);
  }
  close(): void {
    this.closed = true;
    this.drop(null, '');
  }
  on(event: 'exit', listener: (code: number | null, stderrTail: string) => void): void {
    this.emitter.on(event, listener);
  }
}

function manualTimers(): HostLinkTimers & { delays(): number[]; fireNext(): void; pending(): number } {
  const queue: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  return {
    setTimer: (fn, ms) => {
      const e = { fn, ms, live: true };
      queue.push(e);
      return () => { e.live = false; };
    },
    delays: () => queue.filter((e) => e.live).map((e) => e.ms),
    fireNext: () => {
      const e = queue.find((x) => x.live);
      if (!e) throw new Error('no pending timer');
      e.live = false;
      e.fn();
    },
    pending: () => queue.filter((e) => e.live).length,
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function make(over: { root?: string | null } = {}) {
  const forwards: FakeForward[] = [];
  const timers = manualTimers();
  const events: HostLinkEvent[] = [];
  const link = new HostLink({
    hostId: 'h1',
    sshTarget: 'box',
    transport: {
      openForward: (_t, spec) => {
        const f = new FakeForward(spec);
        forwards.push(f);
        return f;
      },
    },
    remoteRoot: () => (over.root === undefined ? '/Users/me/cf-remote/h1' : over.root),
    localSock: () => '/Users/me/.cyboflow/sockets/orch.sock',
    timers,
  });
  link.onEvent((e) => events.push(e));
  return { link, forwards, timers, events };
}

describe('remoteOrchSocketPath', () => {
  it('is <root>/s/o.sock and must stay under 100 bytes', () => {
    expect(remoteOrchSocketPath('/Users/me/cf-remote/h1/')).toBe('/Users/me/cf-remote/h1/s/o.sock');
    // '/' + n + '/s/o.sock' (9 bytes): 99 bytes passes, 100 does not.
    expect(() => remoteOrchSocketPath(`/${'x'.repeat(90)}`)).toThrow(RemoteSocketPathTooLongError);
    expect(() => remoteOrchSocketPath(`/${'x'.repeat(89)}`)).not.toThrow();
  });
});

describe('HostLink', () => {
  it('refcounts one forward, shares it, and closes it 60 s after the last release', async () => {
    const { link, forwards, timers, events } = make();
    const a = link.acquire();
    const b = link.acquire();
    expect(forwards).toHaveLength(1);
    expect(forwards[0].spec).toEqual({ remoteSock: '/Users/me/cf-remote/h1/s/o.sock', localSock: '/Users/me/.cyboflow/sockets/orch.sock' });
    forwards[0].up();
    expect(await a).toEqual({ remoteSock: '/Users/me/cf-remote/h1/s/o.sock' });
    expect(await b).toEqual({ remoteSock: '/Users/me/cf-remote/h1/s/o.sock' });
    expect(events).toEqual([{ type: 'link-up', hostId: 'h1', remoteSock: '/Users/me/cf-remote/h1/s/o.sock' }]);
    expect(link.refCount).toBe(2);
    link.release();
    expect(timers.pending()).toBe(0);
    link.release();
    expect(timers.delays()).toEqual([60_000]);
    // Reacquired inside the idle window: the same forward, the idle close is cancelled.
    await link.acquire();
    expect(forwards).toHaveLength(1);
    expect(timers.pending()).toBe(0);
    link.release();
    timers.fireNext();
    expect(forwards[0].closed).toBe(true);
    expect(link.state).toBe('idle');
    await flush();
    expect(events.filter((e) => e.type === 'link-down')).toEqual([]);
  });

  it('a failed first open rejects every waiter, holds no reference, and does not reconnect', async () => {
    const { link, forwards, timers } = make();
    const a = link.acquire();
    const b = link.acquire();
    forwards[0].fail('remote port forwarding failed');
    await expect(a).rejects.toBeInstanceOf(ForwardFailedError);
    await expect(b).rejects.toBeInstanceOf(ForwardFailedError);
    expect(link.refCount).toBe(0);
    expect(link.state).toBe('idle');
    expect(timers.pending()).toBe(0);
    const c = link.acquire();
    expect(forwards).toHaveLength(2);
    forwards[1].up();
    await expect(c).resolves.toBeTruthy();
  });

  it('an unexpected exit while held emits link-down and reconnects with 1/2/5/10/10 s backoff, then link-up', async () => {
    const { link, forwards, timers, events } = make();
    const a = link.acquire();
    forwards[0].up();
    await a;
    forwards[0].drop(255, 'client_loop: send disconnect: Broken pipe');
    expect(link.state).toBe('reconnecting');
    expect(events.at(-1)).toEqual({ type: 'link-down', hostId: 'h1', reason: 'client_loop: send disconnect: Broken pipe' });
    await expect(link.acquire()).rejects.toBeInstanceOf(HostLinkDownError);

    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(...timers.delays());
      timers.fireNext();
      forwards.at(-1)?.fail();
      await flush();
    }
    expect(seen).toEqual([...HOST_LINK_BACKOFF_MS, 10_000]);
    // Only the first drop is a link-down; failed retries are not re-announced.
    expect(events.filter((e) => e.type === 'link-down')).toHaveLength(1);
    timers.fireNext();
    forwards.at(-1)?.up();
    await flush();
    expect(link.state).toBe('up');
    expect(events.at(-1)?.type).toBe('link-up');
    // The backoff resets once up.
    forwards.at(-1)?.drop();
    expect(timers.delays()).toEqual([1_000]);
  });

  it('releasing the last reference while reconnecting stops retrying', async () => {
    const { link, forwards, timers } = make();
    const a = link.acquire();
    forwards[0].up();
    await a;
    forwards[0].drop();
    expect(timers.pending()).toBe(1);
    link.release();
    expect(timers.pending()).toBe(0);
    expect(link.state).toBe('idle');
  });

  it('an exit with no references (inside the idle window) just goes idle', async () => {
    const { link, forwards, timers, events } = make();
    const a = link.acquire();
    forwards[0].up();
    await a;
    link.release();
    forwards[0].drop();
    expect(link.state).toBe('idle');
    expect(timers.pending()).toBe(0);
    expect(events.filter((e) => e.type === 'link-down')).toEqual([]);
  });

  it('refuses before a probe or with a too-long root, without touching ssh; dispose closes and refuses', async () => {
    const notProbed = make({ root: null });
    await expect(notProbed.link.acquire()).rejects.toBeInstanceOf(HostLinkNotReadyError);
    const tooLong = make({ root: `/${'r'.repeat(95)}` });
    await expect(tooLong.link.acquire()).rejects.toBeInstanceOf(RemoteSocketPathTooLongError);
    expect(notProbed.forwards).toHaveLength(0);
    expect(tooLong.forwards).toHaveLength(0);

    const { link, forwards } = make();
    const a = link.acquire();
    forwards[0].up();
    await a;
    link.dispose();
    expect(forwards[0].closed).toBe(true);
    await expect(link.acquire()).rejects.toBeInstanceOf(HostLinkDownError);
  });

  it('HostLinkPool hands out one link per host and replaces a disposed one', () => {
    const created: string[] = [];
    const pool = new HostLinkPool((id) => {
      created.push(id);
      return make().link;
    });
    const a = pool.get('h1');
    expect(pool.get('h1')).toBe(a);
    pool.dispose('h1');
    expect(pool.get('h1')).not.toBe(a);
    pool.get('h2');
    pool.disposeAll();
    expect(created).toEqual(['h1', 'h1', 'h2']);
  });
});
