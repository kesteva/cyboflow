/**
 * panelLiveEventsStore — transient per-panel buffer of `stream_event` /
 * `result` envelopes for quick-session (SDK-substrate) panels, feeding the
 * progressive-render LiveTail component (frontend/src/components/chat/LiveTail.tsx)
 * via `liveTailReducer.reduceLiveTail`.
 *
 * Quick panels have no equivalent of `cyboflowStore.streamEvents` (that log
 * follows the run driving the *workflow* view, not a panel's own `__quick__`
 * chat run — see cyboflowStore.ts's doc header). The raw per-event payload DOES
 * reach the renderer over the `session-output` IPC channel
 * (useIPCEvents.ts's `onSessionOutput`), but was previously discarded after
 * dispatching the trigger CustomEvent. This store captures ONLY the two
 * envelope kinds the live tail needs — everything else (settled text/tool
 * output) is still handled by the existing debounced refetch path
 * (useUnifiedPanelMessages) and is never buffered here.
 *
 * Keyed by panelId (mirrors pendingSendStore's `byHost` pattern). A `result`
 * envelope closes the turn — the tail has nothing left to show once it lands —
 * so the buffer is RESET (not appended-then-kept) on every `result`, which
 * both bounds memory across a long-lived panel's many turns and matches
 * `reduceLiveTail`'s own last-result scoping. Also capped defensively at
 * MAX_EVENTS_PER_PANEL in case a single turn emits an unexpectedly large
 * number of deltas before its result lands.
 */
import { create } from 'zustand';
import type { StreamEvent } from '../utils/cyboflowApi';

/** Defensive cap on ONE panel's buffer between result envelopes. */
export const MAX_EVENTS_PER_PANEL = 2000;

interface PanelLiveEventsState {
  byPanel: Record<string, StreamEvent[]>;
  /** Append one envelope; resets the panel's buffer instead on a `result`. */
  appendEvent: (panelId: string, event: StreamEvent) => void;
  /** Test/reset hook — clears every panel's buffer. */
  clearAll: () => void;
}

export const usePanelLiveEventsStore = create<PanelLiveEventsState>((set) => ({
  byPanel: {},

  appendEvent: (panelId, event) =>
    set((s) => {
      if (event.type === 'result') {
        // Turn boundary: the tail has nothing left to reconstruct once the
        // settled message lands via the debounced refetch.
        return { byPanel: { ...s.byPanel, [panelId]: [] } };
      }
      const existing = s.byPanel[panelId] ?? [];
      const next =
        existing.length >= MAX_EVENTS_PER_PANEL
          ? [...existing.slice(existing.length - MAX_EVENTS_PER_PANEL + 1), event]
          : [...existing, event];
      return { byPanel: { ...s.byPanel, [panelId]: next } };
    }),

  clearAll: () => set({ byPanel: {} }),
}));
