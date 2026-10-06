/**
 * DesignPrototypeServerManager (Design Mode v1 — design-mode.md "Process
 * isolation" + "Server lifecycle — bound to design-mode entry/exit (v1)") — the
 * token-gated loopback server that serves the run's interactive prototype
 * document to a genuinely cross-origin (→ own OOPIF renderer) canvas frame.
 *
 * SURFACE-SCOPED LIFECYCLE, not ambient. The design surface calls `ensure` on
 * entry (and on respawn) and `stop` on exit. There is exactly ONE server per
 * runId; `ensure` is idempotent (returns the SAME baseUrl/token while live).
 * Rationale (design-mode.md, from live testing): a long-lived ambient server the
 * UI merely hopes is still there gets reaped unpredictably and breaks any canvas
 * that counts on it — a surface-scoped lifecycle makes availability deterministic
 * and re-entry simply respawns from the on-disk blessed bytes.
 *
 * SINGLE-RESOURCE server — deliberately no static-root pipeline (path-traversal
 * denylist, realpath containment, MIME map): the interactive prototype contract is ONE self-contained `prototype/index.html`
 * with no sibling assets (subresources are inline data: only, enforced by the
 * injected CSP), so this server answers EXACTLY one path —
 * `/<token>/prototype/index.html` — and 404s everything else, leaking no signal
 * about whether a bad token was "close". The served bytes are loaded FRESH PER
 * REQUEST (not cached at spawn) so an agent re-report of the prototype is picked
 * up on the next reload without a server restart, and the interactive CSP is
 * delivered as a RESPONSE HEADER — applied by the browser before a single
 * content byte is parsed, so no parser-differential trick can displace it, and
 * the document's own doctype stays first (no-quirks parse; an http document
 * with content before its doctype drops to quirks mode, unlike srcdoc).
 *
 * AUTHORIZATION: binding loopback is NOT access control — anything on 127.0.0.1
 * could hit the port. The first path segment is an unguessable per-spawn token
 * (`randomBytes(16)`), the sole authorization boundary.
 *
 * The loader fn, origin-registry hooks, watchdog control, and server-stopped
 * notifier are all constructor seams, so this manager unit-tests with plain
 * fakes and no Electron import; index.ts wires the concrete instances.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { LoggerLike } from '../orchestrator/types';
import {
  ARTIFACT_INTERACTIVE_CSP,
  PROTOTYPE_HTML_RELPATH,
} from '../../../shared/types/artifacts';
import type { HostCommentDocumentResult } from '../../../shared/types/designPrototypeServer';
import { injectAfterLeadingDoctype } from '../ipc/artifactHtml';
import {
  registerScriptedFrameOrigin,
  unregisterScriptedFrameOrigin,
} from '../ipc/artifactFrameGuard';
import { renderDesignInspectorScriptTag } from './designInspectorScript';
import type { FrameWatchdogControl, WatchdogTarget } from './designFrameWatchdog';

/** The prototype path this server serves — the canonical interactive document. */
const SERVED_PATH = `/${PROTOTYPE_HTML_RELPATH}`;

/**
 * Path segment under the token that carries a hosted comment document. Matched
 * by the frame guard too (a comment frame is confined harder than a prototype
 * frame) — see artifactFrameGuard.ts `COMMENT_DOC_PATH_SEGMENT`.
 */
const COMMENT_PATH_SEGMENT = 'comment';

/**
 * The capture serializer injected into the PROTOTYPE document (design-mode.md
 * "Comment mode", invariant 1 — faithful freeze). Entering comment mode must
 * capture the LIVE RENDERED DOM, not a re-render of the source HTML, so the
 * state prototype JS built is what the user comments on. Only code running
 * INSIDE the frame can read that DOM, and the frame is deliberately
 * cross-origin without `allow-same-origin`, so the parent cannot reach in — the
 * capture is therefore a postMessage request this app-owned script answers.
 *
 * The reply is untrusted CONTENT, not a capability: it is sanitized parent-side
 * and re-rendered under a nonce-only CSP where it cannot execute. Prototype JS
 * tampering with its own serialization is self-sabotage of design content, not
 * a boundary breach (spec, explicitly out of scope), so this script does not
 * defend against being overwritten — it only refuses to BREAK: every step is
 * wrapped so a hostile `document` getter cannot take the capture wiring down
 * with it.
 *
 * Injected immediately after the CSP meta and ahead of all prototype markup so
 * the listener is installed before any prototype script can run.
 */
const CAPTURE_SERIALIZER_TAG = `<script>
(function () {
  try {
    window.addEventListener('message', function (event) {
      try {
        var data = event.data;
        if (!data || data.type !== 'cyboflow-design-capture') return;
        if (typeof data.captureId !== 'string') return;
        var source = event.source;
        if (!source || typeof source.postMessage !== 'function') return;
        source.postMessage({
          type: 'cyboflow-design-capture-result',
          captureId: data.captureId,
          html: '<!doctype html>' + document.documentElement.outerHTML
        }, '*');
      } catch (err) {
        /* a broken prototype must not break capture wiring */
      }
    });
  } catch (err) {
    /* ditto */
  }
})();
</script>`;

/** The nonce-only policy a comment document is served under, as a RESPONSE HEADER. */
function commentCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    `script-src 'nonce-${nonce}'`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export interface DesignPrototypeServerManagerOptions {
  /**
   * Load the RAW canonical prototype bytes for a run (no CSP injection) — wraps
   * `loadCanonicalPrototypeHtml(services, runId, 'interactive-prototype')`.
   * A null result (absent / invalid / oversized) is served as a 404.
   */
  loadHtml: (runId: string) => Promise<string | null>;
  /** Watchdog to start on the first live server and stop when the last one goes. */
  watchdog?: FrameWatchdogControl;
  /**
   * Notify the renderer that a server went away OUTSIDE an explicit `stop` call
   * (i.e. via `stopAll` at quit / window close). Fail-soft — a dead window is a
   * no-op. Not called from `stop` (the canvas asked for that teardown itself).
   */
  onServerStopped?: (runId: string) => void;
  /** Register a live server's origin as a scripted artifact-frame identity. */
  registerOrigin?: (origin: string) => void;
  /** Unregister a server's origin on stop. */
  unregisterOrigin?: (origin: string) => void;
  logger?: LoggerLike;
}

/**
 * The CURRENT hosted comment capture for a run. Exactly one is retained per
 * server: a new capture evicts the previous (whose URL then 404s), and server
 * teardown drops it with the entry — a frozen DOM is a moment in time, and
 * keeping stale ones alive would both leak memory and leave dead frames
 * addressable.
 */
interface CommentCapture {
  captureId: string;
  /** The `script-src 'nonce-…'` value, minted fresh per capture. */
  nonce: string;
  /** The exact request path this capture answers. */
  path: string;
  /** Sanitized bytes with the nonce-carrying inspector already injected. */
  html: string;
}

/** One live server's tracked state. */
interface ServerEntry {
  server: Server;
  origin: string;
  baseUrl: string;
  /** The per-spawn authorization token — the first path segment of every URL. */
  token: string;
  /** Open connections, force-destroyed on release so `close()` never hangs. */
  sockets: Set<Socket>;
  /** The run's current comment document, if comment mode has captured one. */
  comment: CommentCapture | null;
}

export class DesignPrototypeServerManager {
  private readonly loadHtml: (runId: string) => Promise<string | null>;
  private readonly watchdog?: FrameWatchdogControl;
  private readonly onServerStopped?: (runId: string) => void;
  private readonly registerOrigin: (origin: string) => void;
  private readonly unregisterOrigin: (origin: string) => void;
  private readonly logger?: LoggerLike;

  private readonly servers = new Map<string, ServerEntry>();
  /** In-flight spawns, so concurrent `ensure`s for one runId share a single server. */
  private readonly pending = new Map<string, Promise<string>>();

  constructor(opts: DesignPrototypeServerManagerOptions) {
    this.loadHtml = opts.loadHtml;
    this.watchdog = opts.watchdog;
    this.onServerStopped = opts.onServerStopped;
    this.registerOrigin = opts.registerOrigin ?? registerScriptedFrameOrigin;
    this.unregisterOrigin = opts.unregisterOrigin ?? unregisterScriptedFrameOrigin;
    this.logger = opts.logger;
  }

  /**
   * Ensure a live server for `runId` and return its tokenized entry URL. Idempotent:
   * a second call while a server is live (or its spawn is in flight) returns the
   * SAME baseUrl.
   */
  async ensure(runId: string): Promise<string> {
    const existing = this.servers.get(runId);
    if (existing) return existing.baseUrl;
    const inFlight = this.pending.get(runId);
    if (inFlight) return inFlight;

    const spawnPromise = this.spawn(runId).finally(() => this.pending.delete(runId));
    this.pending.set(runId, spawnPromise);
    return spawnPromise;
  }

  /**
   * Tear down the run's server (design-mode exit). Idempotent — returns false when
   * no server was running. Does NOT emit `server-stopped` (the caller asked for it).
   */
  async stop(runId: string): Promise<boolean> {
    const entry = this.servers.get(runId);
    if (!entry) return false;
    this.servers.delete(runId);
    await this.releaseEntry(entry);
    this.maybeStopWatchdog();
    this.logger?.debug('[DesignPrototypeServer] stopped', { runId });
    return true;
  }

  /**
   * Tear down EVERY live server (app quit / main-window close). Each server's
   * renderer notification fires via {@link onServerStopped} (fail-soft) because
   * this teardown is out-of-band from the canvas's own `stop`.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.servers.clear();
    for (const [runId, entry] of entries) {
      await this.releaseEntry(entry);
      try {
        this.onServerStopped?.(runId);
      } catch (err) {
        this.logger?.debug('[DesignPrototypeServer] server-stopped notify failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.maybeStopWatchdog();
  }

  /**
   * Host `sanitizedHtml` as the run's CURRENT comment document and return its
   * tokenized URL (design-mode.md "Comment mode — live-DOM freeze + sanitizer +
   * nonce-CSP", invariant 2 — sole-writer channel).
   *
   * The bytes ride the run's EXISTING prototype server, so the comment frame is
   * cross-origin from the shell exactly as the prototype frame is (its own
   * renderer process, same navigation-guard identity). Requires that server to
   * be live — hosting a capture against a stopped/absent server throws rather
   * than silently spawning one, because a capture is only ever produced by a
   * frame that server is already serving.
   *
   * A fresh nonce AND a fresh captureId are minted per call: the nonce because a
   * reused one would let a vector the sanitizer missed in an EARLIER capture
   * carry over, the captureId so the frame's `src` genuinely changes (and the
   * evicted capture's URL stops resolving).
   */
  async hostCommentDocument(runId: string, sanitizedHtml: string): Promise<HostCommentDocumentResult> {
    const entry = this.servers.get(runId);
    if (!entry) {
      throw new Error('No prototype server is running for this run.');
    }
    const captureId = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const path = `/${entry.token}/${COMMENT_PATH_SEGMENT}/${captureId}.html`;
    entry.comment = {
      captureId,
      nonce,
      path,
      // The inspector goes right after the sanitizer's leading doctype (kept
      // first so the frame parses no-quirks — layout fidelity with the live
      // prototype), before any captured markup; under the nonce CSP nothing
      // else in the document can run, so ordering is about the inspector
      // installing its listeners early, not about outracing a competitor.
      html: injectAfterLeadingDoctype(sanitizedHtml, renderDesignInspectorScriptTag(nonce)),
    };
    this.logger?.debug('[DesignPrototypeServer] hosting comment document', { runId, captureId });
    return { url: `${entry.origin}${path}` };
  }

  /** The live (origin, runId) pairs the frame watchdog judges frames against. */
  getTargets(): WatchdogTarget[] {
    return [...this.servers.entries()].map(([runId, entry]) => ({ origin: entry.origin, runId }));
  }

  /** Bind a fresh token-gated loopback server for `runId` and register its origin. */
  private async spawn(runId: string): Promise<string> {
    const token = randomBytes(16).toString('hex');
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      void this.handleRequest(req, res, token, runId);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    const port = await new Promise<number>((resolve, reject) => {
      let settled = false;
      server.on('error', (err) => {
        if (settled) {
          this.logger?.error('[DesignPrototypeServer] server error after listening', {
            runId,
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
          reject(new Error('design prototype server failed to bind a port'));
          return;
        }
        settled = true;
        resolve(address.port);
      });
    });

    const origin = `http://127.0.0.1:${port}`;
    const baseUrl = `${origin}/${token}/${PROTOTYPE_HTML_RELPATH}`;
    this.servers.set(runId, { server, origin, baseUrl, token, sockets, comment: null });
    this.registerOrigin(origin);
    this.watchdog?.start();
    this.logger?.info('[DesignPrototypeServer] listening', { runId, baseUrl });
    return baseUrl;
  }

  /**
   * Serve the single blessed document for a token-matching GET/HEAD; everything
   * else is a bare 404 (or 405 for a disallowed method). Never throws — an
   * unexpected failure answers 500 (or destroys the socket if headers are out).
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    runId: string,
  ): Promise<void> {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendStatus(res, 405, 'Method Not Allowed');
        return;
      }
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';

      // The CURRENT comment capture, if the path addresses it. Only the exact
      // stored path resolves, so an EVICTED (or never-minted) captureId is an
      // indistinguishable 404 like any other stray path.
      const comment = this.servers.get(runId)?.comment ?? null;
      if (comment !== null && rawPath === comment.path) {
        this.sendComment(req, res, comment);
        return;
      }

      // Otherwise the single prototype resource: the path must be EXACTLY
      // `/<token>/prototype/index.html`. No path decoding/normalization is needed
      // — there is nothing else to serve, so anything but the exact string is an
      // indistinguishable 404.
      if (rawPath !== `/${token}${SERVED_PATH}`) {
        this.sendStatus(res, 404, 'Not Found');
        return;
      }

      const raw = await this.loadHtml(runId);
      if (raw === null) {
        // Fail-soft: the canonical bytes are absent/invalid — a 404, so the canvas
        // shows its empty state rather than a wedged frame.
        this.sendStatus(res, 404, 'Not Found');
        return;
      }
      // CSP as a RESPONSE HEADER (undisplaceable by content, doctype stays
      // first → no-quirks parse); the app-owned capture serializer is injected
      // after the doctype, ahead of the untrusted prototype markup. Serializer
      // placement is not security-load-bearing — a prototype byte-trick that
      // moved it would only break that prototype's own capture (self-sabotage).
      const html = injectAfterLeadingDoctype(raw, CAPTURE_SERIALIZER_TAG);
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
    } catch (err) {
      this.logger?.error('[DesignPrototypeServer] request handling failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        this.sendStatus(res, 500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  }

  /**
   * Serve a comment capture under its own nonce-only CSP, delivered as a RESPONSE
   * HEADER rather than a `<meta>`: the document body is untrusted sanitizer output,
   * and a header policy is applied by the browser before a single byte of it is
   * parsed — no prefix/parser-differential trick can displace it.
   */
  private sendComment(req: IncomingMessage, res: ServerResponse, comment: CommentCapture): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': commentCsp(comment.nonce),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(comment.html);
  }

  /** Unregister the origin, then close the server and force-destroy open sockets. */
  private async releaseEntry(entry: ServerEntry): Promise<void> {
    this.unregisterOrigin(entry.origin);
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
      // close() only stops accepting NEW connections; destroy in-flight ones so
      // its callback isn't left waiting on a lingering keep-alive socket.
      for (const socket of entry.sockets) socket.destroy();
    });
  }

  /** Stop the watchdog once no server remains (nothing left to poll). */
  private maybeStopWatchdog(): void {
    if (this.servers.size === 0) this.watchdog?.stop();
  }

  /** Minimal plain-text status response carrying the same safety headers. */
  private sendStatus(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(message);
  }
}
