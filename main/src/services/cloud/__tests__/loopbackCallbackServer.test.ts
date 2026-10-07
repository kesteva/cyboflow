import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startLoopbackCallbackServer } from '../loopbackCallbackServer';
import type { LoopbackCallbackServer, LoopbackOutcome } from '../loopbackCallbackServer';

const STATE = 'S'.repeat(43);
const CODE = 'C'.repeat(43);

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function get(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; agent?: http.Agent } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers, agent: opts.agent },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function settled(server: LoopbackCallbackServer, ms = 80): Promise<LoopbackOutcome | 'pending'> {
  return Promise.race([server.outcome, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

describe('loopbackCallbackServer', () => {
  const servers: LoopbackCallbackServer[] = [];
  const start = async (): Promise<LoopbackCallbackServer> => {
    const s = await startLoopbackCallbackServer({ expectedState: STATE });
    servers.push(s);
    return s;
  };
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('binds 127.0.0.1 only, on an unprivileged port', async () => {
    const s = await start();
    expect(s.port).toBeGreaterThanOrEqual(1024);
    await expect(get(s.port, `/cb?state=${STATE}&code=short`)).resolves.toBeDefined();
    // The IPv6 loopback is not bound.
    await expect(
      new Promise((resolve, reject) => {
        const req = http.request({ host: '::1', port: s.port, path: '/cb' }, resolve);
        req.on('error', reject);
        req.end();
      }),
    ).rejects.toBeDefined();
  });

  it('a matching state with a 43-char code resolves {kind:code}, with hardened headers and a static page', async () => {
    const s = await start();
    const reply = await get(s.port, `/cb?code=${CODE}&state=${STATE}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['content-security-policy']).toContain("default-src 'none'");
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.body).not.toContain(CODE);
    expect(reply.body).not.toContain(STATE);
    await expect(s.outcome).resolves.toEqual({ kind: 'code', code: CODE });
  });

  it('a mismatched state answers 400 and keeps listening', async () => {
    const s = await start();
    const reply = await get(s.port, `/cb?code=${CODE}&state=wrong`);
    expect(reply.status).toBe(400);
    expect(await settled(s)).toBe('pending');
    const ok = await get(s.port, `/cb?code=${CODE}&state=${STATE}`);
    expect(ok.status).toBe(200);
  });

  it('a missing state answers 400 and does not resolve', async () => {
    const s = await start();
    expect((await get(s.port, `/cb?code=${CODE}`)).status).toBe(400);
    expect(await settled(s)).toBe('pending');
  });

  it('after 10 mismatched-state requests the valid callback still resolves {kind:code}', async () => {
    const s = await start();
    for (let i = 0; i < 10; i += 1) expect((await get(s.port, `/cb?code=${CODE}&state=bad${i}`)).status).toBe(400);
    expect(await settled(s)).toBe('pending');
    await get(s.port, `/cb?code=${CODE}&state=${STATE}`);
    await expect(s.outcome).resolves.toEqual({ kind: 'code', code: CODE });
  });

  it('Sec-Fetch-Mode: no-cors answers 400 and does not resolve', async () => {
    const s = await start();
    const reply = await get(s.port, `/cb?code=${CODE}&state=${STATE}`, { headers: { 'Sec-Fetch-Mode': 'no-cors' } });
    expect(reply.status).toBe(400);
    expect(await settled(s)).toBe('pending');
  });

  it('Sec-Fetch-Mode: navigate with the right state resolves', async () => {
    const s = await start();
    const reply = await get(s.port, `/cb?code=${CODE}&state=${STATE}`, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
    expect(reply.status).toBe(200);
    await expect(s.outcome).resolves.toEqual({ kind: 'code', code: CODE });
  });

  it('error=cancelled resolves cancelled', async () => {
    const s = await start();
    await get(s.port, `/cb?error=cancelled&state=${STATE}`);
    await expect(s.outcome).resolves.toEqual({ kind: 'cancelled' });
  });

  it('error=access_denied resolves browser_error', async () => {
    const s = await start();
    await get(s.port, `/cb?error=access_denied&state=${STATE}`);
    await expect(s.outcome).resolves.toEqual({ kind: 'browser_error', error: 'access_denied' });
  });

  it('a missing or short code resolves invalid_callback', async () => {
    const a = await start();
    await get(a.port, `/cb?state=${STATE}`);
    await expect(a.outcome).resolves.toEqual({ kind: 'invalid_callback' });
    const b = await start();
    await get(b.port, `/cb?state=${STATE}&code=abc`);
    await expect(b.outcome).resolves.toEqual({ kind: 'invalid_callback' });
  });

  it('POST is 405, /favicon.ico is 404 and a wrong Host is 400; none resolve', async () => {
    const s = await start();
    expect((await get(s.port, `/cb?code=${CODE}&state=${STATE}`, { method: 'POST' })).status).toBe(405);
    expect((await get(s.port, '/favicon.ico')).status).toBe(404);
    expect((await get(s.port, `/cb?code=${CODE}&state=${STATE}`, { headers: { Host: 'evil.example.com' } })).status).toBe(400);
    expect(await settled(s)).toBe('pending');
  });

  it('close() destroys a kept-alive socket quickly', async () => {
    const s = await start();
    const agent = new http.Agent({ keepAlive: true });
    const sockets = new Set<import('node:net').Socket>();
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/favicon.ico', agent, headers: { Connection: 'keep-alive' } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('socket', (sock) => sockets.add(sock));
      req.on('error', reject);
      req.end();
    });
    const [socket] = [...sockets];
    const closed = new Promise<number>((resolve) => {
      const started = Date.now();
      socket?.on('close', () => resolve(Date.now() - started));
    });
    s.close();
    const elapsed = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(10_000), 1_000))]);
    agent.destroy();
    expect(elapsed).toBeLessThan(200);
  });

  it('close() is idempotent', async () => {
    const s = await start();
    s.close();
    expect(() => s.close()).not.toThrow();
  });

  it('a request after resolution is refused or answered 409', async () => {
    const s = await start();
    await get(s.port, `/cb?code=${CODE}&state=${STATE}`);
    const second = await get(s.port, `/cb?code=${CODE}&state=${STATE}`).catch(() => null);
    if (second !== null) expect(second.status).toBe(409);
  });

  it('closes itself after a resolving response', async () => {
    const s = await start();
    await get(s.port, `/cb?code=${CODE}&state=${STATE}`);
    await new Promise((r) => setTimeout(r, 100));
    await expect(get(s.port, '/cb')).rejects.toBeDefined();
  });
});
