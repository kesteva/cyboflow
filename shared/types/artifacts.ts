/**
 * Run artifacts — shared vocabulary for the tabbed center pane.
 *
 * An "artifact" is a run-scoped deliverable surfaced as its own center-pane tab
 * (idea spec, decomposed stories, screenshots, ui prototype) plus a catch-all
 * `generic` live canvas for anything without a bespoke template. Known atypes
 * render in bespoke templates (`mode: 'template'`); everything else renders in an
 * embedded live canvas (`mode: 'canvas'`).
 *
 * This file currently owns ONLY the UI-facing vocabulary (the atype union + the
 * per-type accent color / glyph / render-mode maps) so both the renderer and the
 * shared `centerPane.ts` tab types can reference one canonical source. The
 * artifacts DATA MODEL (DB row shape, discriminated payload union, router I/O,
 * change events) is added to this same file when the artifacts backend lands
 * (migration 029) — keep this the single home for artifact types.
 */
import type { VerdictV1 } from './visualVerification';

/**
 * Artifact kinds. The four bespoke (templated) types plus a `generic` fallback
 * that renders in the live canvas. Keep in sync with the migration 029
 * `artifacts.atype` CHECK constraint when the backend lands.
 */
export type ArtifactType =
  | 'idea-spec'
  | 'decomposed-stories'
  | 'screenshots'
  | 'ui-prototype'
  | 'generic';

/** How an artifact tab renders: a bespoke template vs. an embedded live canvas. */
export type ArtifactRenderMode = 'template' | 'canvas';

/**
 * Render mode per atype. Templated types get bespoke views; `ui-prototype` and
 * `generic` are live canvases (dashed tab chip + `◳` glyph + iframe body).
 */
export const ARTIFACT_RENDER_MODE: Record<ArtifactType, ArtifactRenderMode> = {
  'idea-spec': 'template',
  'decomposed-stories': 'template',
  screenshots: 'template',
  'ui-prototype': 'canvas',
  generic: 'canvas',
};

/**
 * Accent ("edge") color per atype — drives the active tab's top border, the tab
 * label, and the artifact chip. Raw hex from the design handoff; the M7 polish
 * pass migrates these to `var(--cf-*)` tokens once the tokens are added.
 */
export const ARTIFACT_COLORS: Record<ArtifactType, string> = {
  'idea-spec': '#3b6dd6',
  'decomposed-stories': '#5a4ad6',
  screenshots: '#2d8a5b',
  'ui-prototype': '#c96442',
  generic: '#c96442',
};

/**
 * Glyph per atype. Live canvases (`mode: 'canvas'`) always render the `◳` glyph
 * regardless of this map; these are the templated glyphs.
 */
export const ARTIFACT_GLYPHS: Record<ArtifactType, string> = {
  'idea-spec': '▤',
  'decomposed-stories': '☰',
  screenshots: '▦',
  'ui-prototype': '◳',
  generic: '◳',
};

/** True when the artifact renders in an embedded live canvas (not a template). */
export function isCanvasArtifact(atype: ArtifactType): boolean {
  return ARTIFACT_RENDER_MODE[atype] === 'canvas';
}

/**
 * Default on-disk location for COMMITTED-artifact manifests, written when the
 * user explicitly commits an artifact (FEATURE #3 durability snapshot). A
 * RELATIVE value resolves against the owning project's ROOT (not the run's
 * worktree — worktrees are torn down on dismiss, taking the snapshot with them).
 * An ABSOLUTE value is used verbatim. Overridable via the global
 * `AppConfig.artifactCommitDir` setting; the ConfigManager getter floors to this
 * constant. Single source of truth — imported by both the main config layer and
 * the snapshot resolver.
 */
export const DEFAULT_ARTIFACT_COMMIT_DIR = '.cyboflow/artifacts';

// ===========================================================================
// Data model — the run-scoped artifacts subsystem (migration 029).
//
// `Artifact` is the camelCase API shape returned to the renderer (the DB row
// shape lives next to the chokepoint in main/src/orchestrator/artifactRouter.ts,
// mirroring ReviewItemDbRow). All writes funnel through ArtifactRouter.
// ===========================================================================

/** API shape of one run artifact (camelCase; numeric flags shaped to booleans). */
export interface Artifact {
  id: string;
  runId: string;
  sessionId: string | null;
  atype: ArtifactType;
  label: string;
  /** Phase·step origin label (e.g. "Plan · get context"), or null. */
  stepOrigin: string | null;
  mode: ArtifactRenderMode;
  /** Persisted into the repo (git) — false = session-only/ephemeral. */
  committed: boolean;
  /** Dropped on session close unless committed. */
  sessionOnly: boolean;
  /** Freshly minted; drives the tab's pulsing "new" dot until focused. */
  isNew: boolean;
  /** Per-atype payload JSON (screenshot fileNames, ui-prototype url, cached render). */
  payloadJson: string | null;
  /** Soft link to the derived-from entity (ideaId/epicId/taskId), or null. */
  sourceRef: string | null;
  createdAt: string;
  committedAt: string | null;
}

/**
 * The parsed `payload_json` shape of a `screenshots` artifact. The producer
 * (visual-verify agent / safety-net scan) writes `{ fileNames }`; the verdict
 * delivery chokepoint (P8) ENRICHES the SAME artifact (idempotent UPSERT by
 * (runId, atype)) with an optional `verdict` block once the VlmJudge has judged
 * those PNGs. Both halves of the contract live here so the renderer's screenshots
 * tab and the main-side enrich path read ONE shape (type-parity across the
 * payload_json string boundary). Extra keys are tolerated (payload is per-atype).
 */
export interface ScreenshotsArtifactPayload {
  /** On-disk basenames of the captured screenshots (bytes loaded separately). */
  fileNames?: string[];
  /**
   * The structured visual-verification verdict for these screenshots, written by
   * the scheduler's verdict-delivery hook. Absent until a judged outcome exists
   * (a skipped/timeout request enriches no verdict). Drives the tab's verdict
   * banner + per-image issues.
   */
  verdict?: VerdictV1;
  [key: string]: unknown;
}

export type ArtifactChangeAction = 'created' | 'updated' | 'committed' | 'deleted';

/** Emitted on the per-project channel after an artifact write commits. */
export interface ArtifactChangedEvent {
  projectId: number;
  runId: string;
  artifactId: string;
  atype: ArtifactType;
  action: ArtifactChangeAction;
  /** The shaped artifact, or null when the action is 'deleted'. */
  artifact: Artifact | null;
}

// Note: the artifacts tRPC request shapes are NOT modeled here — the live
// single source of truth is the inline zod `.input(...)` on each procedure in
// main/src/orchestrator/trpc/routers/artifacts.ts (list / get / commit). Hand-
// mirrored request interfaces were removed after they silently diverged from
// the zod contract (the commit input omitted the required projectId).
