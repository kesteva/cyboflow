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
import type { CaptureOrigin, VerdictV1 } from './visualVerification';

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
  | 'generic'
  | 'arch-design'
  | 'compound-recommendations';

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
  'arch-design': 'template',
  'compound-recommendations': 'template',
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
  'arch-design': '#2d7a8a',
  // Compound's phase color (#8b5cf6, the violet used in the run rail) so the
  // recommendations tab reads as part of the Compound flow.
  'compound-recommendations': '#8b5cf6',
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
  'arch-design': '▣',
  'compound-recommendations': '▧',
};

/** True when the artifact renders in an embedded live canvas (not a template). */
export function isCanvasArtifact(atype: ArtifactType): boolean {
  return ARTIFACT_RENDER_MODE[atype] === 'canvas';
}

// ===========================================================================
// arch-design — the templated architecture-design section extractor.
//
// The 'arch-design' artifact RE-DERIVES its content on READ from the
// originating idea's markdown `body` — specifically the '## Architecture
// design' H2 section (folded into the body by the planner/ship architecture
// step). BOTH sides use this ONE extractor so they can never disagree:
//   - backend: the autoMintArtifacts content gate (mint only when the section
//     exists and is non-empty);
//   - frontend: ArtifactTabRenderer's arch-design body (render the extracted
//     section through MarkdownPreview).
// ===========================================================================

/** The H2 heading text that delimits the architecture-design section. */
export const ARCH_DESIGN_SECTION_HEADING = 'Architecture design';

/**
 * Matches the '## Architecture design' heading as a single LINE
 * (case-insensitive; tolerates trailing whitespace). Deliberately uses
 * `[ \t]` — never `\s`, which spans newlines and lets a bare '##' line plus a
 * later 'Architecture design' text line spoof the heading.
 */
const ARCH_DESIGN_HEADING_LINE_RE = new RegExp(
  `^##[ \\t]+${ARCH_DESIGN_SECTION_HEADING}[ \\t]*$`,
  'i',
);

/** An H2 line (or a bare '##' empty ATX heading) — terminates the section. */
const H2_LINE_RE = /^##(?:[ \t]|$)/;

/** A ``` / ~~~ fence line (CommonMark allows up to 3 leading spaces). */
const FENCE_LINE_RE = /^ {0,3}(?:```|~~~)/;

/**
 * Extract the '## Architecture design' section from an idea body: everything
 * after the heading line up to (not including) the next H2 line or EOF,
 * trimmed. Line-based and fenced-code-block-aware, so '## '-prefixed lines
 * inside ``` fences neither start nor terminate a section. When the body
 * carries MORE than one such heading (e.g. a revise round appended a fresh
 * section instead of replacing), the LAST section wins — it is the freshest
 * fold. Returns null when the body is empty, the heading is absent, or the
 * section has no content.
 */
export function extractArchDesignSection(body: string | null | undefined): string | null {
  if (!body) return null;
  const lines = body.split(/\r?\n/);

  let inFence = false;
  let sectionStart = -1; // line index AFTER the most recent heading match
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (ARCH_DESIGN_HEADING_LINE_RE.test(line)) {
      // A later heading supersedes any earlier one (last section wins).
      sectionStart = i + 1;
      sectionEnd = lines.length;
    } else if (sectionStart !== -1 && sectionEnd === lines.length && H2_LINE_RE.test(line)) {
      sectionEnd = i;
    }
  }

  if (sectionStart === -1) return null;
  const section = lines.slice(sectionStart, sectionEnd).join('\n').trim();
  return section.length > 0 ? section : null;
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
  /**
   * HUMAN-FACING capture provenance (S9): how the judged deliverable was stood up
   * ('dev-server' | 'static-server' | 'url' | 'file'). Written by the verdict-
   * delivery hook alongside the verdict; absent for pre-S9 rows.
   */
  captureOrigin?: CaptureOrigin;
  /**
   * UNTRUSTED page-console diagnostics collected during capture (capped by the
   * backend + scheduler). Page code controls this text — display-only metadata,
   * never judge input, never a pass/fail signal.
   */
  diagnostics?: string[];
  [key: string]: unknown;
}

/**
 * The parsed `payload_json` shape of a `compound-recommendations` artifact — the
 * Compound flow's summary-of-recommendations doc surfaced for the approve gate.
 *
 * Unlike the entity-backed templated atypes (idea-spec / arch-design re-derive
 * from an idea body), this doc has NO entity source: the compound orchestrator
 * composes the markdown from the drafted learnings and reports it verbatim in
 * `markdown`. The renderer reads it straight from the payload — no fetch, no
 * source_ref. Extra keys are tolerated (payload is per-atype).
 */
export interface RecommendationsArtifactPayload {
  /** The full recommendations doc, rendered through MarkdownPreview. */
  markdown?: string;
  [key: string]: unknown;
}

export type ArtifactChangeAction = 'created' | 'updated' | 'committed' | 'deleted';

/** Emitted on the per-project channel after an artifact write commits. */
export interface ArtifactChangedEvent {
  projectId: number;
  runId: string;
  /**
   * The run's parent session (`workflow_runs.session_id`), or null for a
   * parentless/legacy run. Lets session-scoped consumers (the session-keyed
   * center-pane tab store — see `useSessionArtifactsList`) filter the
   * project-wide channel to "my session's runs" without knowing every run id
   * that session has ever hosted up front.
   */
  sessionId: string | null;
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
