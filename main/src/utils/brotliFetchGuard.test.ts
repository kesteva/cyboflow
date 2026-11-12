import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { brotliCompressSync, gzipSync } from 'zlib';
import {
  brotliGuardInterceptor,
  declaresBrotli,
  installBrotliFetchGuard,
  isBrotliVulnerableNode,
  stripBrotli,
} from './brotliFetchGuard';

describe('isBrotliVulnerableNode', () => {
  it.each([
    ['22.15.1', true],
    ['22.23.3', true],
    ['22.23.4', false],
    ['22.24.0', false],
    ['24.22.0', true], // Electron 44.9.3 / 45.0.0
    ['24.22.1', false],
    ['26.12.0', true],
    ['26.12.1', false],
    ['23.11.0', true], // EOL line, never patched
    ['27.0.0', false],
    ['garbage', true],
  ])('%s -> %s', (version, expected) => {
    expect(isBrotliVulnerableNode(version)).toBe(expected);
  });
});

describe('header helpers', () => {
  it('detects br in single, listed and repeated content-encodings', () => {
    expect(declaresBrotli('br')).toBe(true);
    expect(declaresBrotli('gzip, br')).toBe(true);
    expect(declaresBrotli(['gzip', 'BR'])).toBe(true);
    expect(declaresBrotli('gzip')).toBe(false);
    expect(declaresBrotli('brotli-ish')).toBe(false);
    expect(declaresBrotli(undefined)).toBe(false);
  });

  it('strips br from accept-encoding, keeping the rest', () => {
    expect(stripBrotli('gzip, deflate, br')).toBe('gzip, deflate');
    expect(stripBrotli('br;q=1.0, gzip;q=0.8')).toBe('gzip;q=0.8');
    expect(stripBrotli('br')).toBe('gzip, deflate');
  });
});

describe('installBrotliFetchGuard', () => {
  it('stays off on a fixed runtime', () => {
    expect(installBrotliFetchGuard('24.22.1')).toBe(false);
  });
});

describe('brotliGuardInterceptor over the real fetch', () => {
  let server: http.Server;
  let base: string;
  let lastAcceptEncoding: string | undefined;
  type Composable = { compose(i: typeof brotliGuardInterceptor): unknown };
  let guarded: unknown;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAcceptEncoding = req.headers['accept-encoding'];
      const body = Buffer.from('payload');
      if (req.url === '/br') {
        res.writeHead(200, { 'content-encoding': 'br' });
        res.end(brotliCompressSync(body));
      } else if (req.url === '/gzip-br') {
        res.writeHead(200, { 'content-encoding': 'gzip, br' });
        res.end(brotliCompressSync(gzipSync(body)));
      } else if (req.url === '/gzip') {
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(gzipSync(body));
      } else {
        res.end(body);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Compose onto a per-request dispatcher rather than the global one so the
    // test neither depends on the host Node version nor leaks into other suites.
    await fetch('data:,');
    const global = (globalThis as unknown as Record<symbol, Composable>)[Symbol.for('undici.globalDispatcher.1')];
    guarded = global.compose(brotliGuardInterceptor);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = (path: string, headers?: Record<string, string>) =>
    fetch(`${base}${path}`, { headers, dispatcher: guarded } as RequestInit);

  it('negative control: unguarded fetch decodes br', async () => {
    expect(await (await fetch(`${base}/br`)).text()).toBe('payload');
  });

  it('passes plain and gzip responses through', async () => {
    expect(await (await get('/plain')).text()).toBe('payload');
    expect(await (await get('/gzip')).text()).toBe('payload');
  });

  it('refuses a br response before it is decoded', async () => {
    await expect(get('/br')).rejects.toMatchObject({ cause: { name: 'BrotliRefusedError' } });
  });

  it('refuses br anywhere in a stacked content-encoding', async () => {
    await expect(get('/gzip-br')).rejects.toMatchObject({ cause: { name: 'BrotliRefusedError' } });
  });

  it('never advertises br, even when the caller asks for it', async () => {
    await (await get('/plain')).text();
    expect(lastAcceptEncoding).not.toMatch(/br/);
    await (await get('/plain', { 'Accept-Encoding': 'br, gzip' })).text();
    expect(lastAcceptEncoding).toBe('gzip');
  });
});
