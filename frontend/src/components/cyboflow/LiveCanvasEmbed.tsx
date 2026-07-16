/**
 * LiveCanvasEmbed — embeds a `ui-prototype` / `generic` artifact's body. It is
 * DUAL-PATH, keyed by which prop the caller passes:
 *
 *   - `{ html }`  → a self-contained STATIC mockup (Approach C). Rendered via
 *     `<iframe srcDoc={html}>` with a BARE `sandbox=""` (NO `allow-scripts`, NO
 *     `allow-same-origin` → opaque origin, no script execution, no parent/preload
 *     reach) plus the shared `ARTIFACT_PROTOTYPE_CSP` as the iframe `csp`
 *     attribute and `referrerPolicy="no-referrer"`. The same CSP is spliced into
 *     the document as a `<head>` `<meta>` by the main `artifacts:load-html`
 *     handler — belt-and-braces so a stripped attribute alone can't loosen it.
 *     No toolbar, no "server may be down" footer (there is no server).
 *
 *   - `{ url; interactive }` → a LEGACY localhost dev-server live canvas.
 *     Only localhost hostnames are embedded (the agent runs the dev server in the
 *     run's worktree and reports its URL via cyboflow_report_artifact; the app
 *     does NOT orchestrate the server). A non-local URL is refused with a notice.
 *     The iframe uses `sandbox="allow-scripts allow-same-origin"`: a live
 *     prototype is a real app and needs its own scripts. This is safe ONLY
 *     because the dev server (e.g. localhost:8081) is a DIFFERENT ORIGIN from the
 *     cyboflow shell (different port in dev, file:// in prod), so the frame is
 *     cross-origin and cannot reach `window.parent` or rewrite its own sandbox;
 *     top-navigation/popups are NOT granted. To keep that guarantee true even for
 *     an attacker-supplied URL, `isLocalhostUrl` explicitly REJECTS the shell's
 *     own origin (host + port) — see its doc — so a payload of e.g.
 *     `http://localhost:4521` (the dev shell origin) can never render same-origin.
 *     Cross-origin load failures (server down) cannot be detected reliably from
 *     the parent, so we surface a manual Reload + "Open in browser" + a hint
 *     rather than a synthetic error state. Reload re-keys the iframe.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { ARTIFACT_PROTOTYPE_CSP } from '../../../../shared/types/artifacts';

// The `csp` iframe attribute (Content Security Policy for an embedded document)
// is not in React's built-in IframeHTMLAttributes; augment it in locally so the
// html-branch iframe can set it without a cast / `any`.
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- augments the built-in generic
  interface IframeHTMLAttributes<T> {
    csp?: string;
  }
}

const HAIRLINE = 'var(--color-border-primary)';
const RAIL = 'var(--color-bg-secondary)';
const PAGE = 'var(--color-bg-primary)';
const INK = 'var(--color-text-primary)';
const MUTED = 'var(--color-text-secondary)';
const FAINT = 'var(--color-text-tertiary)';
const RUST = 'var(--color-interactive-primary)';

// Embeddable local hosts. `0.0.0.0` and the unspecified-address `::`/`[::]`
// are deliberately EXCLUDED: they are bind-all sentinels, not real loopback
// hosts, and a frame served from them is not reliably cross-origin from the
// shell, so they must not be treated as embeddable.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True for an http(s) URL pointing at a local host (the only embeddable kind).
 *
 * The iframe is rendered `sandbox="allow-scripts allow-same-origin …"`, whose
 * sole isolation guarantee is that the embedded dev server is a DIFFERENT ORIGIN
 * (host + port) than the cyboflow shell. We therefore reject any URL whose origin
 * equals the shell's own origin — in dev the shell runs at e.g.
 * `http://localhost:4521`, so a payload of `http://localhost:4521` would render
 * same-origin and could reach `window.parent` / preload IPC. Comparing the full
 * origin (incl. port) against `window.location.origin` closes that escape.
 */
export function isLocalhostUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!LOCAL_HOSTS.has(u.hostname)) return false;
    // Refuse the shell's own origin: a same-origin frame escapes the sandbox.
    if (typeof window !== 'undefined' && u.origin === window.location?.origin) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Discriminated union: pass EITHER a static `html` document (srcDoc, bare
 * sandbox) OR a legacy live-canvas `url` (cross-origin dev-server embed). The
 * `interactive: true` tag on the url variant makes the two arms unambiguous.
 */
export type LiveCanvasEmbedProps = { html: string } | { url: string; interactive: true };

export function LiveCanvasEmbed(props: LiveCanvasEmbedProps): ReactElement {
  // Static-mockup branch — srcDoc + BARE sandbox (no scripts, no same-origin).
  if ('html' in props) {
    return (
      <div data-testid="live-canvas-embed" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <iframe
          data-testid="live-canvas-iframe"
          srcDoc={props.html}
          title="UI prototype static mockup"
          // SECURITY-CRITICAL: bare sandbox — NO allow-scripts, NO allow-same-origin.
          // The document renders at an opaque origin with scripts disabled; it can
          // neither run JS nor reach window.parent / preload IPC.
          sandbox=""
          csp={ARTIFACT_PROTOTYPE_CSP}
          referrerPolicy="no-referrer"
          style={{ flex: 1, width: '100%', border: 'none', background: 'var(--color-surface-primary)', minHeight: 0 }}
        />
      </div>
    );
  }

  return <LiveCanvasUrlEmbed url={props.url} />;
}

/** Legacy live-canvas (localhost dev-server) embed — unchanged behavior. */
function LiveCanvasUrlEmbed({ url }: { url: string }): ReactElement {
  const [reloadKey, setReloadKey] = useState(0);

  // Pause the embedded prototype while the window is hidden/minimized. Agent-built
  // prototypes commonly ship `animation: … infinite` CSS, and Electron ships with
  // MacWebContentsOcclusion disabled — so a hidden Cyboflow window keeps painting
  // the iframe at full speed, an invisible renderer/GPU CPU burn. Swapping the
  // frame to about:blank unloads the page (stopping its timers/rAF/animations);
  // the live URL is restored (a fresh fetch) on re-show. Cross-origin isolation
  // means we cannot reach into the frame to pause it any other way. Visibility is
  // the deliberately conservative signal: a visible-but-unfocused prototype in a
  // side window keeps rendering (we do NOT pause on window blur).
  const [documentHidden, setDocumentHidden] = useState<boolean>(
    typeof document !== 'undefined' && document.hidden,
  );
  useEffect(() => {
    const onVisibility = (): void => setDocumentHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (!isLocalhostUrl(url)) {
    return (
      <div
        data-testid="live-canvas-blocked"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 32,
          textAlign: 'center',
          background:
            'repeating-linear-gradient(135deg,var(--color-bg-tertiary) 0 10px,var(--color-bg-primary) 10px 20px)',
        }}
      >
        <span style={{ fontSize: '28px', color: RUST }}>◳</span>
        <span style={{ fontSize: '12px', fontWeight: 600, color: INK }}>Preview not embeddable</span>
        <span style={{ fontSize: '10.5px', color: MUTED, maxWidth: 360, lineHeight: 1.5 }}>
          Only local dev-server previews are embedded. This artifact&apos;s URL
          {url ? ` (${url})` : ''} is not a localhost address.
        </span>
      </div>
    );
  }

  return (
    <div data-testid="live-canvas-embed" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Toolbar */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '5px 12px',
          background: RAIL,
          borderBottom: `1px solid ${HAIRLINE}`,
          fontSize: '10px',
          color: FAINT,
        }}
      >
        <span style={{ color: MUTED }}>Live preview · {url}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="live-canvas-reload"
          onClick={() => setReloadKey((k) => k + 1)}
          style={{
            font: 'inherit',
            fontSize: '10px',
            fontWeight: 700,
            color: INK,
            background: PAGE,
            border: `1px solid ${HAIRLINE}`,
            borderRadius: 3,
            padding: '3px 10px',
            cursor: 'pointer',
          }}
        >
          ↻ Reload
        </button>
        <a
          data-testid="live-canvas-open"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '10px',
            fontWeight: 700,
            color: INK,
            background: PAGE,
            border: `1px solid ${HAIRLINE}`,
            borderRadius: 3,
            padding: '3px 10px',
            textDecoration: 'none',
          }}
        >
          Open in browser ↗
        </a>
      </div>
      <iframe
        key={reloadKey}
        data-testid="live-canvas-iframe"
        src={documentHidden ? 'about:blank' : url}
        title="UI prototype live preview"
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{ flex: 1, width: '100%', border: 'none', background: 'var(--color-surface-primary)', minHeight: 0 }}
      />
      <div
        style={{
          flexShrink: 0,
          padding: '4px 12px',
          fontSize: '9px',
          color: FAINT,
          background: RAIL,
          borderTop: `1px dashed ${HAIRLINE}`,
        }}
      >
        If the preview is blank, the dev server may not be running — reload after starting it.
      </div>
    </div>
  );
}
