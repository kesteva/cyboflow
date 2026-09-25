/**
 * WebViewTab — the center-pane body for a `web` tab: minimal chrome over a
 * bounds anchor.
 *
 * The page itself is NOT in this tree. It is a main-process `WebContentsView`
 * composited OVER the anchor rect, because every target the viewer exists for
 * refuses to be framed (measured 2026-09-23: claude.ai and docs.anthropic.com
 * send `x-frame-options: SAMEORIGIN`, github.com sends `deny`) and the packaged
 * renderer CSP's `frame-src` would break an iframe viewer in shipped builds only
 * — the exact dev/packaged asymmetry that dogfooding misses.
 *
 * Chrome is deliberately minimal: back / forward / reload / URL / open-in-OS-
 * browser. No favicon — the strip is text glyphs by design, and the packaged
 * CSP's `img-src` would block a remote one.
 *
 * See docs/proposals/native-web-viewer.md §3.6.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, Shield, ShieldAlert } from 'lucide-react';
import type { TabItem } from '../../../../shared/types/centerPane';
import type { WebTabSnapshot } from '../../../../shared/types/webViewer';
import { useWebViewBounds } from '../../hooks/useWebViewBounds';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { useShallow } from 'zustand/react/shallow';
import { trpc } from '../../trpc/client';
import { selectTabConsents, useWebConsentStore } from '../../stores/webConsentStore';
import { WebConsentSheet } from './WebConsentSheet';
import { WebAccessModal } from './WebAccessModal';

export interface WebViewTabProps {
  tab: TabItem;
  /** The centerPaneStore key — the run's parent session. */
  sessionKey: string;
  /** Whether this tab is the active one (drives visibility of the native view). */
  active: boolean;
}

export function WebViewTab({ tab, sessionKey, active }: WebViewTabProps): ReactElement {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<WebTabSnapshot | null>(null);
  const updateWebTab = useCenterPaneStore((s) => s.updateWebTab);
  // useShallow: an unrelated tab's prompt does not re-render this one.
  const consents = useWebConsentStore(useShallow(selectTabConsents(tab.id)));
  const [accessOpen, setAccessOpen] = useState(false);

  useWebViewBounds({ tabId: tab.id, anchorRef, active });

  // Seed from main, then stay live. The snapshot is the authority for
  // canGoBack/canGoForward/state; the store keeps the strip's label and URL.
  useEffect(() => {
    let cancelled = false;
    void trpc.cyboflow.webViewer.get
      .query({ tabId: tab.id })
      .then((next) => {
        if (!cancelled && next) setSnapshot(next);
      })
      .catch(() => {
        /* the tab may not exist in main yet */
      });
    return () => {
      cancelled = true;
    };
  }, [tab.id]);

  useEffect(() => {
    const sub = trpc.cyboflow.webViewer.onTabState.subscribe(
      { sessionId: sessionKey },
      {
        onData: (ev) => {
          if (ev.snapshot.tabId !== tab.id) return;
          setSnapshot(ev.snapshot);
          updateWebTab(sessionKey, tab.id, {
            currentUrl: ev.snapshot.currentUrl ?? undefined,
            label: ev.snapshot.title ?? undefined,
            humanTouched: ev.snapshot.humanTouched,
          });
        },
        onError: (err: unknown) => console.warn('[WebViewTab] onTabState error:', err),
      },
    );
    return () => sub.unsubscribe();
  }, [sessionKey, tab.id, updateWebTab]);

  const url = snapshot?.currentUrl ?? tab.currentUrl ?? tab.initialUrl ?? '';
  const state = snapshot?.state ?? 'hidden';
  const blocked =
    state === 'crashed' || state === 'auth_required' || state === 'certificate_error';

  const go = useCallback(
    (verb: 'back' | 'forward' | 'reload') => {
      void trpc.cyboflow.webViewer[verb].mutate({ tabId: tab.id }).catch(() => {
        /* nothing useful to show for a refused history step */
      });
    },
    [tab.id],
  );

  return (
    <div
      data-testid="web-view-tab"
      className="flex h-full w-full flex-col overflow-hidden bg-surface-primary"
    >
      <div className="flex items-center gap-1.5 border-b border-border-primary px-2 py-1.5">
        <button
          type="button"
          aria-label="Back"
          data-testid="web-view-tab-back"
          disabled={snapshot?.canGoBack !== true}
          onClick={() => go('back')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-button text-text-secondary hover:bg-surface-hover disabled:opacity-30"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          data-testid="web-view-tab-forward"
          disabled={snapshot?.canGoForward !== true}
          onClick={() => go('forward')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-button text-text-secondary hover:bg-surface-hover disabled:opacity-30"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Reload"
          data-testid="web-view-tab-reload"
          onClick={() => go('reload')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-button text-text-secondary hover:bg-surface-hover"
        >
          <RotateCw className={`h-3.5 w-3.5 ${snapshot?.loading === true ? 'animate-spin' : ''}`} />
        </button>
        <span
          data-testid="web-view-tab-url"
          className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
          title={url}
        >
          {url}
        </span>
        {tab.openedBy === 'agent' && (
          <span
            data-testid="web-view-tab-agent-badge"
            className="shrink-0 rounded-button border border-border-primary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary"
          >
            agent
          </span>
        )}
        <button
          type="button"
          aria-label="Agent access"
          title="Agent access"
          data-testid="web-view-tab-access"
          onClick={() => setAccessOpen(true)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-button text-text-secondary hover:bg-surface-hover"
        >
          <Shield className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Open in your browser"
          data-testid="web-view-tab-open-external"
          onClick={() => void window.electronAPI?.openExternal(url)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-button text-text-secondary hover:bg-surface-hover"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      {/*
        The bounds anchor. The native view is positioned over THIS rect (its
        getBoundingClientRect, scaled by the window's zoom factor in main), so it
        must stay a plain, un-transformed block filling the remaining space.
      */}
      <div data-testid="web-view-tab-anchor" data-web-tab-id={tab.id} ref={anchorRef} className="relative flex-1">
        {/*
          Blocked states render IN the anchor, which is safe because a blocked tab
          has no page painting over it. Both auth and TLS fail closed and are a
          human's to resolve — never something a drive grant can unlock.
        */}
        {/*
          A pending agent request covers the tab. The sheet takes an occlusion
          lease, so the native page is hidden while the human decides — it would
          otherwise paint over the sheet.
        */}
        {consents.length > 0 && <WebConsentSheet request={consents[0]} />}
        {blocked && (
          <div
            data-testid="web-view-tab-blocked"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-primary px-6 text-center"
          >
            <ShieldAlert className="h-6 w-6 text-status-warning" />
            <p className="text-sm font-medium text-text-primary">
              {state === 'crashed'
                ? 'This page crashed.'
                : state === 'auth_required'
                  ? 'This page asked for a username and password.'
                  : 'This site’s certificate could not be verified.'}
            </p>
            {snapshot?.blockedReason && (
              <p className="max-w-md break-words font-mono text-xs text-text-tertiary">
                {snapshot.blockedReason}
              </p>
            )}
            <div className="mt-1 flex items-center gap-2">
              {state === 'crashed' && (
                <button
                  type="button"
                  data-testid="web-view-tab-recover"
                  onClick={() => go('reload')}
                  className="rounded-button border border-border-primary px-2 py-1 text-xs text-text-secondary hover:border-border-emphasized hover:text-text-primary"
                >
                  Reload
                </button>
              )}
              <button
                type="button"
                onClick={() => void window.electronAPI?.openExternal(url)}
                className="rounded-button border border-border-primary px-2 py-1 text-xs text-text-secondary hover:border-border-emphasized hover:text-text-primary"
              >
                Open in your browser
              </button>
            </div>
          </div>
        )}
      </div>
      <WebAccessModal
        isOpen={accessOpen}
        onClose={() => setAccessOpen(false)}
        sessionKey={sessionKey}
        tabId={tab.id}
      />
    </div>
  );
}

