/**
 * cyboflow.webViewer sub-router — the renderer's control surface for native
 * web-viewer tabs (docs/proposals/native-web-viewer.md §3.5).
 *
 * A ROUTER, not `ipcMain.handle`: `ipc/__tests__/noNewIpcHandlers.test.ts`
 * freezes the per-file `ipcMain.handle` count, so a new renderer↔main surface
 * belongs here.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/* — the manager reaches this file only as
 * {@link WebViewerLike} on the context, wired from webViewerComposition.ts.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { eventToAsyncIterable } from './events';
import type {
  RestoredWebTab,
  WebActivityEntry,
  WebConsentEvent,
  WebConsentGrant,
  WebConsentRequest,
  WebTabClosedEvent,
  WebTabSnapshot,
  WebTabStateEvent,
  WebViewerChordEvent,
  WebViewerPopupEvent,
} from '../../../../../shared/types/webViewer';
import type {
  WebViewerAck,
  WebViewerConsentLike,
  WebViewerLike,
  WebViewerOpenResult,
} from '../contracts/webViewerOps';

function requireViewer(viewer: WebViewerLike | undefined): WebViewerLike {
  if (!viewer) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'webViewer not wired into tRPC context',
    });
  }
  return viewer;
}

function requireConsent(consent: WebViewerConsentLike | undefined): WebViewerConsentLike {
  if (!consent) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'webViewer consent not wired into tRPC context',
    });
  }
  return consent;
}

const tabIdInput = z.object({ tabId: z.string().min(1) });
const sessionInput = z.object({ sessionId: z.string().min(1) });

export const webViewerRouter = router({
  /**
   * Open a tab. `tabId` is minted by the RENDERER (`makeWebTabId`) and passed
   * in, not returned: it is the correlation key across the strip, this map, the
   * persisted row, the grants and the telemetry cursor, and minting it caller-side
   * keeps the store action synchronous like its siblings.
   */
  open: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        tabId: z.string().min(1),
        url: z.string().min(1),
        openedBy: z.enum(['user', 'agent']),
        openedByRunId: z.string().min(1).optional(),
        deferLoad: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<WebViewerOpenResult> => {
      return requireViewer(ctx.webViewer).open(input);
    }),

  navigate: protectedProcedure
    .input(tabIdInput.extend({ url: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      return requireViewer(ctx.webViewer).navigate(input.tabId, input.url);
    }),

  back: protectedProcedure
    .input(tabIdInput)
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      return requireViewer(ctx.webViewer).back(input.tabId);
    }),

  forward: protectedProcedure
    .input(tabIdInput)
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      return requireViewer(ctx.webViewer).forward(input.tabId);
    }),

  reload: protectedProcedure
    .input(tabIdInput)
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      return requireViewer(ctx.webViewer).reload(input.tabId);
    }),

  close: protectedProcedure
    .input(tabIdInput)
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      return requireViewer(ctx.webViewer).close(input.tabId);
    }),

  /**
   * Position the native view. The rect is in RENDERER CSS PIXELS; main scales it
   * by the window's zoom factor, because `setBounds` is DIP-relative.
   */
  setBounds: protectedProcedure
    .input(
      tabIdInput.extend({
        x: z.number(),
        y: z.number(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      const { tabId, ...bounds } = input;
      return requireViewer(ctx.webViewer).setBounds(tabId, bounds);
    }),

  setVisible: protectedProcedure
    .input(tabIdInput.extend({ visible: z.boolean() }))
    .mutation(async ({ ctx, input }): Promise<WebViewerAck> => {
      return requireViewer(ctx.webViewer).setVisible(input.tabId, input.visible);
    }),

  list: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<WebTabSnapshot[]> => {
      return requireViewer(ctx.webViewer).list(input.sessionId);
    }),

  get: protectedProcedure
    .input(tabIdInput)
    .query(async ({ ctx, input }): Promise<WebTabSnapshot | null> => {
      return requireViewer(ctx.webViewer).get(input.tabId);
    }),

  /**
   * Re-create a session's persisted tabs, UNLOADED and under their persisted
   * ids, and return them in strip order for the renderer to rebuild its entries.
   * A mutation, not a query: it registers rows with the manager. Idempotent.
   */
  restore: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<RestoredWebTab[]> => {
      return requireViewer(ctx.webViewer).restore(input.sessionId);
    }),

  /** Per-session tab-state stream (navigation, title, loading, blocked, crashed). */
  onTabState: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<WebTabStateEvent> {
      const events = ctx.webViewerEvents;
      if (!events) return;
      const abortSignal = signal ?? new AbortController().signal;
      for await (const ev of eventToAsyncIterable<WebTabStateEvent>(
        events.emitter,
        events.tabStateChannel,
        abortSignal,
      )) {
        if (ev.sessionId === input.sessionId) yield ev;
      }
    }),

  /**
   * Every NEW tab in the session — an agent's background open, or a URL the
   * session CLI handed to `$BROWSER` (openUrlShellHook). The renderer already
   * holds the tabs it opened itself, and its bridge leaves those be.
   */
  onTabOpened: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<WebTabStateEvent> {
      const events = ctx.webViewerEvents;
      if (!events?.tabOpenedChannel) return;
      const abortSignal = signal ?? new AbortController().signal;
      for await (const ev of eventToAsyncIterable<WebTabStateEvent>(
        events.emitter,
        events.tabOpenedChannel,
        abortSignal,
      )) {
        if (ev.sessionId === input.sessionId) yield ev;
      }
    }),

  /** Per-session tab-gone stream, distinguishing a close from an evict or crash. */
  onTabClosed: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<WebTabClosedEvent> {
      const events = ctx.webViewerEvents;
      if (!events) return;
      const abortSignal = signal ?? new AbortController().signal;
      for await (const ev of eventToAsyncIterable<WebTabClosedEvent>(
        events.emitter,
        events.tabClosedChannel,
        abortSignal,
      )) {
        if (ev.sessionId === input.sessionId) yield ev;
      }
    }),

  /**
   * Reserved chords the app owns that were pressed while a native view had
   * focus, resolved in main and reported as a SEMANTIC ACTION.
   *
   * This exists because a focused native view receives keystrokes in its own
   * renderer process: every window-level `keydown` listener in the app's renderer
   * — including the five hand-rolled shortcut hooks and every Escape handler —
   * stops firing until focus leaves. Never a synthetic key event: replaying one
   * would be indistinguishable from a real keystroke to every other listener.
   */
  onReservedChord: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<WebViewerChordEvent> {
      const events = ctx.webViewerEvents;
      if (!events) return;
      const abortSignal = signal ?? new AbortController().signal;
      for await (const ev of eventToAsyncIterable<WebViewerChordEvent>(
        events.emitter,
        events.chordChannel,
        abortSignal,
      )) {
        if (ev.sessionId === input.sessionId) yield ev;
      }
    }),

  /**
   * A viewer page asked to open a window. It never gets a real one — a
   * `BrowserWindow` opened by a remote page would carry the viewer's partition
   * with none of its guards, chrome or occlusion handling — so the request
   * arrives here and the renderer opens it as another viewer tab instead.
   */
  onPopupRequested: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<WebViewerPopupEvent> {
      const events = ctx.webViewerEvents;
      if (!events) return;
      const abortSignal = signal ?? new AbortController().signal;
      for await (const ev of eventToAsyncIterable<WebViewerPopupEvent>(
        events.emitter,
        events.popupChannel,
        abortSignal,
      )) {
        if (ev.sessionId === input.sessionId) yield ev;
      }
    }),

  // -------------------------------------------------------------------------
  // Consent (§7). The HUMAN side only — agents reach consent through the MCP
  // tools, which raise prompts; they can never answer one.
  // -------------------------------------------------------------------------

  /** Prompts currently waiting on the human, for a (re)mounted session. */
  pendingConsents: protectedProcedure
    .input(sessionInput)
    .query(({ ctx, input }): WebConsentRequest[] => requireConsent(ctx.webViewerConsent).listPending(input.sessionId)),

  /** Answer a prompt from the tab sheet. `ok:false` when it already resolved. */
  respondConsent: protectedProcedure
    .input(z.object({ requestId: z.string().min(1), decision: z.enum(['allow', 'deny']) }))
    .mutation(({ ctx, input }): WebViewerAck => {
      return requireConsent(ctx.webViewerConsent).respond(input.requestId, input.decision)
        ? { ok: true }
        : { ok: false, error: 'request_not_found' };
    }),

  grants: protectedProcedure
    .input(sessionInput)
    .query(({ ctx, input }): WebConsentGrant[] => requireConsent(ctx.webViewerConsent).listGrants(input.sessionId)),

  revokeGrant: protectedProcedure
    .input(z.object({ grantId: z.string().min(1) }))
    .mutation(({ ctx, input }): WebViewerAck => {
      return requireConsent(ctx.webViewerConsent).revokeGrant(input.grantId)
        ? { ok: true }
        : { ok: false, error: 'grant_not_found' };
    }),

  /** Revoke every grant on a tab and deny its open prompts. */
  revokeTab: protectedProcedure.input(tabIdInput).mutation(({ ctx, input }): WebViewerAck => {
    requireConsent(ctx.webViewerConsent).revokeTab(input.tabId);
    return { ok: true };
  }),

  /** The audit trail (origin only), newest first; optionally one tab's. */
  activity: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), tabId: z.string().min(1).optional() }))
    .query(({ ctx, input }): WebActivityEntry[] =>
      requireConsent(ctx.webViewerConsent).activity(input.sessionId, input.tabId),
    ),

  /** Consent prompts opening and resolving, for this session. */
  onConsent: protectedProcedure
    .input(sessionInput)
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<WebConsentEvent> {
      const events = ctx.webViewerEvents;
      if (!events?.consentEmitter || !events.consentChannel) return;
      const abortSignal = signal ?? new AbortController().signal;
      for await (const ev of eventToAsyncIterable<WebConsentEvent>(
        events.consentEmitter,
        events.consentChannel,
        abortSignal,
      )) {
        if (ev.sessionId === input.sessionId) yield ev;
      }
    }),
});
