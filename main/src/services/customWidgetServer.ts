/**
 * CustomWidgetServerManager (docs/proposals/CUSTOM-VIEWS.md §5.4, §9 row S3) —
 * the token-gated loopback server that serves tier-3 (`render.type === 'html'`)
 * widget documents to genuinely cross-origin (-> own OOPIF renderer) sandboxed
 * `<iframe>`s.
 *
 * Modeled closely on `designPrototypeServer.ts` (token, 127.0.0.1:0 bind,
 * open-socket tracking, 404/405/500 policy, HEAD support, scripted-frame
 * origin registration, watchdog target), with two differences driven by the
 * shape of this feature:
 *
 *   - ONE PROCESS-GLOBAL SERVER, not one per run. Every tier-3 widget frame in
 *     the app — across every open surface, every project — is the SAME kind
 *     of document (an author's HTML/JS driven by `window.cyboflow`), so there
 *     is no per-run identity to key a server on; `ensure`/`stop` take no
 *     argument and `getTargets()` reports the single origin under the
 *     sentinel runId `'custom-widgets'` (see `shared/services/designFrameWatchdog.ts`'s
 *     `WatchdogTarget` — `runId` is opaque to the watchdog itself, it is only
 *     ever echoed back on an emitted event).
 *   - TWO ROUTES, not one: `/widget/<id>/<rev>` (published spec — every
 *     non-editing surface) and `/widget-draft/<id>/<rev>` (draft spec — the
 *     authoring slot only, §7.3). `<rev>` is NOT validated against the
 *     widget's current revision — it exists so the renderer can change the
 *     iframe `src` (forcing a fresh navigation/process) whenever a save
 *     bumps the revision, mirroring how the prototype server reloads bytes
 *     fresh per request without a server restart.
 *
 * AUTHORIZATION: binding loopback is NOT access control — the first path
 * segment is an unguessable per-spawn token (`randomBytes(16)`), exactly as
 * `designPrototypeServer.ts` does.
 *
 * The loader fn, theme, origin-registry hooks, and watchdog control are all
 * constructor seams, so this manager unit-tests with plain fakes and no
 * Electron import; index.ts wires the concrete instances.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { LoggerLike } from '../orchestrator/types';
import { ARTIFACT_INTERACTIVE_CSP } from '../../../shared/types/artifacts';
import type { CustomWidget } from '../../../shared/types/customViews';
import { buildWidgetDocument } from '../../../shared/customViews/widgetDocument';
import {
  registerScriptedFrameOrigin,
  unregisterScriptedFrameOrigin,
} from '../ipc/artifactFrameGuard';
import type { WatchdogTarget } from './designFrameWatchdog';

/** The watchdog target/event `runId` this single server is reported under. */
export const CUSTOM_WIDGET_SERVER_RUN_ID = 'custom-widgets';

const PUBLISHED_PATH_RE = /^\/([^/]+)\/widget\/([^/]+)\/(\d+)$/;
const DRAFT_PATH_RE = /^\/([^/]+)\/widget-draft\/([^/]+)\/(\d+)$/;

export interface CustomWidgetServerManagerOptions {
  /** Load a widget row by id, or null when absent. */
  loadWidget: (widgetId: string) => CustomWidget | null;
  /** Theme tokens injected as `--<token>:<value>;` custom properties (`shared/customViews/theme.ts`). */
  theme: Record<string, string>;
  /** Watchdog to start when the server spawns and stop when it goes. */
  watchdog?: { start: () => void; stop: () => void };
  /** Register the live server's origin as a scripted artifact-frame identity. */
  registerOrigin?: (origin: string) => void;
  /** Unregister the server's origin on stop. */
  unregisterOrigin?: (origin: string) => void;
  logger?: LoggerLike;
}

interface LiveServer {
  server: Server;
  origin: string;
  baseUrl: string;
  token: string;
  sockets: Set<Socket>;
}

export class CustomWidgetServerManager {
  private readonly loadWidget: (widgetId: string) => CustomWidget | null;
  private readonly theme: Record<string, string>;
  private readonly watchdog?: { start: () => void; stop: () => void };
  private readonly registerOrigin: (origin: string) => void;
  private readonly unregisterOrigin: (origin: string) => void;
  private readonly logger?: LoggerLike;

  private live: LiveServer | null = null;
  /** In-flight spawn, so concurrent `ensure()` calls share a single server. */
  private pending: Promise<{ baseUrl: string; origin: string }> | null = null;

  constructor(opts: CustomWidgetServerManagerOptions) {
    this.loadWidget = opts.loadWidget;
    this.theme = opts.theme;
    this.watchdog = opts.watchdog;
    this.registerOrigin = opts.registerOrigin ?? registerScriptedFrameOrigin;
    this.unregisterOrigin = opts.unregisterOrigin ?? unregisterScriptedFrameOrigin;
    this.logger = opts.logger;
  }

  /** Ensure the single live server and return its tokenized base URL. Idempotent. */
  async ensure(): Promise<{ baseUrl: string; origin: string }> {
    if (this.live) return { baseUrl: this.live.baseUrl, origin: this.live.origin };
    if (this.pending) return this.pending;

    const spawnPromise = this.spawn().finally(() => {
      this.pending = null;
    });
    this.pending = spawnPromise;
    return spawnPromise;
  }

  /** Tear down the server. Idempotent — returns false when nothing was running. */
  async stop(): Promise<boolean> {
    const entry = this.live;
    if (!entry) return false;
    this.live = null;
    await this.releaseEntry(entry);
    this.watchdog?.stop();
    this.logger?.debug('[CustomWidgetServer] stopped');
    return true;
  }

  /** The live (origin, runId) pair the frame watchdog judges frames against — empty when not running. */
  getTargets(): WatchdogTarget[] {
    return this.live ? [{ origin: this.live.origin, runId: CUSTOM_WIDGET_SERVER_RUN_ID }] : [];
  }

  private async spawn(): Promise<{ baseUrl: string; origin: string }> {
    const token = randomBytes(16).toString('hex');
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      this.handleRequest(req, res, token);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    const port = await new Promise<number>((resolve, reject) => {
      let settled = false;
      server.on('error', (err) => {
        if (settled) {
          this.logger?.error('[CustomWidgetServer] server error after listening', {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      server.listen(0, '127.0.0.1', () => {
        if (settled) return;
        const address = server.address();
        if (address === null || typeof address === 'string') {
          settled = true;
          server.close();
          reject(new Error('custom widget server failed to bind a port'));
          return;
        }
        settled = true;
        resolve(address.port);
      });
    });

    const origin = `http://127.0.0.1:${port}`;
    const baseUrl = `${origin}/${token}`;
    this.live = { server, origin, baseUrl, token, sockets };
    this.registerOrigin(origin);
    this.watchdog?.start();
    this.logger?.info('[CustomWidgetServer] listening', { baseUrl });
    return { baseUrl, origin };
  }

  /**
   * Serve a token-matching published/draft widget document; everything else
   * is a bare 404 (or 405 for a disallowed method). Never throws — an
   * unexpected failure answers 500 (or destroys the socket if headers are
   * already out).
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse, token: string): void {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendStatus(res, 405, 'Method Not Allowed');
        return;
      }
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';

      const published = PUBLISHED_PATH_RE.exec(rawPath);
      if (published) {
        this.serveWidget(req, res, token, published[1] ?? '', published[2] ?? '', 'published');
        return;
      }
      const draft = DRAFT_PATH_RE.exec(rawPath);
      if (draft) {
        this.serveWidget(req, res, token, draft[1] ?? '', draft[2] ?? '', 'draft');
        return;
      }
      this.sendStatus(res, 404, 'Not Found');
    } catch (err) {
      this.logger?.error('[CustomWidgetServer] request handling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        this.sendStatus(res, 500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  }

  private serveWidget(
    req: IncomingMessage,
    res: ServerResponse,
    expectedToken: string,
    actualToken: string,
    widgetId: string,
    kind: 'published' | 'draft',
  ): void {
    // No path decoding/normalization beyond the regex match: a wrong token is
    // an indistinguishable 404, same as any other stray path.
    if (actualToken !== expectedToken) {
      this.sendStatus(res, 404, 'Not Found');
      return;
    }
    const widget = this.loadWidget(widgetId);
    const spec = widget ? (kind === 'published' ? widget.publishedSpec : widget.draftSpec) : null;
    if (!spec || spec.render.type !== 'html') {
      // Absent widget, absent published/draft spec, and a non-html render are
      // all the SAME 404 — nothing here leaks which case applied.
      this.sendStatus(res, 404, 'Not Found');
      return;
    }

    const html = buildWidgetDocument(spec, { theme: this.theme });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': ARTIFACT_INTERACTIVE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(html);
  }

  private async releaseEntry(entry: LiveServer): Promise<void> {
    this.unregisterOrigin(entry.origin);
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
      // close() only stops accepting NEW connections; destroy in-flight ones
      // so its callback isn't left waiting on a lingering keep-alive socket.
      for (const socket of entry.sockets) socket.destroy();
    });
  }

  private sendStatus(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(message);
  }
}
