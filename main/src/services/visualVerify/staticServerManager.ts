/**
 * StaticServerManager — the concrete static-file-server spawner for layered
 * visual verification (S9, see docs/visual-verification-design.md §"Locked
 * decisions" #1 + the S9 slice). It closes the zero-config `htmlPath` blank-page
 * class: a request that points at a BUILT html file (no dev server, no
 * verify.json `start`) was previously loaded over `file://` by the rung-0
 * CapturePageBackend — Chromium treats `file://` as an opaque origin and
 * CORS-blocks every `<script type="module">`, so bundler output silently
 * rendered a blank styled shell. This service stands the html's static root up
 * on an EPHEMERAL loopback HTTP server (127.0.0.1, OS-assigned port) and threads
 * the resulting tokenized entry URL into capture, exactly like the S2 dev server
 * (URL threading is the scheduler's job; the backend stays stateless).
 *
 * This file lives under main/src/services/* and MAY import node:http/node:fs/
 * node:crypto — it is the concrete, I/O-backed half INJECTED into the
 * (electron-free, fs-free) scheduler as a StaticServerProvider. The scheduler
 * imports the StaticServerProvider / StaticServerHandle TYPES from
 * orchestrator/verify (a services->orchestrator import is allowed); it never
 * imports this module (orchestrator->services is forbidden — standalone-
 * typecheck invariant). index.ts wires the concrete instance in, exactly like
 * DevServerManager / CapturePageBackend / VlmJudge.
 *
 * Authorization boundary (Codex security finding): binding a port alone is NOT
 * an access-control decision — anything on the loopback interface could hit it.
 * So EVERY request must present an unguessable 32-hex-char token (randomBytes(16)
 * from node:crypto, generated fresh per spawn) as the FIRST path segment; a
 * request whose path does not start with `/<token>/` is a 404, indistinguishable
 * from a not-found asset (no signal is leaked about whether the token is "close").
 *
 * Path-safety pipeline (per request, in order — see handleRequest):
 *   1. method gate — only GET/HEAD; everything else is 405.
 *   2. token gate — the path must start with `/<token>/`; else 404.
 *   3. decode — decodeURIComponent the remainder; a throw (malformed %-escape) or
 *      an embedded NUL byte is 400 (a malformed REQUEST, not a missing asset).
 *   4. denylist — any normalized path SEGMENT starting with '.' (covers .git,
 *      .env*, .cyboflow, and incidentally '..' itself — traversal is ALSO caught
 *      by the containment check below, this is defense in depth) or equal to
 *      'node_modules' (compared CASE-INSENSITIVELY — the primary platform's
 *      APFS is case-insensitive, so 'NODE_MODULES' resolves to the same
 *      directory and must not slip past an exact compare) is 404, loudly logged
 *      (a review requirement — a silent 404 here would hide a real leak attempt
 *      from operators).
 *   5. lexical containment — path.resolve(staticRoot, normalized) MUST fall
 *      under staticRoot (exact match or `staticRoot + sep` prefix); else 404
 *      + warn.
 *   6. realpath containment — the SAME check repeated on fs.realpath() of both
 *      the resolved path and staticRoot, closing the symlink-escape hole a
 *      lexical check alone cannot see (a symlink inside staticRoot pointing
 *      OUTSIDE it resolves lexically-fine but realpath-escapes). The denylist
 *      is then RE-RUN over the realpath's own segments relative to the real
 *      root, so an innocuously-named symlink INSIDE the root pointing at a
 *      denied dir also inside it (`x -> node_modules`, `x -> .git`) cannot
 *      serve what the request-path denylist would have blocked.
 *   7. directory guard — a path resolving to a directory is 404 (no listing, no
 *      implicit index.html; the entry file is addressed explicitly by baseUrl).
 *   8. serve — stream the file (createReadStream) with nosniff + no-store +
 *      a Content-Type from the extension map; a missing file is 404 + warn.
 *
 * Unlike DevServerManager there is no `build`/`start`/readiness wait to tune —
 * binding 127.0.0.1:0 resolves as soon as the OS hands back a port, so this
 * service has no timing tunables; StaticServerManagerOptions carries only the
 * optional logger.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import type {
  StaticServerHandle,
  StaticServerProvider,
  StaticServerSpawnArgs,
} from '../../orchestrator/verify/verificationScheduler';
import type { LoggerLike } from '../../orchestrator/types';

/** Construction-time tunables (currently just the optional logger — see header). */
export interface StaticServerManagerOptions {
  logger?: LoggerLike;
}

/**
 * Content-Type by lowercased extension (no leading dot). Deliberately narrow —
 * an unlisted extension falls back to 'application/octet-stream' (safe default;
 * combined with the nosniff header below, an unknown type is never sniffed into
 * something executable by the capturing browser).
 */
const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
};

/**
 * True when a path segment is denied outright: dotfile/dir segments (.git,
 * .env*, .cyboflow) and node_modules. node_modules compares CASE-INSENSITIVELY:
 * the primary platform's APFS is case-insensitive, so 'NODE_MODULES' names the
 * same directory and an exact compare would silently serve it. (The dot check is
 * already case-agnostic — '.' has no case.) Applied to BOTH the request path's
 * segments and the served file's realpath segments (symlink-alias guard).
 */
function isDeniedSegment(segment: string): boolean {
  return segment.startsWith('.') || segment.toLowerCase() === 'node_modules';
}

export class StaticServerManager implements StaticServerProvider {
  private readonly logger?: LoggerLike;

  constructor(opts: StaticServerManagerOptions = {}) {
    this.logger = opts.logger;
  }

  /**
   * Bind an ephemeral loopback server confined to `staticRoot`, mint a fresh
   * unguessable token, and resolve a StaticServerHandle whose baseUrl is the
   * FULL entry-file URL (not the bare origin) — the scheduler rewrites it into
   * ctx.input.url verbatim. All per-request state (token, resolved root, the
   * open-socket set) lives in THIS call's closure, never on `this` — spawn() is
   * called once per verification request and multiple requests may be in
   * flight concurrently, each owning its own server/token/lifecycle.
   */
  async spawn(args: StaticServerSpawnArgs): Promise<StaticServerHandle> {
    const { absoluteHtmlPath, staticRoot, signal } = args;
    if (signal.aborted) {
      throw new Error('static server spawn aborted');
    }

    // Unguessable per-spawn token — the sole authorization boundary (see header).
    const token = randomBytes(16).toString('hex');
    const resolvedRoot = path.resolve(staticRoot);

    // Tracked open sockets so release() can force-destroy them even if a
    // slow/streaming response is mid-flight (server.close() alone only stops
    // accepting NEW connections; it waits indefinitely for existing ones).
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      void this.handleRequest(req, res, token, resolvedRoot);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Destroy anything still open (e.g. an in-flight capture request) so
        // close()'s callback isn't left waiting on a lingering connection.
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    };

    return new Promise<StaticServerHandle>((resolve, reject) => {
      let settled = false;

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        void release().finally(() => reject(new Error('static server spawn aborted')));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // One handler covers both "failed to bind" (before settled) and any rare
      // post-listen server-level error (after settled, logged not thrown — an
      // unhandled 'error' event would otherwise crash the process).
      server.on('error', (err) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        this.logger?.error('[StaticServerManager] server error after listening', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      server.listen(0, '127.0.0.1', () => {
        if (settled) return;
        settled = true;
        // The scheduler's per-request signal cancels the CAPTURE later, not this
        // live server — release() (called from the scheduler's finally) is what
        // tears it down, so the abort listener is scoped to spawn only, mirroring
        // how DevServerManager scopes its signal to spawn/readiness.
        signal.removeEventListener('abort', onAbort);

        const address = server.address();
        if (address === null || typeof address === 'string') {
          void release().finally(() => reject(new Error('static server failed to bind a port')));
          return;
        }

        // POSIX-separator relative path regardless of host OS, per the
        // StaticServerSpawnArgs contract — path.relative already returns '/' on
        // POSIX; the split/join defends the (currently untested) Windows host.
        const relHtml = path
          .relative(resolvedRoot, path.resolve(absoluteHtmlPath))
          .split(path.sep)
          .join('/');
        const baseUrl = `http://127.0.0.1:${address.port}/${token}/${relHtml}`;
        this.logger?.info('[StaticServerManager] static server listening', {
          baseUrl,
          staticRoot: resolvedRoot,
        });
        resolve({ baseUrl, release });
      });
    });
  }

  /**
   * Handle one request through the full path-safety pipeline (see header). Never
   * throws — any unexpected failure is caught and answered 500 (or the socket is
   * destroyed if headers already went out).
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    staticRoot: string,
  ): Promise<void> {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendStatus(res, 405, 'Method Not Allowed');
        return;
      }

      const rawUrl = req.url ?? '/';
      const rawPath = rawUrl.split('?')[0] ?? '/';
      const prefix = `/${token}/`;
      if (!rawPath.startsWith(prefix)) {
        // No signal about WHY (missing vs. wrong token) — both are 404.
        this.sendStatus(res, 404, 'Not Found');
        return;
      }

      const encodedRelPath = rawPath.slice(prefix.length);
      let decodedRelPath: string;
      try {
        decodedRelPath = decodeURIComponent(encodedRelPath);
      } catch {
        // Malformed %-escape — a bad REQUEST, not a missing asset.
        this.sendStatus(res, 400, 'Bad Request');
        return;
      }
      if (decodedRelPath.includes('\u0000')) {
        // Embedded NUL — a malformed REQUEST (classic C-string-truncation
        // probe), not a missing asset.
        this.sendStatus(res, 400, 'Bad Request');
        return;
      }

      const normalizedRelPath = path.normalize(decodedRelPath);
      const segments = normalizedRelPath.split(path.sep).filter((s) => s.length > 0);
      for (const segment of segments) {
        // '..' is a traversal token, not a "hidden file" — it is caught by the
        // lexical + realpath containment checks below, not this denylist.
        if (segment === '..') continue;
        if (isDeniedSegment(segment)) {
          this.logger?.warn('[StaticServerManager] asset outside static root denied', {
            path: normalizedRelPath,
            segment,
          });
          this.sendStatus(res, 404, 'Not Found');
          return;
        }
      }

      const resolvedPath = path.resolve(staticRoot, normalizedRelPath);
      if (!this.isContained(resolvedPath, staticRoot)) {
        this.logger?.warn('[StaticServerManager] asset outside static root denied', {
          path: resolvedPath,
        });
        this.sendStatus(res, 404, 'Not Found');
        return;
      }

      // Symlink-escape guard: a symlink lexically INSIDE staticRoot can still
      // realpath to somewhere outside it. Resolve both sides through realpath so
      // a stale/missing staticRoot also falls out here as "not found".
      let realRoot: string;
      let realPath: string;
      try {
        realRoot = await realpath(staticRoot);
        realPath = await realpath(resolvedPath);
      } catch {
        this.logger?.warn('[StaticServerManager] static asset not found', { path: resolvedPath });
        this.sendStatus(res, 404, 'Not Found');
        return;
      }
      if (!this.isContained(realPath, realRoot)) {
        this.logger?.warn('[StaticServerManager] asset outside static root denied', {
          path: realPath,
        });
        this.sendStatus(res, 404, 'Not Found');
        return;
      }
      // Post-realpath denylist re-run: containment alone lets an innocuously-
      // named symlink INSIDE the root alias a denied dir also inside it
      // (`x -> node_modules`, `x -> .git`) — the request path shows only `x`,
      // but the filesystem identity the bytes come from is the denied dir.
      for (const segment of path.relative(realRoot, realPath).split(path.sep)) {
        if (segment.length === 0 || segment === '..') continue;
        if (isDeniedSegment(segment)) {
          this.logger?.warn('[StaticServerManager] asset outside static root denied', {
            path: realPath,
            segment,
          });
          this.sendStatus(res, 404, 'Not Found');
          return;
        }
      }

      let fileStat: Stats;
      try {
        fileStat = await stat(realPath);
      } catch {
        this.logger?.warn('[StaticServerManager] static asset not found', { path: realPath });
        this.sendStatus(res, 404, 'Not Found');
        return;
      }
      if (fileStat.isDirectory()) {
        // No directory listing, no implicit index.html — the entry file is
        // addressed explicitly by baseUrl.
        this.sendStatus(res, 404, 'Not Found');
        return;
      }

      const ext = path.extname(realPath).toLowerCase().slice(1);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = createReadStream(realPath);
      stream.on('error', (err) => {
        this.logger?.debug('[StaticServerManager] file stream error', {
          path: realPath,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          this.sendStatus(res, 404, 'Not Found');
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch (err) {
      this.logger?.error('[StaticServerManager] request handling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        this.sendStatus(res, 500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  }

  /** True when `candidate` is exactly `root` or nested under it. */
  private isContained(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(root + path.sep);
  }

  /** Minimal plain-text status response, carrying the same safety headers. */
  private sendStatus(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(message);
  }
}
