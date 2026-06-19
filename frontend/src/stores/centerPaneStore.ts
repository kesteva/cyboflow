/**
 * centerPaneStore — per-session, in-memory state for the tabbed center pane.
 *
 * Holds, keyed by session, the open tabs, the active tab, whether the terminal
 * dock is expanded, and which right-rail tab is showing. State is IN-MEMORY only
 * (no DB, no localStorage): it persists across sequential runs within a session
 * and resets on app refresh. The durable source of truth for artifacts is the
 * artifacts DB table; closed artifact tabs are reopened from the right-rail
 * Artifacts panel.
 *
 * The session key is the run's parent session id when known, else the run id as a
 * synthetic key (legacy parentless runs) — resolved by the caller (RunCenterPane).
 *
 * Every session is seeded with the pinned Flow tab. `openFileTab` /
 * `openArtifactTab` are consumed by later milestones (file/diff tabs, artifact
 * tabs); the M1 surface exercises only the Flow tab + dock/right-rail toggles.
 */
import { create } from 'zustand';
import type { ArtifactType } from '../../../shared/types/artifacts';
import {
  type CenterPaneSessionState,
  type FileTabStatus,
  type RightRailTab,
  type TabItem,
  FLOW_TAB_ID,
  makeFlowTab,
  fileTabId,
  artifactTabId,
} from '../../../shared/types/centerPane';

/** A freshly-seeded session: the pinned Flow tab, dock open, Workflow steps rail. */
function seededSession(): CenterPaneSessionState {
  return {
    tabs: [makeFlowTab()],
    activeTabId: FLOW_TAB_ID,
    terminalOpen: true,
    rightTab: 'steps',
  };
}

/**
 * Stable fallback returned by the selector hook before `ensureSession` has run,
 * so a component renders the Flow-only default without a re-render loop (same
 * reference every call). Never mutated.
 */
export const FALLBACK_SESSION: CenterPaneSessionState = {
  tabs: [makeFlowTab()],
  activeTabId: FLOW_TAB_ID,
  terminalOpen: true,
  rightTab: 'steps',
};

/** Params to open (or focus) a file/diff tab. */
export interface OpenFileTabArgs {
  filePath: string;
  status?: FileTabStatus;
  /** Optional label override; defaults to the file's basename. */
  label?: string;
}

/** Params to open (or focus) an artifact tab. */
export interface OpenArtifactTabArgs {
  atype: ArtifactType;
  label: string;
  artifactId?: string;
  committed?: boolean;
  isNew?: boolean;
}

interface CenterPaneStore {
  bySession: Record<string, CenterPaneSessionState>;
  /** Seed a session entry (idempotent — no state change if it already exists). */
  ensureSession: (key: string) => void;
  /** Make a tab active; clears its `isNew` pulse. */
  focusTab: (key: string, tabId: string) => void;
  /** Close a non-pinned tab; if active, focus the previous tab (else Flow). */
  closeTab: (key: string, tabId: string) => void;
  /** Open (or focus) a file/diff tab. */
  openFileTab: (key: string, args: OpenFileTabArgs) => void;
  /** Open (or focus) an artifact tab. */
  openArtifactTab: (key: string, args: OpenArtifactTabArgs) => void;
  /** Toggle the terminal dock expanded/collapsed. */
  toggleTerminal: (key: string) => void;
  /** Set the terminal dock expanded state explicitly. */
  setTerminalOpen: (key: string, open: boolean) => void;
  /** Switch the right-rail tab (Workflow steps vs. Artifacts). */
  setRightTab: (key: string, tab: RightRailTab) => void;
  /** Drop a session's tab state (e.g. on session close). */
  clearSession: (key: string) => void;
}

/** Basename of a path (file tab label default). */
function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

export const useCenterPaneStore = create<CenterPaneStore>((set) => {
  /** Apply `fn` to a session's state (seeding it first if absent). */
  const mutate = (
    key: string,
    fn: (cur: CenterPaneSessionState) => CenterPaneSessionState,
  ): void =>
    set((s) => {
      const cur = s.bySession[key] ?? seededSession();
      return { bySession: { ...s.bySession, [key]: fn(cur) } };
    });

  return {
    bySession: {},

    ensureSession: (key) =>
      set((s) => {
        if (s.bySession[key]) return s;
        return { bySession: { ...s.bySession, [key]: seededSession() } };
      }),

    focusTab: (key, tabId) =>
      mutate(key, (cur) => ({
        ...cur,
        activeTabId: tabId,
        tabs: cur.tabs.map((t) => (t.id === tabId && t.isNew ? { ...t, isNew: false } : t)),
      })),

    closeTab: (key, tabId) =>
      mutate(key, (cur) => {
        const idx = cur.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return cur;
        if (cur.tabs[idx].pinned) return cur; // pinned tabs never close
        const tabs = cur.tabs.filter((t) => t.id !== tabId);
        const activeTabId =
          cur.activeTabId === tabId
            ? (tabs[idx - 1]?.id ?? tabs[tabs.length - 1]?.id ?? FLOW_TAB_ID)
            : cur.activeTabId;
        return { ...cur, tabs, activeTabId };
      }),

    openFileTab: (key, args) =>
      mutate(key, (cur) => {
        const id = fileTabId(args.filePath);
        const existing = cur.tabs.find((t) => t.id === id);
        if (existing) {
          // Refresh the status letter (the file may have changed) and focus.
          return {
            ...cur,
            activeTabId: id,
            tabs: cur.tabs.map((t) => (t.id === id ? { ...t, status: args.status } : t)),
          };
        }
        const tab: TabItem = {
          id,
          kind: 'file',
          label: args.label ?? basename(args.filePath),
          filePath: args.filePath,
          status: args.status,
        };
        return { ...cur, tabs: [...cur.tabs, tab], activeTabId: id };
      }),

    openArtifactTab: (key, args) =>
      mutate(key, (cur) => {
        const id = artifactTabId(args.atype);
        const existing = cur.tabs.find((t) => t.id === id);
        if (existing) {
          return {
            ...cur,
            activeTabId: id,
            tabs: cur.tabs.map((t) =>
              t.id === id
                ? {
                    ...t,
                    label: args.label,
                    artifactId: args.artifactId ?? t.artifactId,
                    committed: args.committed ?? t.committed,
                    isNew: false,
                  }
                : t,
            ),
          };
        }
        const tab: TabItem = {
          id,
          kind: 'artifact',
          label: args.label,
          atype: args.atype,
          artifactId: args.artifactId,
          committed: args.committed ?? false,
          isNew: args.isNew ?? false,
        };
        return { ...cur, tabs: [...cur.tabs, tab], activeTabId: id };
      }),

    toggleTerminal: (key) => mutate(key, (cur) => ({ ...cur, terminalOpen: !cur.terminalOpen })),

    setTerminalOpen: (key, open) => mutate(key, (cur) => ({ ...cur, terminalOpen: open })),

    setRightTab: (key, tab) => mutate(key, (cur) => ({ ...cur, rightTab: tab })),

    clearSession: (key) =>
      set((s) => {
        if (!s.bySession[key]) return s;
        const next = { ...s.bySession };
        delete next[key];
        return { bySession: next };
      }),
  };
});

/**
 * Reactive selector for a session's center-pane state. Returns a stable fallback
 * (Flow tab, dock open) before `ensureSession` has seeded the entry, so callers
 * render a sane default without a re-render loop.
 */
export function useCenterPaneSession(key: string): CenterPaneSessionState {
  return useCenterPaneStore((s) => s.bySession[key] ?? FALLBACK_SESSION);
}
