import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type * as net from 'net';
import { probePort } from '../portProbe';

class FakeSocket extends EventEmitter {
  destroy = vi.fn();
}

function asSocket(s: FakeSocket): net.Socket {
  return s as unknown as net.Socket;
}

describe('probePort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves inUse: true when the connection is accepted', async () => {
    const sock = new FakeSocket();
    const connect = vi.fn(() => asSocket(sock));
    const p = probePort(4521, 'dev', { connect });
    sock.emit('connect');
    await expect(p).resolves.toEqual({ port: 4521, label: 'dev', inUse: true });
    expect(connect).toHaveBeenCalledWith(4521);
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('resolves inUse: false on a connect error', async () => {
    const sock = new FakeSocket();
    const p = probePort(9223, 'cdp', { connect: () => asSocket(sock) });
    sock.emit('error', new Error('ECONNREFUSED'));
    await expect(p).resolves.toEqual({ port: 9223, label: 'cdp', inUse: false });
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('resolves inUse: false on timeout', async () => {
    vi.useFakeTimers();
    const sock = new FakeSocket();
    const p = probePort(9223, 'cdp', { timeoutMs: 100, connect: () => asSocket(sock) });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ port: 9223, label: 'cdp', inUse: false });
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('resolves inUse: false when the connect factory throws', async () => {
    const p = probePort(1, 'x', {
      connect: () => {
        throw new Error('boom');
      },
    });
    await expect(p).resolves.toEqual({ port: 1, label: 'x', inUse: false });
  });

  it('settles once: a connect after a timeout does not flip the result', async () => {
    vi.useFakeTimers();
    const sock = new FakeSocket();
    const p = probePort(1, 'x', { timeoutMs: 10, connect: () => asSocket(sock) });
    await vi.advanceTimersByTimeAsync(10);
    sock.emit('connect');
    await expect(p).resolves.toMatchObject({ inUse: false });
  });
});

describe('portProbe.ts / systemTypes.ts import hygiene', () => {
  const dir = path.resolve(__dirname, '..');
  it.each(['portProbe.ts', 'systemTypes.ts'])('%s has no forbidden imports', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    expect(src).not.toMatch(/from\s+['"]electron['"]/);
    expect(src).not.toMatch(/from\s+['"]better-sqlite3['"]/);
    expect(src).not.toMatch(/from\s+['"](\.\.\/)+services\//);
  });
});
