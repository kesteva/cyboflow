/**
 * webConsentStore — consent prompts waiting on the human, by tab.
 *
 * Fed by useWebViewerBridge from main's `onConsent` stream (plus a seed query on
 * mount); read by the tab's consent sheet and the strip's attention dot. Holds
 * prompts only — grants live in main, which is the only place they are checked.
 */
import { create } from 'zustand';
import type { WebConsentRequest } from '../../../shared/types/webViewer';

interface WebConsentStore {
  byRequestId: Record<string, WebConsentRequest>;
  add: (request: WebConsentRequest) => void;
  resolve: (requestId: string) => void;
  /** Replace one session's prompts with main's current list. */
  seed: (sessionId: string, requests: WebConsentRequest[]) => void;
}

export const useWebConsentStore = create<WebConsentStore>((set) => ({
  byRequestId: {},
  add: (request) =>
    set((s) => ({ byRequestId: { ...s.byRequestId, [request.requestId]: request } })),
  resolve: (requestId) =>
    set((s) => {
      if (!(requestId in s.byRequestId)) return s;
      const next = { ...s.byRequestId };
      delete next[requestId];
      return { byRequestId: next };
    }),
  seed: (sessionId, requests) =>
    set((s) => {
      const next: Record<string, WebConsentRequest> = {};
      for (const r of Object.values(s.byRequestId)) if (r.sessionId !== sessionId) next[r.requestId] = r;
      for (const r of requests) next[r.requestId] = r;
      return { byRequestId: next };
    }),
}));

/** Oldest-first prompts for one tab. */
export function selectTabConsents(tabId: string) {
  return (s: WebConsentStore): WebConsentRequest[] =>
    Object.values(s.byRequestId)
      .filter((r) => r.tabId === tabId)
      .sort((a, b) => a.requestedAt - b.requestedAt);
}

export function selectTabHasConsent(tabId: string) {
  return (s: WebConsentStore): boolean => Object.values(s.byRequestId).some((r) => r.tabId === tabId);
}
