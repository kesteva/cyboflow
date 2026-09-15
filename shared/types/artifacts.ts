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
import type { CaptureOrigin, VerdictV1, VerificationReportV1 } from './visualVerification';

/**
 * Artifact kinds. The bespoke (templated) types plus the two live-canvas types
 * (`ui-prototype`/`generic` — static srcdoc — and `interactive-prototype` — the
 * JS-enabled OOPIF canvas). Keep in sync with the `artifacts.atype` CHECK
 * constraint (currently widened by migration 102).
 */
export type ArtifactType =
  | 'idea-spec'
  | 'decomposed-stories'
  | 'screenshots'
  | 'ui-prototype'
  | 'generic'
  | 'interactive-prototype'
  | 'arch-design'
  | 'compound-recommendations'
  | 'project-brief'
  | 'approve-ideas'
  | 'approve-designs'
  /**
   * The ad-hoc code-review eval's full verdict report (system-minted by
   * EvalWorker for run_evals rows with origin='adhoc' — NOT agent-reportable).
   * Payload-backed markdown, like 'compound-recommendations'.
   */
  | 'eval-report'
  /**
   * The verify-setup flow's runbook PROPOSAL — the whole review surface its
   * approve-runbook gate points at (commands, attestation per modality, the
   * rung ladder, risks), and later the proof outcomes. Payload-backed markdown.
   * Reported under 'compound-recommendations' until this existed, which
   * mislabeled it as a Compound deliverable at the exact gate a human is asked
   * to approve repo changes from.
   */
  | 'verify-runbook'
  /**
   * The per-idea idea-component-ledger HUB (migration 102,
   * shared/types/ideaComponents.ts): surfaces one idea's five tracked
   * components (idea-spec / prototype / architecture / epics / stories) and
   * links out to each real deliverable tab — a HUB, not an aggregator, so it
   * points at those tabs rather than inlining their content. System-minted by
   * autoMintArtifacts (reportable:false) — an agent-reported hub would arrive
   * with no source_ref/ledger context and render broken.
   */
  | 'idea-summary'
  /**
   * The Launch/Planner/Ship `adversarial-review` step's critique, as a
   * payload-backed markdown doc (the `verify-runbook` shape). ONE per run: it
   * reviews the whole design surface — spec + prototype + architecture together
   * — so a re-report after a Revise ENRICHES the same row rather than minting a
   * sibling. Its existence is what lets the `approve-design` gate show the human
   * what they are approving, and what lets Approve file each remaining entry as
   * a non-blocking accepted-risk finding instead of losing it with the step's
   * turn. Widened into the DB CHECK by migration 135.
   */
  | 'adversarial-review';

/** How an artifact tab renders: a bespoke template vs. an embedded live canvas. */
export type ArtifactRenderMode = 'template' | 'canvas';

/**
 * Restrictive CSP injected into every static `ui-prototype`/`generic` mockup
 * document before it is embedded via `srcDoc` (bare `sandbox=""` iframe, no
 * `allow-scripts`/`allow-same-origin`). The main-process `artifacts:load-html`
 * handler PREPENDS it as the document's first token (see injectPrototypeCsp);
 * with scripts disabled by the bare sandbox this `<meta>` is the sole
 * subresource-egress control, so it must survive adversarial markup. (Note: the
 * HTML `csp` iframe attribute was never shipped in Chromium/Electron and is NOT
 * used — this meta is the real enforcement.)
 *
 * Declared HERE (ahead of {@link ARTIFACT_POLICIES}) rather than lower in the
 * file because the policy registry references it as `ui-prototype`/`generic`'s
 * `csp` — a `const` referenced before its declaration in the registry object
 * literal would throw a temporal-dead-zone ReferenceError at module load.
 */
export const ARTIFACT_PROTOTYPE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * CSP injected into an `interactive-prototype` document (Design Mode v1). Unlike
 * {@link ARTIFACT_PROTOTYPE_CSP} it ALLOWS inline script execution
 * (`script-src 'unsafe-inline'`) — the interactive canvas exists to run the
 * agent-generated prototype's JS — while keeping `default-src 'none'` so ALL
 * network egress (fetch/XHR/WebSocket/subresource GETs beyond inline data:) is
 * still blocked, plus `base-uri 'none'`/`form-action 'none'`. Capability
 * containment for this frame is CSP + a minimal `allow-scripts` sandbox + the
 * scripted-frame navigation guard + process isolation (see design-mode.md
 * "Canvas v1"); this constant is the egress half.
 */
export const ARTIFACT_INTERACTIVE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * Per-atype POLICY — the canonical, single-source-of-truth table every
 * atype-special-casing seam derives from (Design Mode v1, design-mode.md
 * "Canvas v1 — artifact-policy registry"). Generalizes the lesson that made the
 * router's `VALID_ATYPES` derived rather than hand-maintained: report
 * validation, the reportable-tool enum, payload blessing, the IPC HTML loader,
 * CSP selection, snapshot byte-durability, per-entity identity, and the tab
 * renderer all read this ONE table, so a newly added atype cannot silently miss
 * a guard (the interactive-prototype canvas that motivated the registry would
 * otherwise have been able to bypass canonical-file validation, fail to load,
 * or "commit" with zero HTML bytes and then lose its only copy on row delete).
 */
export interface ArtifactPolicy {
  /** Template body vs. embedded live canvas. */
  renderMode: ArtifactRenderMode;
  /**
   * For a canvas atype, WHICH canvas mechanism: `static-srcdoc` = bare-sandbox
   * `srcDoc` iframe (ui-prototype/generic), `interactive-oopif` = the
   * process-isolated JS-enabled loopback-origin frame (interactive-prototype).
   * `null` for a template atype (no canvas).
   */
  canvasKind: 'static-srcdoc' | 'interactive-oopif' | null;
  /** May the `artifacts:load-html` / `artifacts:open-in-browser` IPC source HTML for it. */
  htmlLoadable: boolean;
  /** The CSP injected when this atype's HTML is served/embedded (null for non-HTML atypes). */
  csp: string | null;
  /**
   * How the report-handler content-blesser treats this atype's payload:
   *   - `prototype-file` — reject an inline `html` key AND validate the on-disk
   *     `prototype/index.html`, minting the canonical `{ fileName }` (ui-prototype
   *     AND interactive-prototype);
   *   - `html-reject-only` — reject an inline `html` key, pass the rest through
   *     (`generic`, whose `{ url }` is a legacy live-canvas pointer);
   *   - `none` — no content blessing (every templated atype).
   */
  blessing: 'prototype-file' | 'html-reject-only' | 'none';
  /**
   * True when the durability snapshot MUST capture the canonical static-mockup
   * HTML (`prototype/index.html`) for this atype regardless of payload — drives
   * `requiredBytePaths`. True for ui-prototype AND interactive-prototype;
   * `generic`'s declared-fileName and `screenshots`' fileNames are handled
   * separately (they are not the always-canonical prototype byte).
   */
  requiresPrototypeBytes: boolean;
  /**
   * True when an agent may report this atype via `cyboflow_report_artifact`.
   * False for the auto-mint-only templated surfaces (`arch-design`,
   * `approve-designs`) that the orchestrator derives — an agent report would
   * lack the source_ref/gate context they need and render broken.
   */
  reportable: boolean;
  /** Accent ("edge") color — drives the tab top border, label, and chip. */
  color: string;
  /** Glyph for the tab chip (canvas atypes render `◳` in the tab regardless). */
  glyph: string;
  /**
   * True when a run may hold MULTIPLE of this atype, one per source entity
   * (identity keyed by `(run_id, atype, source_ref)` instead of `(run_id,
   * atype)`) — the multi-idea planner batch mints one `idea-spec` AND one
   * `arch-design` per owned idea.
   */
  perEntity: boolean;
}

/**
 * THE registry. Insertion order defines {@link REPORTABLE_ARTIFACT_ATYPES}'s
 * order (and thus the report-tool enum's), so keep the reportable atypes in the
 * order the MCP tool has historically advertised them.
 */
export const ARTIFACT_POLICIES: Record<ArtifactType, ArtifactPolicy> = {
  'idea-spec': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    reportable: true,
    color: '#3b6dd6',
    glyph: '▤',
    perEntity: true,
  },
  'decomposed-stories': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    reportable: true,
    color: '#5a4ad6',
    glyph: '☰',
    perEntity: false,
  },
  screenshots: {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    // screenshots DO carry bytes, but via the fileNames path in
    // requiredBytePaths — not the always-canonical prototype/index.html byte.
    requiresPrototypeBytes: false,
    reportable: true,
    color: '#2d8a5b',
    glyph: '▦',
    perEntity: false,
  },
  'ui-prototype': {
    renderMode: 'canvas',
    canvasKind: 'static-srcdoc',
    htmlLoadable: true,
    csp: ARTIFACT_PROTOTYPE_CSP,
    blessing: 'prototype-file',
    requiresPrototypeBytes: true,
    reportable: true,
    color: '#c96442',
    glyph: '◳',
    perEntity: false,
  },
  generic: {
    renderMode: 'canvas',
    canvasKind: 'static-srcdoc',
    htmlLoadable: true,
    csp: ARTIFACT_PROTOTYPE_CSP,
    blessing: 'html-reject-only',
    // A url-only generic declares (and wants) no bytes; a fileName-bearing
    // generic's byte is picked up by requiredBytePaths' generic branch, not this
    // always-canonical flag.
    requiresPrototypeBytes: false,
    reportable: true,
    color: '#c96442',
    glyph: '◳',
    perEntity: false,
  },
  'interactive-prototype': {
    renderMode: 'canvas',
    canvasKind: 'interactive-oopif',
    htmlLoadable: true,
    csp: ARTIFACT_INTERACTIVE_CSP,
    // Same blessing as ui-prototype: reject inline html + validate + mint the
    // canonical prototype/index.html pointer.
    blessing: 'prototype-file',
    requiresPrototypeBytes: true,
    reportable: true,
    // A rust in the ui-prototype family (#c96442) but distinct so the JS-enabled
    // canvas reads as its own kind of surface.
    color: '#b5502e',
    glyph: '◱',
    perEntity: false,
  },
  'arch-design': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    // Auto-mint-only (derived from the idea body's '## Architecture design').
    reportable: false,
    color: '#2d7a8a',
    glyph: '▣',
    perEntity: true,
  },
  'compound-recommendations': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    reportable: true,
    // Compound's phase color (the violet used in the run rail) so the
    // recommendations tab reads as part of the Compound flow.
    color: '#8b5cf6',
    glyph: '▧',
    perEntity: false,
  },
  'project-brief': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    reportable: true,
    // Launch's interview-phase blue so the brief tab reads as part of the
    // Launch flow.
    color: '#3b6dd6',
    glyph: '▣',
    perEntity: false,
  },
  'approve-ideas': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    reportable: true,
    color: '#b8860b',
    glyph: '☑',
    perEntity: false,
  },
  'approve-designs': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    // Auto-created gate surface (the design-approval sibling of approve-ideas).
    reportable: false,
    // An approval gold tilted toward arch-design's teal (#2d7a8a) so the joint
    // design gate reads as "approve the architecture designs".
    color: '#8a7326',
    glyph: '⊡',
    perEntity: false,
  },
  'eval-report': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    // System-minted by EvalWorker for run_evals rows with origin='adhoc' — an
    // agent report would bypass the eval pipeline entirely.
    reportable: false,
    // Amber — the quality/score register, distinct from every other accent so an
    // eval report never reads as a planner or compound deliverable.
    color: '#f59e0b',
    glyph: '◎',
    perEntity: false,
  },
  // Appended LAST so every historically-advertised reportable atype keeps its
  // position in REPORTABLE_ARTIFACT_ATYPES (and thus in the MCP tool's enum).
  'verify-runbook': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    reportable: true,
    // Teal, the verification register — adjacent to arch-design's #2d7a8a
    // (both are "here is the shape of the thing before you approve it") but
    // greener, and deliberately nowhere near compound's violet.
    color: '#1f8f7a',
    glyph: '▨',
    perEntity: false,
  },
  'idea-summary': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    // Auto-mint-only (orchestrator-derived hub summarizing the idea component
    // ledger + links to sibling deliverables) — an agent report would arrive
    // with no source_ref/ledger context and render broken, mirroring
    // arch-design/approve-designs.
    reportable: false,
    // Neutral gray — deliberately NOT one of the deliverable accents (blue/
    // indigo/teal/rust/violet/amber/gold above): this tab is a HUB pointing at
    // those deliverables, not a deliverable itself, so it reads as its own
    // kind of (meta) surface.
    color: '#6b6b6b',
    glyph: '◈',
    perEntity: true,
  },
  // Appended LAST (see verify-runbook's note above) so every historically
  // advertised reportable atype keeps its position in REPORTABLE_ARTIFACT_ATYPES,
  // and thus in the MCP report tool's enum.
  'adversarial-review': {
    renderMode: 'template',
    canvasKind: null,
    htmlLoadable: false,
    csp: null,
    blessing: 'none',
    requiresPrototypeBytes: false,
    // Agent-reported, unlike the auto-minted gate surfaces: the step agent
    // composes the doc from its subagent's `## Result` and reports it, which is
    // the ONLY channel by which the approve-design gate and a later Revise can
    // see what the reviewer said (every step is a fresh turn with no memory).
    reportable: true,
    // Rose — the critique register. Deliberately apart from every deliverable
    // accent (blue/indigo/teal/rust/violet/amber/gold) and from eval-report's
    // amber: this tab is an argument ABOUT the deliverables, not one of them.
    color: '#c2415f',
    glyph: '⚑',
    // ONE critique per run covering the whole design surface — not per idea.
    perEntity: false,
  },
};

/** Registry entries as a typed array — the derivation source for the legacy maps. */
const ARTIFACT_POLICY_ENTRIES = Object.entries(ARTIFACT_POLICIES) as [ArtifactType, ArtifactPolicy][];

/**
 * Render mode per atype — DERIVED from {@link ARTIFACT_POLICIES}. Kept as its
 * own exported `Record<ArtifactType, ArtifactRenderMode>` (same name/shape as
 * before the registry) so the router's `VALID_ATYPES` derivation and every other
 * consumer compile unchanged.
 */
export const ARTIFACT_RENDER_MODE: Record<ArtifactType, ArtifactRenderMode> = Object.fromEntries(
  ARTIFACT_POLICY_ENTRIES.map(([atype, p]) => [atype, p.renderMode]),
) as Record<ArtifactType, ArtifactRenderMode>;

/**
 * Accent ("edge") color per atype — DERIVED from {@link ARTIFACT_POLICIES}.
 * Drives the active tab's top border, the tab label, and the artifact chip. The
 * M7 polish pass migrates these to `var(--cf-*)` tokens once the tokens exist.
 */
export const ARTIFACT_COLORS: Record<ArtifactType, string> = Object.fromEntries(
  ARTIFACT_POLICY_ENTRIES.map(([atype, p]) => [atype, p.color]),
) as Record<ArtifactType, string>;

/**
 * Glyph per atype — DERIVED from {@link ARTIFACT_POLICIES}. Live canvases
 * (`mode: 'canvas'`) render the `◳` glyph in the tab regardless of this map;
 * these are the templated/chip glyphs.
 */
export const ARTIFACT_GLYPHS: Record<ArtifactType, string> = Object.fromEntries(
  ARTIFACT_POLICY_ENTRIES.map(([atype, p]) => [atype, p.glyph]),
) as Record<ArtifactType, string>;

/** True when the artifact renders in an embedded live canvas (not a template). */
export function isCanvasArtifact(atype: ArtifactType): boolean {
  return ARTIFACT_RENDER_MODE[atype] === 'canvas';
}

/**
 * Atypes that are NOT one-per-(run, atype): a single run may hold MULTIPLE
 * artifacts of this kind, one per source entity (source_ref) — DERIVED from the
 * `perEntity` flag in {@link ARTIFACT_POLICIES}. The multi-idea planner batch
 * mints one 'idea-spec' AND one 'arch-design' per seeded/owned idea, so both
 * have identity (run_id, atype, source_ref) — see migrations 063 (idea-spec) and
 * 073 (arch-design). Every OTHER atype keeps the strict one-per-(run, atype) rule.
 *
 * The registry is the SINGLE HOME for the "per-entity" decision — the
 * ArtifactRouter create-identity (main-side) and the center-pane tab id
 * (frontend) both key off this set, so the split rule can never disagree across
 * the two layers.
 */
export const PER_ENTITY_ARTIFACT_ATYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>(
  ARTIFACT_POLICY_ENTRIES.filter(([, p]) => p.perEntity).map(([atype]) => atype),
);

/** True when a run may hold several of this atype (identity keyed by source_ref). */
export function isPerEntityArtifact(atype: ArtifactType): boolean {
  return PER_ENTITY_ARTIFACT_ATYPES.has(atype);
}

/**
 * The `payload_json` a per-entity atype carries when a MULTI-IDEA batch collapsed
 * its N per-idea tabs into ONE combined, run-scoped tab (idea-spec's "Idea specs
 * · N ideas", idea-summary's "Idea summaries · N ideas").
 *
 * Such a row's `source_ref` is an IDENTITY ANCHOR ONLY — the batch's first owned
 * idea, chosen so the (run_id, atype, source_ref) UPSERT adopts the row minted
 * while the batch was still size 1 rather than orphaning it. It is NOT the data
 * source: the renderer re-derives the whole batch from the run.
 *
 * Both ends live here so the writer (orchestrator auto-mint) and the reader
 * (useArtifactData / ArtifactTabRenderer) can never disagree on the marker.
 */
export const COMBINED_BATCH_PAYLOAD_JSON = JSON.stringify({ combined: true });

/**
 * True when a `payload_json` carries the combined-batch marker above. Tolerant of
 * null/empty/invalid JSON (a payload is per-atype and free-form), which all read
 * as "not combined".
 */
export function isCombinedBatchArtifact(payloadJson: string | null | undefined): boolean {
  if (!payloadJson) return false;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['combined'] === true
    );
  } catch {
    return false;
  }
}

/**
 * The atypes an agent may report via `cyboflow_report_artifact` — DERIVED from
 * the `reportable` flag, in registry insertion order. The MCP tool's schema enum
 * and its CallTool `validAtypes` guard both read this ONE list, so a new
 * reportable atype (interactive-prototype) is accepted the moment its policy
 * says so — no parallel hand-maintained enum to forget (the omission that once
 * made `compound-recommendations` render a broken empty canvas).
 */
export const REPORTABLE_ARTIFACT_ATYPES: ArtifactType[] = ARTIFACT_POLICY_ENTRIES.filter(
  ([, p]) => p.reportable,
).map(([atype]) => atype);

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
export const ARCH_DESIGN_HEADING_LINE_RE = new RegExp(
  `^##[ \\t]+${ARCH_DESIGN_SECTION_HEADING}[ \\t]*$`,
  'i',
);

/**
 * An H2 line (or a bare '##' empty ATX heading) — terminates the section.
 * Exported so validators of agent-produced sections (revisionWorker) use the
 * EXACT delimiter grammar the extractor does — a delimiter this matches but a
 * validator misses is a section-boundary escape.
 */
export const H2_LINE_RE = /^##(?:[ \t]|$)/;

/**
 * Stateful fenced-code-block tracker shared by the section extractor, the
 * section replacer, and agent-output validators (revisionWorker) — ONE fence
 * grammar so a document one of them accepts can never be mis-parsed by another.
 *
 * CommonMark-ish pairing (the part that matters for section boundaries): a
 * fence opens on ``` or ~~~ (3+ run, ≤3 leading spaces, optional info string)
 * and closes ONLY on a matching marker — same character, run length ≥ the
 * opener's, nothing but whitespace after. A non-matching marker line inside an
 * open fence is CONTENT (the naive toggle this replaces treated it as a close,
 * so a ``` fence "closed" by ~~~ silently swallowed everything after it).
 */
export interface FenceState {
  /** Feed one line; returns true when the line IS a fence delimiter (open or close). */
  handleLine(line: string): boolean;
  /** True while inside an open fence (after feeding the opener, before a matching closer). */
  inFence(): boolean;
}

export function makeFenceState(): FenceState {
  let open: { char: string; len: number } | null = null;
  return {
    handleLine(line: string): boolean {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) return false;
      const marker = m[1];
      const char = marker[0];
      if (open === null) {
        // CommonMark: a BACKTICK fence is not recognized when its info string
        // contains a backtick (it reads as inline code instead). Treating such
        // a line as an opener would swallow everything to EOF once no matching
        // closer exists. Tilde-fence info strings have no such restriction.
        if (char === '`' && m[2].includes('`')) return false;
        open = { char, len: marker.length };
        return true;
      }
      // A closing fence must match the opener's char, be at least as long, and
      // carry no info string. Anything else is fence CONTENT.
      if (char === open.char && marker.length >= open.len && m[2].trim().length === 0) {
        open = null;
        return true;
      }
      return false;
    },
    inFence(): boolean {
      return open !== null;
    },
  };
}

/**
 * Extract the section delimited by `headingLineRe` from a markdown body:
 * everything after the heading line up to (not including) the next H2 line or
 * EOF, trimmed. Line-based and fenced-code-block-aware, so '## '-prefixed
 * lines inside ``` fences neither start nor terminate a section. When the body
 * carries MORE than one such heading (e.g. a revise round appended a fresh
 * section instead of replacing), the LAST section wins — it is the freshest
 * fold. Returns null when the body is empty, the heading is absent, or the
 * section has no content.
 *
 * The generalized engine behind {@link extractArchDesignSection} and
 * {@link extractDesignSpecSection} — ONE fence-aware scan shared by every
 * heading-delimited section extractor, keyed by the caller's `headingLineRe`.
 */
export function extractSection(body: string | null | undefined, headingLineRe: RegExp): string | null {
  if (!body) return null;
  const lines = body.split(/\r?\n/);

  const fence = makeFenceState();
  let sectionStart = -1; // line index AFTER the most recent heading match
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence.handleLine(line)) continue;
    if (fence.inFence()) continue;
    if (headingLineRe.test(line)) {
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
 * Byte-preserving inverse-companion of {@link extractSection}: replace the
 * WHOLE section delimited by `headingLineRe` — the heading line through the
 * same next-H2-or-EOF boundary extract uses, and the same "last heading wins"
 * choice — with `newSection`, leaving every other byte of `body` untouched.
 * When no such section exists, `newSection` is appended after a blank-line
 * separator (the body's existing bytes are never rewritten).
 *
 * `newSection` is expected to be a COMPLETE section that begins with its own
 * heading line matching `headingLineRe` (what the producing agent emits, and
 * what the append path needs to produce a re-extractable section). The
 * original section's trailing blank-line run is preserved after the splice so
 * the following H2 stays visually separated.
 *
 * Round-trip: `extractSection(replaceSection(body, headingLineRe, s), headingLineRe)`
 * equals `extractSection(s, headingLineRe)` — the content of `s` after its
 * heading, trimmed the same way extract trims — for any `s` that carries the
 * heading line.
 *
 * The generalized engine behind {@link replaceArchDesignSection} and
 * {@link replaceDesignSpecSection}.
 */
export function replaceSection(
  body: string | null | undefined,
  headingLineRe: RegExp,
  newSection: string,
): string {
  const base = body ?? '';
  const lines = base.split(/\r?\n/);

  // Re-run the exact scan extractSection uses to locate the span, but keep the
  // heading LINE index (sectionStart - 1) so the whole section is swapped.
  const fence = makeFenceState();
  let sectionStart = -1; // line index AFTER the most recent heading match
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence.handleLine(line)) continue;
    if (fence.inFence()) continue;
    if (headingLineRe.test(line)) {
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
 * Extract the '## Architecture design' section from an idea body. Thin
 * wrapper around {@link extractSection} bound to
 * {@link ARCH_DESIGN_HEADING_LINE_RE} — kept as its own named export because
 * callers (autoMintArtifacts, revisionWorker, the frontend renderer) reference
 * it directly; behavior is identical to the pre-generalization implementation.
 */
export function extractArchDesignSection(body: string | null | undefined): string | null {
  return extractSection(body, ARCH_DESIGN_HEADING_LINE_RE);
}

/**
 * Replace the '## Architecture design' section of an idea body. Thin wrapper
 * around {@link replaceSection} bound to {@link ARCH_DESIGN_HEADING_LINE_RE} —
 * kept as its own named export (see {@link extractArchDesignSection}); the
 * exported signature (`body, newSection` — no `headingLineRe` param) is
 * unchanged from the pre-generalization implementation so existing call sites
 * need no updates.
 */
export function replaceArchDesignSection(body: string | null | undefined, newSection: string): string {
  return replaceSection(body, ARCH_DESIGN_HEADING_LINE_RE, newSection);
}

// ===========================================================================
// design-spec — the templated design-spec section extractor (Design Mode v0).
//
// The design-spec draft (see docs/ideas/design-mode.md "Design-spec draft")
// is folded into the linked idea's body under a '## Design spec' H2 by the
// Approve state machine (design-mode.md "Approve" Step 2), using the SAME
// fence-aware, last-heading-wins section grammar as arch-design so the two
// sections can coexist in one body without either replacer reaching into the
// other's content (H2_LINE_RE terminates each at the other's heading).
// ===========================================================================

/** The H2 heading text that delimits the design-spec section. */
export const DESIGN_SPEC_SECTION_HEADING = 'Design spec';

/**
 * Matches the '## Design spec' heading as a single LINE (case-insensitive;
 * tolerates trailing whitespace). Deliberately uses `[ \t]` — never `\s`,
 * which spans newlines and lets a bare '##' line plus a later 'Design spec'
 * text line spoof the heading.
 */
export const DESIGN_SPEC_HEADING_LINE_RE = new RegExp(
  `^##[ \\t]+${DESIGN_SPEC_SECTION_HEADING}[ \\t]*$`,
  'i',
);

/**
 * Extract the '## Design spec' section from an idea body. Thin wrapper around
 * {@link extractSection} bound to {@link DESIGN_SPEC_HEADING_LINE_RE} — see
 * {@link extractArchDesignSection} for the shared grammar this rides on.
 */
export function extractDesignSpecSection(body: string | null | undefined): string | null {
  return extractSection(body, DESIGN_SPEC_HEADING_LINE_RE);
}

/**
 * Replace the '## Design spec' section of an idea body. Thin wrapper around
 * {@link replaceSection} bound to {@link DESIGN_SPEC_HEADING_LINE_RE} — see
 * {@link replaceArchDesignSection} for the shared grammar this rides on.
 */
export function replaceDesignSpecSection(body: string | null | undefined, newSection: string): string {
  return replaceSection(body, DESIGN_SPEC_HEADING_LINE_RE, newSection);
}

// ===========================================================================
// idea-spec — the templated idea-spec section extractor.
//
// The 'idea-spec' artifact re-derives its content on READ from the
// originating idea's markdown `body` — specifically the '## Idea spec' H2
// section, using the SAME fence-aware, last-heading-wins section grammar as
// arch-design/design-spec so all three can coexist in one body without
// reaching into each other's content (H2_LINE_RE terminates each at the
// others' headings). Unlike arch-design, nothing REPLACES this section
// through this path, so there is no replaceIdeaSpecSection wrapper.
// ===========================================================================

/** The H2 heading text that delimits the idea-spec section. */
export const IDEA_SPEC_SECTION_HEADING = 'Idea spec';

/**
 * Matches the '## Idea spec' heading as a single LINE (case-insensitive;
 * tolerates trailing whitespace). Deliberately uses `[ \t]` — never `\s`,
 * which spans newlines and lets a bare '##' line plus a later 'Idea spec'
 * text line spoof the heading.
 */
export const IDEA_SPEC_HEADING_LINE_RE = new RegExp(`^##[ \\t]+${IDEA_SPEC_SECTION_HEADING}[ \\t]*$`, 'i');

/**
 * Extract the '## Idea spec' section from an idea body. Thin wrapper around
 * {@link extractSection} bound to {@link IDEA_SPEC_HEADING_LINE_RE} — see
 * {@link extractArchDesignSection} for the shared grammar this rides on.
 */
export function extractIdeaSpecSection(body: string | null | undefined): string | null {
  return extractSection(body, IDEA_SPEC_HEADING_LINE_RE);
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

/**
 * The canvas atypes the `artifacts:load-html` / `artifacts:open-in-browser` IPC
 * channels can source HTML for. This literal union is the compile-time mirror of
 * the registry's `htmlLoadable: true` policies (ui-prototype, generic,
 * interactive-prototype); {@link isHtmlLoadableAtype} is the runtime narrowing
 * that consults {@link ARTIFACT_POLICIES}, so the two can never disagree.
 */
export type LoadArtifactHtmlAtype = 'ui-prototype' | 'generic' | 'interactive-prototype';

/**
 * Narrow an untrusted atype string to a {@link LoadArtifactHtmlAtype} by
 * consulting the registry's `htmlLoadable` flag — the SINGLE runtime authority
 * on "may the HTML loader source bytes for this atype". Used by the
 * `artifacts:load-html` / `artifacts:open-in-browser` handlers instead of a
 * hand-written atype allowlist.
 */
export function isHtmlLoadableAtype(atype: string): atype is LoadArtifactHtmlAtype {
  return (
    Object.prototype.hasOwnProperty.call(ARTIFACT_POLICIES, atype) &&
    ARTIFACT_POLICIES[atype as ArtifactType].htmlLoadable
  );
}

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
 * Request/response shapes for the `artifacts:open-in-browser` IPC channel —
 * opens the canonical prototype HTML in the user's default browser (a temp-file
 * copy of the RAW document, no CSP meta: outside the sandboxed in-app iframe
 * the user is deliberately opening their own local file). SHARED for the same
 * anti-drift reason as the load-html shapes above.
 */
export interface OpenArtifactHtmlExternalRequest {
  runId: string;
  atype: LoadArtifactHtmlAtype;
}

export interface OpenArtifactHtmlExternalResult {
  opened: boolean;
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
  /**
   * Monotonic content-revision counter (migration 082). Starts at 1 on create
   * and bumps by 1 on every enrich-in-place update that changes a field (a
   * no-op re-report does NOT bump). This is the CAS material the Design Mode
   * design-spec draft binds against — Approve rejects a draft whose bound
   * revision no longer equals the prototype artifact's CURRENT revision
   * (design-mode.md "Design-spec draft"). OPTIONAL in the API shape: a
   * committed SNAPSHOT-sourced artifact (past the design-session mutation
   * window) carries no live counter, so `snapshotManifestToArtifact` leaves it
   * unset — the CAS always reads the live `artifacts.revision` column directly,
   * never this field.
   */
  revision?: number;
}

/**
 * One task's verification-agent report entry (verification-agent redesign §5.9),
 * folded into `ScreenshotsArtifactPayload.reports`. Denormalizes the composed
 * task's `summary` + each behavior's `description`/`expected` alongside the
 * agent's per-behavior `result`/evidence — so the screenshots tab's "Behaviors
 * tested" table renders self-contained rows without re-fetching the task. Keyed
 * for merge identity by `(taskRef, requestId)`; `attempt` disambiguates repeated
 * verification of the same lane after a loopback.
 */
export interface TaskVerificationReportEntry {
  /** The lane this report belongs to, or null for a non-lane-attributed request. */
  taskRef: string | null;
  /** Disambiguates; part of the merge identity alongside `taskRef`. */
  requestId: string;
  attempt: number;
  /** The composed task's summary. */
  summary: string;
  behaviors: Array<{
    id: string;
    description: string;
    expected: string;
    result: 'pass' | 'fail' | 'not_testable';
    screenshots: string[];
    notes: string;
  }>;
  outcome: VerificationReportV1['outcome'];
  completedAt: string;
  /**
   * The harness-captured verifier transcript file (bare basename in the run
   * artifacts dir), present when a transcript was written for this request;
   * absent for legacy reports or a request whose engine produced none. The
   * filename is DETERMINISTIC (see {@link verifyTranscriptFileName}) — never
   * persisted, always re-derived from `requestId` at read time.
   */
  transcriptFileName?: string;
}

/**
 * Deterministic transcript filename for a verification request, keyed by
 * `requestId`. Pure by design: the runner (writer, at request-completion time)
 * and the verdict-delivery chokepoint (reader — including a boot replay that
 * never saw the live request) must agree on the filename WITHOUT persisting it
 * anywhere, so both sides call this same function.
 */
export function verifyTranscriptFileName(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `transcript-${safe.length > 0 ? safe : 'unknown'}.md`;
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
   * Per-task verification-agent reports (verification-agent redesign §5.9),
   * ATOMICALLY merged in by the ArtifactRouter merge operation, keyed by
   * `(taskRef, requestId)` — the latest attempt per lane wins for the banner;
   * older entries are retained (bounded, newest-N) for report history. Absent
   * until at least one agent-engine report has been delivered.
   */
  reports?: TaskVerificationReportEntry[];
  /**
   * HUMAN-FACING capture provenance (S9): how the judged deliverable was stood up
   * ('dev-server' | 'static-server' | 'url' | 'file' | 'agent'). Written by the
   * verdict-delivery hook alongside the verdict; absent for pre-S9 rows.
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
  /**
   * sha256 (hex) of the on-disk document at report time, minted by the
   * content-blesser alongside `fileName`. Exists so the stored payload — and
   * therefore the ArtifactRouter's delta-gated `revision` counter — changes
   * when the prototype's BYTES change even though the pointer is constant
   * (an in-place edit + re-report must advance the revision the design-spec
   * draft binding and feedback ack record). Absent on rows minted before
   * this field existed and on the bytes-less re-entry stub.
   */
  contentHash?: string;
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
 * The parsed `payload_json` shape of an `eval-report` artifact — the ad-hoc
 * code-review eval's FULL verdict (overall score/band/CI, per-dimension rows,
 * cap/security/requirements/gate flags, jury findings), composed by EvalWorker
 * when it completes a `run_evals` row with `origin='adhoc'`.
 *
 * Payload-backed exactly like {@link RecommendationsArtifactPayload}: there is no
 * entity source, so the renderer reads the markdown straight from the payload (no
 * fetch, no source_ref). Identity is one-per-(run, atype), so a re-eval UPSERTs
 * the newest verdict over the previous one. Extra keys are tolerated.
 */
export interface EvalReportPayload {
  /** The full verdict report, rendered through MarkdownPreview. */
  markdown?: string;
  [key: string]: unknown;
}

/**
 * The parsed `payload_json` shape of a `verify-runbook` artifact — the
 * verify-setup flow's runbook PROPOSAL: per modality the build/serve commands
 * and the attestation channel, the rung ladder of repo changes it wants, the
 * risks, and (after the prove step) the per-modality proof outcome.
 *
 * Payload-backed exactly like {@link RecommendationsArtifactPayload}: the setup
 * orchestrator composes the doc and reports it verbatim in `markdown`, so the
 * renderer reads it straight from the payload with no fetch and no source_ref.
 * One per run, ENRICHED in place — the same artifact the approve-runbook gate
 * reviewed later carries the proof outcomes, so the human's review surface and
 * the record of what happened to it are the same document.
 */
export interface VerifyRunbookArtifactPayload {
  /** The full proposal doc, rendered through MarkdownPreview. */
  markdown?: string;
  [key: string]: unknown;
}

/**
 * Parsed `payload_json` shape of an `adversarial-review` artifact — the
 * Launch/Planner/Ship adversarial reviewer's critique as ONE markdown doc
 * (`## Blocking` / `## Findings`, each entry under its `#### AR-n` heading).
 * Payload-backed exactly like {@link VerifyRunbookArtifactPayload}: the step
 * agent composes the doc from the reviewer's `## Result` and reports it
 * verbatim in `markdown`; one per run, ENRICHED on a post-Revise re-review.
 * The approve-design gate summarises it and Approve logs its entries as
 * accepted-risk findings (see main/src/orchestrator/gateSideEffects.ts);
 * `parseAdversarialReviewDoc` (shared/types/adversarialReview.ts) reads it.
 */
export interface AdversarialReviewArtifactPayload {
  /** The full critique doc, rendered through MarkdownPreview. */
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
