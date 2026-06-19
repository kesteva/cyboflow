/**
 * LiveCanvasEmbed — embeds an agent-supplied localhost dev-server URL (the
 * ui-prototype / generic live-canvas artifact) in a sandboxed iframe.
 *
 * Security: only localhost hostnames are embedded (the agent runs the dev server
 * in the run's worktree and reports its URL via cyboflow_report_artifact; the app
 * does NOT orchestrate the server). A non-local URL is refused with a notice.
 *
 * The iframe uses `sandbox="allow-scripts allow-same-origin"`: a live prototype is
 * a real app and needs its own scripts. This is safe here because the dev server
 * (e.g. localhost:8081) is a DIFFERENT ORIGIN from the cyboflow shell (different
 * port in dev, file:// in prod), so the frame is cross-origin and cannot reach
 * `window.parent` or rewrite its own sandbox; top-navigation/popups are NOT
 * granted. The frame is isolated to its own origin.
 *
 * Cross-origin load failures (server down) cannot be detected reliably from the
 * parent, so we surface a manual Reload + "Open in browser" + a hint rather than
 * a synthetic error state. Reload re-keys the iframe to force a fresh fetch.
 */
import { useState, type ReactElement } from 'react';

const HAIRLINE = '#d8cfb8';
const RAIL = '#ebe4d2';
const PAGE = '#f5f1e8';
const INK = '#1a1815';
const MUTED = '#6a5e44';
const FAINT = '#9c8e6c';
const RUST = '#c96442';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** True for an http(s) URL pointing at a local host (the only embeddable kind). */
export function isLocalhostUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function LiveCanvasEmbed({ url }: { url: string }): ReactElement {
  const [reloadKey, setReloadKey] = useState(0);

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
          background: 'repeating-linear-gradient(135deg,#efeadc 0 10px,#f5f1e8 10px 20px)',
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
        src={url}
        title="UI prototype live preview"
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{ flex: 1, width: '100%', border: 'none', background: '#fff', minHeight: 0 }}
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
