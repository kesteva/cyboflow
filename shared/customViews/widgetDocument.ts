/**
 * Tier-3 widget document builder (docs/proposals/CUSTOM-VIEWS.md §5.4). Turns
 * a `render.type === 'html'` `WidgetSpec` into the full HTML document served
 * by `main/src/services/customWidgetServer.ts` inside a sandboxed,
 * cross-origin `<iframe>`.
 *
 * The interactive CSP (`ARTIFACT_INTERACTIVE_CSP`) is repeated here as a
 * `<meta>` tag; the server ALSO sends it as a response header (the
 * authoritative half — a header applies before any byte is parsed). The
 * prelude script is a static, non-interpolated string: it defines the
 * `window.cyboflow` bridge and never touches the author's HTML or any
 * caller-supplied value, so there is no template-literal interpolation of
 * untrusted input anywhere in this module.
 *
 * Keep this file free of Node.js built-ins so it can run in either process.
 */

import { ARTIFACT_INTERACTIVE_CSP } from '../types/artifacts';
import type { Scalar, SourceResult, WidgetSpec } from '../types/customViews';

// ---------------------------------------------------------------------------
// postMessage contract (parent <-> tier-3 frame)
// ---------------------------------------------------------------------------

export const WIDGET_DATA_MESSAGE = 'cyboflow-widget-data';
export const WIDGET_ACT_MESSAGE = 'cyboflow-widget-act';
export const WIDGET_RESIZE_MESSAGE = 'cyboflow-widget-resize';

/** Parent -> frame: pushed on mount and every refresh via `window.cyboflow.onData`. */
export interface WidgetDataMessage {
  type: typeof WIDGET_DATA_MESSAGE;
  payload: {
    sources: Record<string, SourceResult>;
    settings: Record<string, Scalar>;
    context: { projectId: number | null };
    theme: Record<string, string>;
  };
}

/** Frame -> parent: a REQUEST only — the parent always confirms before executing (§4.4). */
export interface WidgetActMessage {
  type: typeof WIDGET_ACT_MESSAGE;
  actionId: string;
  rowKeyValue: Scalar | null;
}

/** Frame -> parent: the frame's content height, so the parent can clamp/resize its container. */
export interface WidgetResizeMessage {
  type: typeof WIDGET_RESIZE_MESSAGE;
  height: number;
}

// ---------------------------------------------------------------------------
// Prelude script — STATIC, no interpolation of any kind
// ---------------------------------------------------------------------------

/**
 * Defines `window.cyboflow`. Plain ES2018, no template-literal
 * interpolation — this string is fixed regardless of the widget spec, the
 * theme, or any other input, so it cannot become an injection vector.
 */
const WIDGET_PRELUDE_SCRIPT = `
(function () {
  var callbacks = [];
  var latestTheme = null;

  function resize() {
    try {
      window.parent.postMessage(
        { type: 'cyboflow-widget-resize', height: document.documentElement.scrollHeight },
        '*'
      );
    } catch (err) {
      // Cross-origin postMessage failures are swallowed — the parent simply
      // never sees a resize for this frame.
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'cyboflow-widget-data') return;
    if (data.payload && data.payload.theme) latestTheme = data.payload.theme;
    for (var i = 0; i < callbacks.length; i++) {
      try {
        callbacks[i](data.payload);
      } catch (err) {
        // A widget author's callback throwing must not break the bridge.
      }
    }
    resize();
  });

  window.addEventListener('load', resize);

  window.cyboflow = Object.freeze({
    onData: function (cb) {
      callbacks.push(cb);
    },
    act: function (actionId, rowKeyValue) {
      window.parent.postMessage(
        {
          type: 'cyboflow-widget-act',
          actionId: String(actionId),
          rowKeyValue: rowKeyValue === undefined ? null : rowKeyValue,
        },
        '*'
      );
    },
    resize: resize,
    get theme() {
      return latestTheme;
    },
  });
})();
`.trim();

// ---------------------------------------------------------------------------
// buildWidgetDocument
// ---------------------------------------------------------------------------

/**
 * Builds the full HTML document for a tier-3 (`render.type === 'html'`)
 * widget. Throws for any other render type — those never go through the
 * widget document server.
 */
export function buildWidgetDocument(spec: WidgetSpec, opts: { theme: Record<string, string> }): string {
  if (spec.render.type !== 'html') {
    throw new Error(`buildWidgetDocument only supports render.type "html" (got "${spec.render.type}")`);
  }

  const themeVars = Object.entries(opts.theme)
    .map(([token, value]) => `--${token}:${value};`)
    .join('');

  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_INTERACTIVE_CSP}">` +
    `<style>:root{${themeVars}}html,body{margin:0;background:transparent;color:var(--ink,#1a1815);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px}</style>` +
    `<script>${WIDGET_PRELUDE_SCRIPT}</script>` +
    '</head><body>' +
    spec.render.html +
    '</body></html>'
  );
}
