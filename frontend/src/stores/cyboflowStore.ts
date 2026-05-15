/**
 * cyboflowStore — Zustand slice for the cyboflow orchestrator UI state.
 *
 * State:
 *   activeRunId   — the currently-viewed workflow run, or null
 *   streamEvents  — ordered log of events received from the active run's stream
 *
 * Actions:
 *   setActiveRun(runId)      — switch to a new run (clears prior events)
 *   clearActiveRun()         — deselect the active run
 *   appendStreamEvent(event) — push one stream event onto the log
 */
import { create } from 'zustand';
import type { StreamEvent } from '../utils/cyboflowApi';

interface CyboflowState {
  activeRunId: string | null;
  streamEvents: StreamEvent[];
  setActiveRun: (runId: string) => void;
  clearActiveRun: () => void;
  appendStreamEvent: (event: StreamEvent) => void;
}

export const useCyboflowStore = create<CyboflowState>((set) => ({
  activeRunId: null,
  streamEvents: [],

  setActiveRun: (runId) => set({ activeRunId: runId, streamEvents: [] }),

  clearActiveRun: () => set({ activeRunId: null, streamEvents: [] }),

  appendStreamEvent: (event) =>
    set((s) => ({ streamEvents: [...s.streamEvents, event] })),
}));
