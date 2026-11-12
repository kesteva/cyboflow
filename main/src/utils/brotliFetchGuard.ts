/**
 * Refuses Brotli on Node's built-in `fetch` while the runtime is exposed to
 * CVE-2026-111497 (out-of-bounds write in the Brotli decoder behind
 * `node:zlib`; remote code execution from an attacker-chosen `br` body).
 *
 * Why this exists: the fix shipped in Node 22.23.4 / 24.22.1 / 26.12.1, but
 * Electron 44.9.3 and 45.0.0 both still bundle Node 24.22.0, and the main
 * process plus every ELECTRON_RUN_AS_NODE subprocess run on that Node. Code
 * that goes through `globalThis.fetch` (the Linear / Plane / Dart tracker
 * adapters, model availability, the persistent-agent registry, the verify
 * driver) would decode a `Content-Encoding: br` response even if it never asked
 * for one, and a self-hosted Plane URL or a MITM'd connection chooses that
 * header. Electron `net.fetch` uses Chromium's network stack, whose Brotli is
 * already patched, so the cloud and relay clients are not covered here.
 *
 * The guard composes an interceptor onto undici's global dispatcher, which
 * Node's fetch reads per request. It (a) drops `br` from the outgoing
 * Accept-Encoding so well-behaved servers fall back to gzip, and (b) aborts any
 * response that still declares `br` BEFORE the headers reach fetch, which is
 * where fetch builds its decoder. No Brotli byte ever reaches zlib.
 *
 * Self-retiring: {@link isBrotliVulnerableNode} is false on a fixed runtime, so
 * once Electron ships Node >= 24.22.1 this becomes a no-op and can be deleted.
 */

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

/** First fixed patch per release line; lines not listed are treated as exposed up to the newest one. */
const FIXED_IN: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const NEWEST_FIXED_MAJOR = 26;

export function isBrotliVulnerableNode(version: string = process.versions.node): boolean {
  const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (![major, minor, patch].every(Number.isFinite)) return true;
  if (major > NEWEST_FIXED_MAJOR) return false;
  const fixed = FIXED_IN[major];
  if (!fixed) return true;
  return minor < fixed[0] || (minor === fixed[0] && patch < fixed[1]);
}

export class BrotliRefusedError extends Error {
  readonly code = 'CYBOFLOW_BROTLI_REFUSED';
  constructor(origin: string) {
    super(`Refused a Brotli-encoded response from ${origin} (CVE-2026-111497 guard)`);
    this.name = 'BrotliRefusedError';
  }
}

const BR = /(^|[\s,])br($|[\s,;])/i;

export function declaresBrotli(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(declaresBrotli);
  return typeof value === 'string' && BR.test(value);
}

/** Removes the `br` coding from an Accept-Encoding value; falls back to gzip/deflate if nothing is left. */
export function stripBrotli(value: string): string {
  const kept = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^br(\s*;|$)/i.test(part));
  return kept.length ? kept.join(', ') : 'gzip, deflate';
}

type RequestHeaders = Record<string, string | string[] | undefined> | string[] | null | undefined;

function rewriteAcceptEncoding(headers: RequestHeaders): RequestHeaders {
  if (Array.isArray(headers)) {
    const out = headers.slice();
    for (let i = 0; i + 1 < out.length; i += 2) {
      if (out[i].toLowerCase() === 'accept-encoding') out[i + 1] = stripBrotli(out[i + 1]);
    }
    return out;
  }
  if (headers && typeof headers === 'object') {
    const out: Record<string, string | string[] | undefined> = { ...headers };
    for (const key of Object.keys(out)) {
      const v = out[key];
      if (key.toLowerCase() === 'accept-encoding' && typeof v === 'string') out[key] = stripBrotli(v);
    }
    return out;
  }
  return headers;
}

// Structural slices of undici's dispatch API: Node bundles undici, but the
// `undici` package is not a dependency here, so its types are not importable.
// Node 24 (undici 7, what Electron runs) calls the controller-based handler
// methods; Node 22 (undici 6, host tooling and CI) calls the legacy ones.
interface Controller {
  abort(reason: Error): void;
}
interface Handler {
  onRequestStart?(controller: Controller, context: unknown): void;
  onRequestUpgrade?(controller: Controller, statusCode: number, headers: unknown, socket: unknown): void;
  onResponseStart?(controller: Controller, statusCode: number, headers: Record<string, unknown>, statusMessage?: string): void;
  onResponseData?(controller: Controller, chunk: unknown): void;
  onResponseEnd?(controller: Controller, trailers: unknown): void;
  onResponseError?(controller: Controller, err: Error): void;
}
interface LegacyHandler {
  onConnect?(abort: (err?: Error) => void, context?: unknown): void;
  onHeaders?(statusCode: number, rawHeaders: Buffer[], resume: () => void, statusText: string): boolean;
  [method: string]: unknown;
}
interface DispatchOptions {
  origin?: unknown;
  headers?: RequestHeaders;
}
type Dispatch = (opts: DispatchOptions, handler: Handler | LegacyHandler) => boolean;
interface Dispatcher {
  compose(interceptor: (dispatch: Dispatch) => Dispatch): Dispatcher;
}

class BrotliGuardHandler implements Handler {
  constructor(
    private readonly inner: Handler,
    private readonly origin: string,
  ) {}
  onRequestStart(controller: Controller, context: unknown): void {
    this.inner.onRequestStart?.(controller, context);
  }
  onRequestUpgrade(controller: Controller, statusCode: number, headers: unknown, socket: unknown): void {
    this.inner.onRequestUpgrade?.(controller, statusCode, headers, socket);
  }
  onResponseStart(controller: Controller, statusCode: number, headers: Record<string, unknown>, statusMessage?: string): void {
    if (declaresBrotli(headers['content-encoding'])) {
      controller.abort(new BrotliRefusedError(this.origin));
      return;
    }
    this.inner.onResponseStart?.(controller, statusCode, headers, statusMessage);
  }
  onResponseData(controller: Controller, chunk: unknown): void {
    this.inner.onResponseData?.(controller, chunk);
  }
  onResponseEnd(controller: Controller, trailers: unknown): void {
    this.inner.onResponseEnd?.(controller, trailers);
  }
  onResponseError(controller: Controller, err: Error): void {
    this.inner.onResponseError?.(controller, err);
  }
}

function rawHeadersDeclareBrotli(rawHeaders: Buffer[]): boolean {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === 'content-encoding' && declaresBrotli(String(rawHeaders[i + 1]))) return true;
  }
  return false;
}

/** Legacy-API wrapper: every method forwards, except that `br` headers abort via the onConnect-supplied abort. */
function guardLegacyHandler(inner: LegacyHandler, origin: string): LegacyHandler {
  let abort: ((err?: Error) => void) | undefined;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'onConnect') {
        return (a: (err?: Error) => void, context?: unknown) => {
          abort = a;
          target.onConnect?.(a, context);
        };
      }
      if (prop === 'onHeaders') {
        return (statusCode: number, rawHeaders: Buffer[], resume: () => void, statusText: string) => {
          if (rawHeadersDeclareBrotli(rawHeaders)) {
            abort?.(new BrotliRefusedError(origin));
            return false;
          }
          return target.onHeaders?.(statusCode, rawHeaders, resume, statusText) ?? true;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function brotliGuardInterceptor(dispatch: Dispatch): Dispatch {
  return (opts, handler) => {
    const guarded = { ...opts, headers: rewriteAcceptEncoding(opts.headers) };
    const origin = String(opts.origin ?? 'unknown origin');
    if (typeof (handler as Handler).onResponseStart === 'function') {
      return dispatch(guarded, new BrotliGuardHandler(handler as Handler, origin));
    }
    if (typeof (handler as LegacyHandler).onHeaders === 'function') {
      return dispatch(guarded, guardLegacyHandler(handler as LegacyHandler, origin));
    }
    // Neither API: a different undici than this was written against. Pass it
    // through rather than break fetch.
    return dispatch(opts, handler);
  };
}

let installed = false;

/** Installs the guard on this process's global fetch. Returns whether it is now active. */
export function installBrotliFetchGuard(nodeVersion: string = process.versions.node): boolean {
  if (installed) return true;
  if (!isBrotliVulnerableNode(nodeVersion)) return false;
  const holder = globalThis as unknown as Record<symbol, Dispatcher | undefined>;
  if (!holder[GLOBAL_DISPATCHER] && typeof globalThis.fetch === 'function') {
    // Node loads undici (and creates the global Agent) on the first fetch
    // call, synchronously. A data: URL makes that call with no network I/O.
    globalThis.fetch('data:,').catch(() => undefined);
  }
  const current = holder[GLOBAL_DISPATCHER];
  if (!current || typeof current.compose !== 'function') return false;
  holder[GLOBAL_DISPATCHER] = current.compose(brotliGuardInterceptor);
  installed = true;
  return true;
}
