/**
 * webViewerPersistence — the web viewer's DB side: tab rows, restore, audit.
 *
 * Wraps the manager (which owns views and knows nothing about SQLite) and the
 * repository (which owns SQL and knows nothing about views). The router sees
 * this, not the bare manager, so every renderer open/close is persisted and
 * audited by construction rather than by each caller remembering to.
 *
 * What is persisted, and when:
 *   - a tab row on a successful open (never for a restore — the row exists),
 *     deleted on an explicit close and on session teardown;
 *   - `current_url` / `title` whenever the manager reports a change;
 *   - `human_touched` the moment it latches.
 * A quit (`disposeAll`) and an eviction deliberately KEEP the rows: those tabs
 * come back on the next launch.
 *
 * The audit trail records opens, closes, evictions, crashes, the human-touch
 * latch and teardown, with the REDACTED origin only — never a full URL, whose
 * path and query are where credentials and tokens live.
 *
 * Every write is best-effort: a failed write logs and the viewer keeps working.
 * Persistence must never be the reason a page does not open.
 *
 * See docs/proposals/native-web-viewer.md §5.
 */
import type { RestoredWebTab, WebTabSnapshot } from '../../../../shared/types/webViewer';
import type {
  WebViewerAck,
  WebViewerLike,
  WebViewerOpenArgs,
  WebViewerOpenResult,
} from '../../orchestrator/trpc/contracts/webViewerOps';
import type { WebEventInput, WebTabsRepository } from '../../database/webTabsRepository';
import { redactToOrigin } from './webViewerGuard';
import {
  WEB_VIEWER_HUMAN_TOUCH,
  WEB_VIEWER_TAB_CLOSED,
  WEB_VIEWER_TAB_STATE,
  type WebViewerManager,
} from './webViewerManager';

type ManagerLike = Pick<
  WebViewerManager,
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'close'
  | 'setBounds'
  | 'setVisible'
  | 'list'
  | 'get'
  | 'disposeSession'
  | 'tabIdsForSession'
  | 'on'
>;

type RepoLike = Pick<
  WebTabsRepository,
  'insertTab' | 'updateTab' | 'listTabs' | 'deleteTab' | 'deleteTabsForSession' | 'appendEvent'
>;

export class PersistingWebViewer implements WebViewerLike {
  /** Last persisted (url, title) per tab, so a loading toggle writes nothing. */
  private readonly persisted = new Map<string, { url: string | null; title: string | null }>();
  /** Last reported state per tab, to audit TRANSITIONS into 'evicted'. */
  private readonly lastState = new Map<string, string>();

  constructor(
    private readonly manager: ManagerLike,
    private readonly repo: RepoLike,
  ) {
    manager.on(WEB_VIEWER_TAB_STATE, (ev: { sessionId: string; snapshot: WebTabSnapshot }) =>
      this.onTabState(ev.snapshot),
    );
    manager.on(WEB_VIEWER_HUMAN_TOUCH, (ev: { sessionId: string; tabId: string }) => {
      this.safely(() => this.repo.updateTab(ev.tabId, { humanTouched: true }));
      this.audit({ sessionId: ev.sessionId, tabId: ev.tabId, kind: 'human_touched' });
    });
    manager.on(
      WEB_VIEWER_TAB_CLOSED,
      (ev: { sessionId: string; tabId: string; reason: string }) => {
        if (ev.reason === 'crashed') {
          this.audit({ sessionId: ev.sessionId, tabId: ev.tabId, kind: 'tab_crashed' });
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // Persisted lifecycle
  // -------------------------------------------------------------------------

  async open(args: WebViewerOpenArgs): Promise<WebViewerOpenResult> {
    const result = await this.manager.open(args);
    if (!result.ok || args.restore) return result;
    const snap = result.snapshot;
    this.safely(() =>
      this.repo.insertTab({
        id: args.tabId,
        sessionId: args.sessionId,
        initialUrl: snap.currentUrl ?? args.url,
        currentUrl: snap.currentUrl,
        openedBy: args.openedBy,
        openedByRunId: args.openedByRunId ?? null,
      }),
    );
    this.persisted.set(args.tabId, { url: snap.currentUrl, title: snap.title });
    this.audit({
      sessionId: args.sessionId,
      tabId: args.tabId,
      runId: args.openedByRunId ?? null,
      kind: 'tab_opened',
      origin: redactToOrigin(snap.currentUrl),
      detail: args.openedBy,
    });
    return result;
  }

  async close(tabId: string): Promise<WebViewerAck> {
    const before = await this.manager.get(tabId);
    const result = await this.manager.close(tabId);
    if (!result.ok) return result;
    this.safely(() => this.repo.deleteTab(tabId));
    this.forget(tabId);
    if (before) {
      this.audit({
        sessionId: before.sessionId,
        tabId,
        kind: 'tab_closed',
        origin: redactToOrigin(before.currentUrl),
      });
    }
    return result;
  }

  /**
   * Re-create a session's persisted tabs UNLOADED, reusing their ids, and return
   * them in strip order. Idempotent: a tab the manager already holds (a renderer
   * remount within one launch) is returned without being re-opened.
   */
  async restore(sessionId: string): Promise<RestoredWebTab[]> {
    const rows = this.safely(() => this.repo.listTabs(sessionId)) ?? [];
    const out: RestoredWebTab[] = [];
    for (const row of rows) {
      let snap = await this.manager.get(row.id);
      if (!snap) {
        const res = await this.manager.open({
          sessionId,
          tabId: row.id,
          url: row.currentUrl ?? row.initialUrl,
          openedBy: row.openedBy,
          ...(row.openedByRunId !== null ? { openedByRunId: row.openedByRunId } : {}),
          deferLoad: true,
          restore: { initialUrl: row.initialUrl, title: row.title, humanTouched: row.humanTouched },
        });
        if (!res.ok) {
          // viewer_disabled, or a row whose URL no longer passes the guard. Keep
          // the row — flipping the kill switch back on should bring it back.
          continue;
        }
        snap = res.snapshot;
        this.persisted.set(row.id, { url: snap.currentUrl, title: snap.title });
      }
      out.push({
        tabId: row.id,
        initialUrl: row.initialUrl,
        currentUrl: snap.currentUrl,
        title: snap.title ?? row.title,
        openedBy: row.openedBy,
        openedByRunId: row.openedByRunId,
        humanTouched: snap.humanTouched || row.humanTouched,
        position: row.position,
      });
    }
    return out;
  }

  /**
   * Session teardown (archive, merge, delete): destroy the views, drop the tab
   * rows, KEEP the audit trail — it is removed only by a real session delete.
   */
  disposeSession(sessionId: string): void {
    for (const tabId of this.manager.tabIdsForSession(sessionId)) this.forget(tabId);
    this.manager.disposeSession(sessionId);
    const removed = this.safely(() => this.repo.deleteTabsForSession(sessionId)) ?? 0;
    this.audit({ sessionId, kind: 'session_disposed', detail: `tabs=${removed}` });
  }

  // -------------------------------------------------------------------------
  // Pass-through
  // -------------------------------------------------------------------------

  navigate(tabId: string, url: string): Promise<WebViewerAck> {
    return this.manager.navigate(tabId, url);
  }
  back(tabId: string): Promise<WebViewerAck> {
    return this.manager.back(tabId);
  }
  forward(tabId: string): Promise<WebViewerAck> {
    return this.manager.forward(tabId);
  }
  reload(tabId: string): Promise<WebViewerAck> {
    return this.manager.reload(tabId);
  }
  setBounds(...args: Parameters<WebViewerLike['setBounds']>): Promise<WebViewerAck> {
    return this.manager.setBounds(...args);
  }
  setVisible(tabId: string, visible: boolean): Promise<WebViewerAck> {
    return this.manager.setVisible(tabId, visible);
  }
  list(sessionId: string): Promise<WebTabSnapshot[]> {
    return this.manager.list(sessionId);
  }
  get(tabId: string): Promise<WebTabSnapshot | null> {
    return this.manager.get(tabId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private onTabState(snap: WebTabSnapshot): void {
    const prevState = this.lastState.get(snap.tabId);
    this.lastState.set(snap.tabId, snap.state);
    if (snap.state === 'evicted' && prevState !== undefined && prevState !== 'evicted') {
      this.audit({
        sessionId: snap.sessionId,
        tabId: snap.tabId,
        kind: 'tab_evicted',
        origin: redactToOrigin(snap.currentUrl),
      });
    }

    const last = this.persisted.get(snap.tabId);
    if (!last) return; // not a persisted tab (or not yet inserted)
    if (last.url === snap.currentUrl && last.title === snap.title) return;
    this.persisted.set(snap.tabId, { url: snap.currentUrl, title: snap.title });
    this.safely(() =>
      this.repo.updateTab(snap.tabId, {
        currentUrl: snap.currentUrl,
        title: snap.title,
        lastActiveAt: new Date().toISOString(),
      }),
    );
  }

  private forget(tabId: string): void {
    this.persisted.delete(tabId);
    this.lastState.delete(tabId);
  }

  private audit(event: WebEventInput): void {
    this.safely(() => this.repo.appendEvent(event));
  }

  private safely<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      console.warn('[WebViewer] persistence write failed:', err);
      return undefined;
    }
  }
}
