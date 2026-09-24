/**
 * WebViewTab — the center-pane body for a `web` tab.
 *
 * The page itself is NOT rendered here. It is a main-process `WebContentsView`
 * composited OVER this component's bounds-anchor rect, because every target the
 * viewer exists for refuses to be framed (measured 2026-09-23: claude.ai and
 * docs.anthropic.com send `x-frame-options: SAMEORIGIN`, github.com sends
 * `deny`) and the packaged renderer CSP's `frame-src` would block an iframe in
 * shipped builds while `pnpm dev` looked fine. See
 * docs/proposals/native-web-viewer.md.
 *
 * At THIS commit the native view does not exist yet, so the body renders the
 * anchor plus the tab's URL and an escape to the OS browser — the tab opens,
 * closes and styles correctly, and nothing is broken while the manager lands in
 * the next commit.
 */
import type { ReactElement } from 'react';
import { ExternalLink } from 'lucide-react';
import type { TabItem } from '../../../../shared/types/centerPane';

export interface WebViewTabProps {
  tab: TabItem;
}

export function WebViewTab({ tab }: WebViewTabProps): ReactElement {
  const url = tab.currentUrl ?? tab.initialUrl ?? '';

  return (
    <div
      data-testid="web-view-tab"
      className="flex h-full w-full flex-col overflow-hidden bg-surface-primary"
    >
      <div className="flex items-center gap-2 border-b border-border-primary px-3 py-2">
        <span className="truncate font-mono text-xs text-text-secondary" title={url}>
          {url}
        </span>
        <div className="flex-1" />
        {tab.openedBy === 'agent' && (
          <span
            data-testid="web-view-tab-agent-badge"
            className="shrink-0 rounded-button border border-border-primary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary"
          >
            opened by agent
          </span>
        )}
        <button
          type="button"
          data-testid="web-view-tab-open-external"
          onClick={() => void window.electronAPI?.openExternal(url)}
          className="inline-flex shrink-0 items-center gap-1 rounded-button border border-border-primary px-2 py-1 text-xs text-text-secondary hover:border-border-emphasized hover:text-text-primary"
          title="Open in your browser"
        >
          <ExternalLink className="h-3 w-3" />
          Browser
        </button>
      </div>
      {/*
        The bounds anchor. The native view is positioned over THIS rect (its
        getBoundingClientRect, scaled by the window's zoom factor in main), so it
        must stay a plain, un-transformed block that fills the remaining space.
      */}
      <div data-testid="web-view-tab-anchor" data-web-tab-id={tab.id} className="relative flex-1" />
    </div>
  );
}
