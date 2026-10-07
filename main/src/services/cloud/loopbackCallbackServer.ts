/**
 * The one-shot loopback listener that receives the browser sign-in redirect.
 *
 * Binds 127.0.0.1 on an ephemeral port (never 'localhost' / '::1': the sign-in page always redirects to
 * http://127.0.0.1:<port>/cb). A page in the user's browser can reach this port, so:
 *  - a request whose `state` is missing or wrong is answered 400 and otherwise IGNORED (no counter, no
 *    outcome, the listener keeps waiting) — the 43-char `state` is not guessable, and a counter would let
 *    any web page end the sign-in;
 *  - a request carrying a Sec-Fetch-Mode other than `navigate` is refused (the real callback is a
 *    top-level redirect; <img>/fetch requests are not).
 * Pages are static strings; no query value is ever echoed or logged.
 */
import http from 'node:http';
import type { Socket } from 'node:net';
import { LOGIN_CODE_RE } from '../../../../shared/types/cloudAccountWire';
import { timingSafeEqualStr } from './pkce';

export type LoopbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'cancelled' }
  | { kind: 'browser_error'; error: string }
  | { kind: 'invalid_callback' };

export interface LoopbackCallbackServer {
  readonly port: number;
  /** Resolves on the first terminal outcome; never rejects. */
  readonly outcome: Promise<LoopbackOutcome>;
  /** server.close() + destroy every tracked socket; idempotent; synchronous. */
  close(): void;
}

export interface LoopbackOptions {
  expectedState: string;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

const MAX_BIND_ATTEMPTS = 3;
const CLOSE_FALLBACK_MS = 2_000;

function page(title: string, message: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cyboflow</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    'body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 16px;color:#222;background:#fff}' +
    '@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}' +
    `</style></head><body><h1>${title}</h1><p>${message}</p></body></html>`
  );
}

const PAGE_MISMATCH = page('This link does not match', 'Return to cyboflow and start the sign-in again.');
const PAGE_HANDLED = page('Already handled', 'This sign-in link was already used. You can close this tab.');
const PAGE_CANCELLED = page('Sign-in cancelled', 'You can close this tab.');
const PAGE_FAILED = page('Sign-in did not complete', 'Return to cyboflow and try again. You can close this tab.');
const PAGE_OK = page('Finishing sign-in in cyboflow', 'You can close this tab.');
const PAGE_BAD_REQUEST = page('Bad request', 'This request was not expected.');

function listenOnce(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function startLoopbackCallbackServer(opts: LoopbackOptions): Promise<LoopbackCallbackServer> {
  let lastError: unknown = new Error('loopback bind failed');
  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt += 1) {
    const sockets = new Set<Socket>();
    let settle: (o: LoopbackOutcome) => void = () => undefined;
    let settled = false;
    const outcome = new Promise<LoopbackOutcome>((resolve) => {
      settle = resolve;
    });
    let closed = false;
    let closeTimer: NodeJS.Timeout | null = null;

    const server = http.createServer();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (closeTimer) clearTimeout(closeTimer);
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    };

    try {
      await listenOnce(server);
    } catch (err) {
      lastError = err;
      close();
      continue;
    }
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (port < 1024) {
      close();
      lastError = new Error('loopback bound a privileged port');
      continue;
    }

    const respond = (res: http.ServerResponse, status: number, body: string, resolving: boolean): void => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        Connection: 'close',
      });
      if (resolving) {
        res.on('finish', close);
        closeTimer = setTimeout(close, CLOSE_FALLBACK_MS);
        closeTimer.unref();
      }
      res.end(body);
    };

    server.on('request', (req, res) => {
      if (req.method !== 'GET') return respond(res, 405, PAGE_BAD_REQUEST, false);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      } catch {
        return respond(res, 400, PAGE_BAD_REQUEST, false);
      }
      if (url.pathname !== '/cb') return respond(res, 404, PAGE_BAD_REQUEST, false);
      if (req.headers.host !== `127.0.0.1:${port}`) return respond(res, 400, PAGE_BAD_REQUEST, false);
      const fetchMode = req.headers['sec-fetch-mode'];
      if (fetchMode !== undefined && fetchMode !== 'navigate') return respond(res, 400, PAGE_BAD_REQUEST, false);

      const state = url.searchParams.get('state');
      if (state === null || !timingSafeEqualStr(state, opts.expectedState)) {
        return respond(res, 400, PAGE_MISMATCH, false);
      }
      if (settled) return respond(res, 409, PAGE_HANDLED, false);

      const finish = (o: LoopbackOutcome, body: string): void => {
        settled = true;
        settle(o);
        respond(res, 200, body, true);
      };

      const error = url.searchParams.get('error');
      if (error !== null) {
        if (error === 'cancelled') return finish({ kind: 'cancelled' }, PAGE_CANCELLED);
        const shown = error.slice(0, 64);
        opts.logger?.warn('[cloud] sign-in callback reported an error', { error: shown });
        return finish({ kind: 'browser_error', error: shown }, PAGE_FAILED);
      }
      const code = url.searchParams.get('code');
      if (code !== null && LOGIN_CODE_RE.test(code)) return finish({ kind: 'code', code }, PAGE_OK);
      return finish({ kind: 'invalid_callback' }, PAGE_FAILED);
    });

    return { port, outcome, close };
  }
  throw lastError instanceof Error ? lastError : new Error('loopback bind failed');
}
