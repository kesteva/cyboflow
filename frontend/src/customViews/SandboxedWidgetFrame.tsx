/**
 * SandboxedWidgetFrame — the tier-3 host: an author's HTML+JS running in a
 * cross-origin, script-only sandbox (docs/proposals/CUSTOM-VIEWS.md §5.4).
 *
 * The document is NOT `srcdoc`. It is served by the loopback widget document
 * server (`main/src/services/customWidgetServer.ts`) at
 * `<baseUrl>/widget/<id>/<revision>` — `<baseUrl>/widget-draft/...` for the
 * authoring slot — because an `about:srcdoc` frame is governed by
 * `shouldBlockArtifactFrameNavigation`, which offers a blocked `http(s)` target
 * to `shell.openExternal`; for a script-enabled frame that is an exfiltration
 * channel. The loopback origin is registered as a scripted frame instead, whose
 * guard blocks off-origin navigation with no external open.
 *
 * ## Two deliberate deviations from the plan's sketch, both forced by `sandbox`
 *
 * The plan says to `postMessage(msg, serverOrigin)` outbound and to accept
 * inbound only when `event.origin === serverOrigin`. Neither is expressible
 * against THIS frame, and the reason is the isolation itself: a `sandbox`
 * attribute WITHOUT `allow-same-origin` forces an opaque origin regardless of
 * the document's URL (§10 pins that the frame has no `allow-same-origin`). So:
 *
 *   - Inbound, `event.origin` is the string `'null'`, never the server origin.
 *     The check that actually carries the security here is
 *     `event.source === iframe.contentWindow` — a window identity no other
 *     frame can forge, unlike an origin string. We keep the origin check as a
 *     narrowing allowlist (`'null'` or the server origin) so a message from a
 *     DIFFERENT origin is still refused, and pin it in tests.
 *   - Outbound, a targeted `postMessage` to the server origin would be silently
 *     dropped by the browser (target origin never matches an opaque one), which
 *     is a functional break, not a hardening. We target `'*'` at a window we
 *     created, whose document we serve, and whose navigation the scripted-frame
 *     guard pins to our origin — so `'*'` cannot reach a third party.
 *
 * Reported to the parent session as an S4 deviation; if the guarantee must be
 * origin-based, tier 3 needs `allow-same-origin` plus a same-origin-frame
 * policy, which is a bigger change than a renderer stage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import {
  WIDGET_ACT_MESSAGE,
  WIDGET_DATA_MESSAGE,
  WIDGET_RESIZE_MESSAGE,
} from '../../../shared/customViews/widgetDocument';
import { WIDGET_THEME_TOKENS } from '../../../shared/customViews/theme';
import type { Scalar, SourceResult } from '../../../shared/types/customViews';

/** Frame height clamp, in px (§5.4 — the frame cannot grow the page unbounded). */
export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 1200;

export interface SandboxedWidgetFrameProps {
  widgetId: string;
  revision: number;
  /** Serve the DRAFT document instead of the published one (the authoring slot). */
  draft?: boolean;
  /** The data pushed into the frame on load and on every refresh. */
  sources: Record<string, SourceResult>;
  settings: Record<string, Scalar>;
  context: { projectId: number | null };
  /** A frame-originated `cyboflow.act()` request. ALWAYS confirmed upstream. */
  onAct: (actionId: string, rowKeyValue: Scalar) => void;
}

/**
 * Whether an inbound frame message may be trusted. Exported so the rule is
 * tested directly rather than inferred from a rendered frame.
 */
export function isTrustedFrameMessage(
  event: Pick<MessageEvent, 'source' | 'origin'>,
  frameWindow: Window | null,
  serverOrigin: string | null,
): boolean {
  if (frameWindow === null) return false;
  if (event.source !== frameWindow) return false;
  // An `allow-scripts`-only sandbox posts from an opaque origin ('null').
  return event.origin === 'null' || (serverOrigin !== null && event.origin === serverOrigin);
}

/** SandboxedWidgetFrame — see {@link SandboxedWidgetFrameProps}. */
export function SandboxedWidgetFrame({
  widgetId,
  revision,
  draft = false,
  sources,
  settings,
  context,
  onAct,
}: SandboxedWidgetFrameProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [server, setServer] = useState<{ baseUrl: string; origin: string } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT * 2);

  // The latest payload, so the load handler can push without re-binding.
  const payloadRef = useRef({ sources, settings, context });
  payloadRef.current = { sources, settings, context };

  const push = useCallback((): void => {
    const frameWindow = iframeRef.current?.contentWindow ?? null;
    if (frameWindow === null) return;
    frameWindow.postMessage(
      {
        type: WIDGET_DATA_MESSAGE,
        payload: { ...payloadRef.current, theme: WIDGET_THEME_TOKENS },
      },
      // See the module header: an opaque-origin frame cannot be targeted by
      // origin, and this window is one we created and serve.
      '*',
    );
  }, []);

  // Spin the loopback server up (idempotent — one process-global instance).
  useEffect(() => {
    let cancelled = false;
    trpc.cyboflow.customWidgetServer.ensure
      .mutate()
      .then((live) => {
        if (!cancelled) setServer(live);
      })
      .catch((err: unknown) => {
        if (!cancelled) setServerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Push on every data change (the load handler covers the first paint).
  useEffect(() => {
    push();
  }, [push, sources, settings, context]);

  // Frame -> parent. Source identity is the load-bearing check.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frameWindow = iframeRef.current?.contentWindow ?? null;
      if (!isTrustedFrameMessage(event, frameWindow, server?.origin ?? null)) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as { type?: unknown; height?: unknown; actionId?: unknown; rowKeyValue?: unknown };

      if (message.type === WIDGET_RESIZE_MESSAGE && typeof message.height === 'number') {
        setHeight(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, message.height)));
        return;
      }
      if (message.type === WIDGET_ACT_MESSAGE && typeof message.actionId === 'string') {
        const rowKeyValue = message.rowKeyValue;
        onAct(
          message.actionId,
          typeof rowKeyValue === 'string' || typeof rowKeyValue === 'number' || typeof rowKeyValue === 'boolean'
            ? rowKeyValue
            : null,
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onAct, server?.origin]);

  if (serverError !== null) {
    return (
      <div
        data-testid="widget-frame-unavailable"
        className="border border-dashed border-border-primary bg-surface-raised px-[18px] py-3.5 text-center text-[11px] text-text-tertiary"
      >
        Widget document server unavailable: {serverError}
      </div>
    );
  }
  if (server === null) {
    return <div data-testid="widget-frame-loading" className="h-20 animate-pulse bg-surface-sunken" />;
  }

  const path = draft ? 'widget-draft' : 'widget';
  return (
    <iframe
      ref={iframeRef}
      data-testid="widget-sandbox-frame"
      title="Custom widget"
      src={`${server.baseUrl}/${path}/${widgetId}/${revision}`}
      sandbox="allow-scripts"
      onLoad={push}
      style={{ height: `${height}px` }}
      className="w-full border border-border-primary bg-surface-raised"
    />
  );
}
