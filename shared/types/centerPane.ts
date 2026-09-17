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
 *
 * `approved-design` (Tier 2, item 8c) is a fifth surface bolted onto the same
 * strip: it does NOT back onto the `artifacts` table at all (an approved design
 * durably survives the run/artifact cascade delete precisely because it lives
 * in `approved_designs` + an on-disk snapshot, not an artifact row — see
 * `cyboflow.design.forEntity`/`snapshotHtml`), so it gets its own tab kind
 * rather than riding `artifact`'s atype-keyed identity.
 */
import { isPerEntityArtifact, type ArtifactType } from './artifacts';
import type { DiffGroupScope } from './runFiles';

/** Tab kind discriminant. */
export type TabKind = 'flow' | 'file' | 'artifact' | 'approved-design';

/** Which right-rail tab is showing (Workflow steps vs. Artifacts). */
export type RightRailTab = 'steps' | 'arts';

/** Git status letter for a file tab's glyph (Modified / Added / other). */
export type FileTabStatus = 'M' | 'A' | '?';

/**
 * A single center-pane tab. The optional fields are populated per `kind`:
 *   - `flow`             → `pinned: true`; no `status` / `atype` / file fields.
 *   - `file`             → `filePath`, `worktreePath`, `status`.
 *   - `artifact`         → `atype`, `artifactId`, `committed`.
 *   - `approved-design`  → `ideaId`, `ideaRef`.
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
  /**
   * Base ref/SHA the file's diff should be computed against (file tabs).
   * `null`/`undefined` means the default (working-directory-vs-HEAD) base.
   */
  baseRef?: string | null;
  /** Which diff-group scope the tab's diff belongs to (file tabs). */
  scope?: DiffGroupScope;

  // --- artifact tabs ---
  /** Artifact kind (artifact tabs). */
  atype?: ArtifactType;
  /** Backing artifacts-table row id, once the backend lands (artifact tabs). */
  artifactId?: string;
  /** Committed-to-repo (git) vs. session-only/ephemeral (artifact tabs). */
  committed?: boolean;
  /** Freshly auto-minted; pulses until focused, then cleared (artifact tabs). */
  isNew?: boolean;
  /**
   * The artifact's OWN run (artifact tabs). Set for an {@link TabItem.external}
   * tab, whose backing row lives outside the pane's session and can only be
   * fetched by `(artifactId, runId, atype)` — `artifacts.get` needs the runId to
   * fall back to the committed on-disk snapshot when the DB row was deleted on
   * commit (IDEA-039).
   */
  runId?: string;
  /**
   * EXTERNAL artifact tab: the backing row belongs to ANOTHER run/session (the
   * idea-scoped "open →" links on the idea-session canvas, which point at
   * deliverables minted by the idea's launched planner/design runs).
   *
   * Two consequences, both load-bearing:
   *   - it is resolved via `trpc.cyboflow.artifacts.get` against its own
   *     {@link TabItem.runId}, NOT the pane's session-scoped artifacts list;
   *   - it is therefore EXEMPT from `useArtifactTabsSync`'s prune loop — it is
   *     absent from that session list by construction, so pruning against it
   *     would close the tab the instant it opened.
   */
  external?: boolean;

  // --- approved-design tabs ---
  /** The idea whose approved design this tab shows (approved-design tabs). */
  ideaId?: string;
  /** The idea's display ref (e.g. `IDEA-014`), shown in the tab header. */
  ideaRef?: string;
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

/**
 * Stable id for an artifact tab. Non-per-entity atypes are one tab per atype
 * within a session (`art:<atype>`). PER-ENTITY atypes (idea-spec — a multi-idea
 * planner batch mints one per idea) get one tab per artifact, keyed by the
 * artifact id (`art:<atype>:<artifactId>`). A per-entity call with NO artifactId
 * (the Workflow Progress "creates ⟨artifact⟩" chip's eager open on a single-idea
 * run) returns the plain `art:<atype>` id — the store's openArtifactTab resolves
 * that to the sole open per-entity tab of the atype when exactly one exists.
 *
 * `external` (a cross-run tab — see {@link TabItem.external}) forces the
 * id-keyed form for EVERY atype: the plain `art:<atype>` slot is the session's
 * own single-viewer slot for that atype, and an artifact belonging to another
 * run must neither hijack it nor be hijacked by it (a local `decomposed-stories`
 * arriving in the session list would otherwise land on the same tab as the
 * idea's cross-run one). Without an artifactId there is nothing to key on, so
 * the flag is ignored and the plain id is returned.
 */
export function artifactTabId(atype: ArtifactType, artifactId?: string, external?: boolean): string {
  const keyed = artifactId !== undefined && artifactId.length > 0;
  if (keyed && (external === true || isPerEntityArtifact(atype))) {
    return `art:${atype}:${artifactId}`;
  }
  return `art:${atype}`;
}

/**
 * Stable id for an approved-design tab — one tab per idea within a session
 * (`design:<ideaId>`). Unlike artifact tabs, there is no atype/committed
 * axis: the approved design is keyed purely by the idea it belongs to.
 */
export function approvedDesignTabId(ideaId: string): string {
  return `design:${ideaId}`;
}
