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
 * Artifact kinds. The bespoke (templated) types plus a `generic` fallback
 * that renders in the live canvas. Keep in sync with the `artifacts.atype`
 * CHECK constraint (currently widened by migration 073).
 */
export type ArtifactType =
  | 'idea-spec'
  | 'decomposed-stories'
  | 'screenshots'
  | 'ui-prototype'
  | 'generic'
  | 'arch-design'
  | 'compound-recommendations'
  | 'approve-ideas'
  | 'approve-designs';

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
  'approve-ideas': 'template',
  'approve-designs': 'template',
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
  'approve-ideas': '#b8860b',
  // The design-approval sibling of approve-ideas: an approval gold tilted toward
  // arch-design's teal (#2d7a8a) so the joint design gate reads as "approve the
  // architecture designs".
  'approve-designs': '#8a7326',
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
  'approve-ideas': '☑',
  'approve-designs': '⊡',
};

/** True when the artifact renders in an embedded live canvas (not a template). */
export function isCanvasArtifact(atype: ArtifactType): boolean {
  return ARTIFACT_RENDER_MODE[atype] === 'canvas';
}

/**
 * Atypes that are NOT one-per-(run, atype): a single run may hold MULTIPLE
 * artifacts of this kind, one per source entity (source_ref). The multi-idea
 * planner batch mints one 'idea-spec' AND one 'arch-design' per seeded/owned
 * idea, so both have identity (run_id, atype, source_ref) — see migrations 063
 * (idea-spec) and 070 (arch-design). Every OTHER atype keeps the strict
 * one-per-(run, atype) rule.
 *
 * This is the SINGLE HOME for the "per-entity" decision — the ArtifactRouter
 * create-identity (main-side) and the center-pane tab id (frontend) both key off
 * it, so the split rule can never disagree across the two layers.
 */
export const PER_ENTITY_ARTIFACT_ATYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>([
  'idea-spec',
  'arch-design',
]);

/** True when a run may hold several of this atype (identity keyed by source_ref). */
export function isPerEntityArtifact(atype: ArtifactType): boolean {
  return PER_ENTITY_ARTIFACT_ATYPES.has(atype);
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
 * Byte-preserving inverse-companion of {@link extractArchDesignSection}: replace
 * the WHOLE '## Architecture design' section — the heading line through the same
 * next-H2-or-EOF boundary extract uses, and the same "last heading wins" choice —
 * with `newSection`, leaving every other byte of `body` untouched. When no such
 * section exists, `newSection` is appended after a blank-line separator (the body's
 * existing bytes are never rewritten).
 *
 * `newSection` is expected to be a COMPLETE section that begins with its own
 * '## Architecture design' heading line (what the architecture agent emits, and
 * what the append path needs to produce a re-extractable section). The original
 * section's trailing blank-line run is preserved after the splice so the following
 * H2 stays visually separated.
 *
 * Round-trip: `extractArchDesignSection(replaceArchDesignSection(body, s))` equals
 * `extractArchDesignSection(s)` — the content of `s` after its heading, trimmed the
 * same way extract trims — for any `s` that carries the heading line.
 */
export function replaceArchDesignSection(body: string | null | undefined, newSection: string): string {
  const base = body ?? '';
  const lines = base.split(/\r?\n/);

  // Re-run the exact scan extractArchDesignSection uses to locate the span, but
  // keep the heading LINE index (sectionStart - 1) so the whole section is swapped.
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
      sectionStart = i + 1;
      sectionEnd = lines.length;
    } else if (sectionStart !== -1 && sectionEnd === lines.length && H2_LINE_RE.test(line)) {
      sectionEnd = i;
    }
  }

  if (sectionStart === -1) {
    // No section: append after a blank line, never rewriting existing bytes.
    if (base.length === 0) return newSection;
    const sep = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    return base + sep + newSection;
  }

  // Char offsets for each logical line start (consistent with split(/\r?\n/)).
  const lineStarts: number[] = [0];
  const nlRe = /\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = nlRe.exec(base)) !== null) {
    lineStarts.push(m.index + m[0].length);
  }

  const headingStart = lineStarts[sectionStart - 1];
  const endOffset = sectionEnd < lines.length ? lineStarts[sectionEnd] : base.length;

  const region = base.slice(headingStart, endOffset);
  const trailing = /(?:\r?\n)*$/.exec(region)?.[0] ?? '';
  const coreNew = newSection.replace(/(?:\r?\n)*$/, '');

  return base.slice(0, headingStart) + coreNew + trailing + base.slice(endOffset);
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

/**
 * Restrictive CSP injected into every static `ui-prototype`/`generic` mockup
 * document before it is embedded via `srcDoc` (bare `sandbox=""` iframe, no
 * `allow-scripts`/`allow-same-origin`). The main-process `artifacts:load-html`
 * handler PREPENDS it as the document's first token (see injectPrototypeCsp);
 * with scripts disabled by the bare sandbox this `<meta>` is the sole
 * subresource-egress control, so it must survive adversarial markup. (Note: the
 * HTML `csp` iframe attribute was never shipped in Chromium/Electron and is NOT
 * used — this meta is the real enforcement.)
 */
export const ARTIFACT_PROTOTYPE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * Canonical on-disk relative path (inside a run's artifacts dir, or a
 * committed snapshot's `files/` dir) for a static `ui-prototype` mockup's
 * single self-contained HTML document. The report-handler content-blesser
 * MINTS the stored payload as exactly `{ fileName: PROTOTYPE_HTML_RELPATH }`,
 * discarding whatever path the producing agent claims.
 */
export const PROTOTYPE_HTML_RELPATH = 'prototype/index.html';

/**
 * Hard ceiling (bytes) on the `prototype/index.html` document the
 * `artifacts:load-html` handler will read and return. Guards against an
 * agent (or a corrupted/malicious file) blowing up IPC payload size.
 */
export const MAX_PROTOTYPE_HTML_BYTES = 5 * 1024 * 1024;

/**
 * Hard ceiling (bytes) for a single committed SCREENSHOT PNG copied into the
 * durability snapshot. Screenshots are full-page captures and legitimately far
 * exceed the HTML document cap, so they get their own (larger) limit — using the
 * HTML cap for them would silently drop valid captures on commit and, once the
 * run subtree is reaped, lose them permanently.
 */
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

/** The canvas atypes the `artifacts:load-html` IPC channel can source HTML for. */
export type LoadArtifactHtmlAtype = 'ui-prototype' | 'generic';

/**
 * Request/response shapes for the `artifacts:load-html` IPC channel. SHARED so
 * the main handler, the preload bridge, the renderer `electron.d.ts` declaration,
 * and the `useArtifactHtml` hook all reference ONE definition — a drifted local
 * copy would silently drop fields across the boundary (see CODE-PATTERNS.md).
 */
export interface LoadArtifactHtmlRequest {
  runId: string;
  atype: LoadArtifactHtmlAtype;
  /** Advisory only (both sources are always tried); retained for call-site clarity. */
  committed?: boolean;
}

export interface LoadArtifactHtmlResult {
  html: string | null;
}

/**
 * Schema version stamped onto every on-disk committed-artifact manifest
 * (`ArtifactSnapshotManifest.schemaVersion`). Bumped to 2 for the per-
 * `(runId,atype)` directory layout (`S/<runId>/<atype>/{manifest.json,
 * files/<relpath>}`) that replaced the flat `<atype>__<id>.json` v1 layout.
 */
export const ARTIFACT_SNAPSHOT_SCHEMA_VERSION = 2;

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
 * The parsed `payload_json` shape of a `ui-prototype`|`generic` artifact
 * (Approach C — static on-disk mockup, no dev server). The report-handler
 * content-blesser is the SOLE writer of `fileName` for `ui-prototype`: it
 * mints exactly `{ fileName: PROTOTYPE_HTML_RELPATH }` after validating the
 * on-disk file, discarding whatever the producing agent sent — a top-level
 * `html` key is REJECTED at report time (`ArtifactError('invalid_payload')`),
 * never stored. `generic` keeps the legacy `{ url }` live-canvas passthrough
 * (html-reject only, no file-pointer validation). Extra keys are tolerated.
 */
export interface UiPrototypeArtifactPayload {
  /** On-disk relative path to the static mockup document (ui-prototype). */
  fileName?: string;
  /** Legacy/generic live-canvas URL (cross-origin iframe embed). */
  url?: string;
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

/**
 * Parsed `payload_json` shape of an `approve-ideas` artifact — the human-facing
 * half of the approve-ideas BATCH gate (IDEA-009). The planner reports this
 * artifact via the `cyboflow_report_artifact` MCP tool's `payload_json` when it
 * opens a `gate:human-step:approve-ideas` decision review item; `ideas` are the
 * batch's rows the template renders one Approve/Deny control per. The template
 * validates the submitted verdict map against the gate's `DecisionPayload.
 * ideaRefs` at submit time (every ref decided, none outside the batch) — the
 * server (reviewItems.resolve) re-validates authoritatively, so this payload is
 * a display/UX convenience only, never a trust boundary.
 */
export interface ApproveIdeasArtifactPayload {
  ideas: Array<{
    ref: string;
    title: string;
    scope?: string | null;
    summary?: string | null;
  }>;
}

/**
 * Parsed `payload_json` shape of an `approve-designs` artifact — the human-facing
 * half of the approve-designs BATCH gate, the design-approval sibling of
 * {@link ApproveIdeasArtifactPayload}. When a multi-idea planner run runs
 * architecture across more than one owned idea, ONE joint gate approves/denies
 * each idea's architecture design; `designs` are the per-idea rows the template
 * renders one Approve/Deny control per (each `ref` an idea whose body carries a
 * '## Architecture design' section). The template validates the submitted verdict
 * map against the gate's `DecisionPayload.designRefs` at submit time; the server
 * (reviewItems.resolve) re-validates authoritatively, so this payload is a
 * display/UX convenience only, never a trust boundary.
 */
export interface ApproveDesignsArtifactPayload {
  designs: Array<{
    ref: string;
    title: string;
    scope?: string | null;
    summary?: string | null;
  }>;
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
