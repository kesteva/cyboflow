/**
 * openUrlShellHook — the session CLI's `$BROWSER`. Only an `ok` reply from the
 * app counts as opened; every other outcome must send the URL to the OS opener,
 * so a link is never silently dropped.
 */
import { EventEmitter } from 'events';
import type * as net from 'net';
import { describe, expect, it, vi } from 'vitest';
import { osOpenCommand, requestViewerOpen } from '../openUrlShellHook';

/** A socket that connects, records writes, and answers via `reply`. */
function fakeSocket(reply: (line: Record<string, unknown>) => Record<string, unknown> | 'close' | null) {
  const sock = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroy: () => void; sent: string[] };
  sock.sent = [];
  sock.destroy = vi.fn();
  sock.write = (s: string) => {
    sock.sent.push(s);
    const answer = reply(JSON.parse(s) as Record<string, unknown>);
    setTimeout(() => {
      if (answer === 'close') sock.emit('close');
      else if (answer) sock.emit('data', Buffer.from(JSON.stringify(answer) + '\n'));
    }, 0);
    return true;
  };
  setTimeout(() => sock.emit('connect'), 0);
  return sock;
}

const base = { socketPath: '/tmp/orch.sock', runId: 'run-1', token: 'tok', url: 'https://claude.ai/code/artifact/x' };

describe('requestViewerOpen', () => {
  it('sends one web-open-url line with the run, token and url, and resolves true on ok', async () => {
    const sock = fakeSocket((m) => ({ type: 'mcp-query-response', requestId: m.requestId, ok: true }));
    const ok = await requestViewerOpen({ ...base, connect: () => sock as unknown as net.Socket });
    expect(ok).toBe(true);
    expect(JSON.parse(sock.sent[0])).toMatchObject({ type: 'web-open-url', runId: 'run-1', token: 'tok', url: base.url });
  });

  it('resolves false on an error reply (viewer off, tab cap) so the OS opener takes over', async () => {
    const ok = await requestViewerOpen({
      ...base,
      connect: () => fakeSocket((m) => ({ requestId: m.requestId, ok: false, error: 'viewer_disabled' })) as never,
    });
    expect(ok).toBe(false);
  });

  it('ignores a reply to someone else’s request', async () => {
    const ok = await requestViewerOpen({
      ...base,
      timeoutMs: 30,
      connect: () => fakeSocket(() => ({ requestId: 'other', ok: true })) as never,
    });
    expect(ok).toBe(false);
  });

  it('resolves false when the socket closes or never answers', async () => {
    expect(await requestViewerOpen({ ...base, connect: () => fakeSocket(() => 'close') as never })).toBe(false);
    expect(await requestViewerOpen({ ...base, timeoutMs: 30, connect: () => fakeSocket(() => null) as never })).toBe(false);
  });

  it('resolves false when connecting throws', async () => {
    const ok = await requestViewerOpen({
      ...base,
      connect: () => {
        throw new Error('ENOENT');
      },
    });
    expect(ok).toBe(false);
  });
});

describe('osOpenCommand', () => {
  it('stands in for the platform opener', () => {
    expect(osOpenCommand('darwin')).toEqual({ command: 'open', args: [] });
    expect(osOpenCommand('linux')).toEqual({ command: 'xdg-open', args: [] });
  });
});
