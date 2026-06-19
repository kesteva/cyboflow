/**
 * Center-pane tab model — the tabbed running-session surface (design handoff
 * "Tabbed center pane").
 *
 * Per running session the center column holds a strip of tabs over a content
 * area, with a collapsible terminal dock pinned below. There are three tab kinds:
 *   - `flow`     — the pinned, non-closeable home tab (workflow graph / sprint
 *                  swimlanes). Exactly one per session.
 *   - `file`     — a file/diff opened from the File Explorer (closeable). Carries
 *                  the run worktree path + git status letter.
 *   - `artifact` — a run deliverable (idea spec, stories, screenshots, ui
 *                  prototype, …) rendered as a template or a live canvas.
 *
 * Tab state is per-session and IN-MEMORY only (a Zustand slice; no DB / no
 * localStorage). It persists across sequential runs within a session and resets
 * on app refresh. The durable source of truth for artifacts is the artifacts DB
 * table — closed artifact tabs are reopened from the right-rail Artifacts panel.
 */
import type { ArtifactType } from './artifacts';

/** Tab kind discriminant. */
export type TabKind = 'flow' | 'file' | 'artifact';

/** Which right-rail tab is showing (Workflow steps vs. Artifacts). */
export type RightRailTab = 'steps' | 'arts';

/** Git status letter for a file tab's glyph (Modified / Added / other). */
export type FileTabStatus = 'M' | 'A' | '?';

/**
 * A single center-pane tab. The optional fields are populated per `kind`:
 *   - `flow`     → `pinned: true`; no `status` / `atype` / file fields.
 *   - `file`     → `filePath`, `worktreePath`, `status`.
 *   - `artifact` → `atype`, `artifactId`, `committed`.
 * `isNew` (artifact tabs) drives the pulsing rust dot until the tab is focused.
 */
export interface TabItem {
  /** Stable tab id. Conventions: `'flow'`; `file:<filePath>`; `art:<atype>`. */
  id: string;
  kind: TabKind;
  /** Short label shown in the strip (filename, artifact label, or "Flow"). */
  label: string;
  /** Pinned tabs (the Flow tab) render no close button and cannot be closed. */
  pinned?: boolean;

  // --- file tabs ---
  /**
   * Path of the file relative to the worktree root (file tabs). The diff itself
   * is read from the pane's session (the centerPaneStore key), which is the run's
   * parent session — so no per-tab worktree/session field is needed.
   */
  filePath?: string;
  /** Git status letter for the glyph (file tabs). */
  status?: FileTabStatus;

  // --- artifact tabs ---
  /** Artifact kind (artifact tabs). */
  atype?: ArtifactType;
  /** Backing artifacts-table row id, once the backend lands (artifact tabs). */
  artifactId?: string;
  /** Committed-to-repo (git) vs. session-only/ephemeral (artifact tabs). */
  committed?: boolean;
  /** Freshly auto-minted; pulses until focused, then cleared (artifact tabs). */
  isNew?: boolean;
}

/** Per-session center-pane state. */
export interface CenterPaneSessionState {
  tabs: TabItem[];
  activeTabId: string;
  /** Terminal dock expanded (true) vs. collapsed to its 30px header (false). */
  terminalOpen: boolean;
  rightTab: RightRailTab;
}

/** The pinned Flow tab id — stable across a session. */
export const FLOW_TAB_ID = 'flow';

/** Build the pinned Flow tab (the home tab seeded for every session). */
export function makeFlowTab(): TabItem {
  return { id: FLOW_TAB_ID, kind: 'flow', label: 'Flow', pinned: true };
}

/** Stable id for a file tab (one tab per file path within a session). */
export function fileTabId(filePath: string): string {
  return `file:${filePath}`;
}

/** Stable id for an artifact tab (one tab per atype within a session). */
export function artifactTabId(atype: ArtifactType): string {
  return `art:${atype}`;
}
