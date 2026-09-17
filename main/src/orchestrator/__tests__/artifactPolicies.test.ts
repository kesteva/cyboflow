/**
 * Regression pins for the canonical artifact-policy registry
 * (shared/types/artifacts.ts — Design Mode v1 "Canvas v1 — artifact-policy
 * registry"). The registry is the SINGLE source every atype-special-casing seam
 * derives from; these tests lock in that:
 *   1. every ArtifactType has a policy entry (exhaustiveness is compiler-forced,
 *      but this catches a runtime hole too);
 *   2. the DERIVED legacy maps (ARTIFACT_RENDER_MODE / ARTIFACT_COLORS /
 *      ARTIFACT_GLYPHS / PER_ENTITY_ARTIFACT_ATYPES) reproduce EXACTLY the
 *      pre-registry literal values for every OLD atype — so the refactor from
 *      hand-maintained maps to derivations changed no observable value;
 *   3. the new interactive-prototype policy carries the intended flags;
 *   4. the reportable / html-loadable / CSP derivations are correct.
 */
import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_POLICIES,
  ARTIFACT_RENDER_MODE,
  ARTIFACT_COLORS,
  ARTIFACT_GLYPHS,
  PER_ENTITY_ARTIFACT_ATYPES,
  REPORTABLE_ARTIFACT_ATYPES,
  ARTIFACT_PROTOTYPE_CSP,
  ARTIFACT_INTERACTIVE_CSP,
  isHtmlLoadableAtype,
  isCanvasArtifact,
  isPerEntityArtifact,
  type ArtifactType,
} from '../../../../shared/types/artifacts';

// The pre-registry literal maps, transcribed verbatim from the maps the registry
// replaced. If the derivation ever drifts from these, a real UI value moved.
const LEGACY_RENDER_MODE: Record<ArtifactType, 'template' | 'canvas'> = {
  'idea-spec': 'template',
  'decomposed-stories': 'template',
  screenshots: 'template',
  'ui-prototype': 'canvas',
  generic: 'canvas',
  'interactive-prototype': 'canvas',
  'arch-design': 'template',
  'compound-recommendations': 'template',
  'project-brief': 'template',
  'approve-ideas': 'template',
  'approve-designs': 'template',
  'eval-report': 'template',
  'verify-runbook': 'template',
  'idea-summary': 'template',
  'adversarial-review': 'template',
};
const LEGACY_COLORS: Record<ArtifactType, string> = {
  'idea-spec': '#3b6dd6',
  'decomposed-stories': '#5a4ad6',
  screenshots: '#2d8a5b',
  'ui-prototype': '#c96442',
  generic: '#c96442',
  'interactive-prototype': '#b5502e',
  'arch-design': '#2d7a8a',
  'compound-recommendations': '#8b5cf6',
  'project-brief': '#3b6dd6',
  'approve-ideas': '#b8860b',
  'approve-designs': '#8a7326',
  'eval-report': '#f59e0b',
  'verify-runbook': '#1f8f7a',
  'idea-summary': '#6b6b6b',
  'adversarial-review': '#c2415f',
};
const LEGACY_GLYPHS: Record<ArtifactType, string> = {
  'idea-spec': '▤',
  'decomposed-stories': '☰',
  screenshots: '▦',
  'ui-prototype': '◳',
  generic: '◳',
  'interactive-prototype': '◱',
  'arch-design': '▣',
  'compound-recommendations': '▧',
  'project-brief': '▣',
  'approve-ideas': '☑',
  'approve-designs': '⊡',
  'eval-report': '◎',
  'verify-runbook': '▨',
  'idea-summary': '◈',
  'adversarial-review': '⚑',
};

const ALL_ATYPES = Object.keys(LEGACY_RENDER_MODE) as ArtifactType[];

describe('ARTIFACT_POLICIES registry', () => {
  it('has a policy entry for every ArtifactType', () => {
    for (const atype of ALL_ATYPES) {
      expect(ARTIFACT_POLICIES[atype]).toBeDefined();
    }
    // No stray extra keys.
    expect(Object.keys(ARTIFACT_POLICIES).sort()).toEqual([...ALL_ATYPES].sort());
  });

  it('derives ARTIFACT_RENDER_MODE identically to the pre-registry literal', () => {
    expect(ARTIFACT_RENDER_MODE).toEqual(LEGACY_RENDER_MODE);
    for (const atype of ALL_ATYPES) {
      expect(isCanvasArtifact(atype)).toBe(LEGACY_RENDER_MODE[atype] === 'canvas');
    }
  });

  it('derives ARTIFACT_COLORS identically to the pre-registry literal', () => {
    expect(ARTIFACT_COLORS).toEqual(LEGACY_COLORS);
  });

  it('derives ARTIFACT_GLYPHS identically to the pre-registry literal', () => {
    expect(ARTIFACT_GLYPHS).toEqual(LEGACY_GLYPHS);
  });

  it('derives PER_ENTITY_ARTIFACT_ATYPES as exactly {idea-spec, arch-design, idea-summary}', () => {
    expect([...PER_ENTITY_ARTIFACT_ATYPES].sort()).toEqual(['arch-design', 'idea-spec', 'idea-summary']);
    expect(isPerEntityArtifact('idea-spec')).toBe(true);
    expect(isPerEntityArtifact('arch-design')).toBe(true);
    expect(isPerEntityArtifact('idea-summary')).toBe(true);
    expect(isPerEntityArtifact('interactive-prototype')).toBe(false);
    expect(isPerEntityArtifact('ui-prototype')).toBe(false);
  });

  it('REPORTABLE_ARTIFACT_ATYPES excludes only the auto-mint-only atypes, in historical order + interactive-prototype + project-brief', () => {
    // The historical run-scope reportable list, with interactive-prototype and
    // project-brief added in their registry positions (right after generic,
    // and right after compound-recommendations, respectively).
    expect(REPORTABLE_ARTIFACT_ATYPES).toEqual([
      'idea-spec',
      'decomposed-stories',
      'screenshots',
      'ui-prototype',
      'generic',
      'interactive-prototype',
      'compound-recommendations',
      'project-brief',
      'approve-ideas',
      // Appended LAST (registry order) so every historically-advertised atype
      // keeps its position in the MCP report tool's enum.
      'verify-runbook',
      // Appended after verify-runbook for the same reason.
      'adversarial-review',
    ]);
    // arch-design / approve-designs are auto-mint-only (never agent-reportable);
    // eval-report is likewise system-minted only (EvalWorker); idea-summary is
    // likewise auto-mint-only (autoMintArtifacts).
    expect(REPORTABLE_ARTIFACT_ATYPES).not.toContain('arch-design');
    expect(REPORTABLE_ARTIFACT_ATYPES).not.toContain('approve-designs');
    expect(REPORTABLE_ARTIFACT_ATYPES).not.toContain('eval-report');
    expect(REPORTABLE_ARTIFACT_ATYPES).not.toContain('idea-summary');
    // reportable flag agrees with the derived list.
    for (const atype of ALL_ATYPES) {
      expect(ARTIFACT_POLICIES[atype].reportable).toBe(REPORTABLE_ARTIFACT_ATYPES.includes(atype));
    }
  });

  it('the interactive-prototype policy carries the intended v1 flags', () => {
    const p = ARTIFACT_POLICIES['interactive-prototype'];
    expect(p).toMatchObject({
      renderMode: 'canvas',
      canvasKind: 'interactive-oopif',
      htmlLoadable: true,
      csp: ARTIFACT_INTERACTIVE_CSP,
      blessing: 'prototype-file',
      requiresPrototypeBytes: true,
      reportable: true,
      perEntity: false,
    });
  });

  it('the idea-summary policy carries the intended hub flags (templated, per-entity, non-reportable)', () => {
    const p = ARTIFACT_POLICIES['idea-summary'];
    expect(p).toMatchObject({
      renderMode: 'template',
      canvasKind: null,
      htmlLoadable: false,
      csp: null,
      blessing: 'none',
      requiresPrototypeBytes: false,
      reportable: false,
      perEntity: true,
    });
  });

  it('ui-prototype and generic keep the static-srcdoc CSP; interactive gets the JS-enabled CSP', () => {
    expect(ARTIFACT_POLICIES['ui-prototype'].csp).toBe(ARTIFACT_PROTOTYPE_CSP);
    expect(ARTIFACT_POLICIES['generic'].csp).toBe(ARTIFACT_PROTOTYPE_CSP);
    expect(ARTIFACT_POLICIES['interactive-prototype'].csp).toBe(ARTIFACT_INTERACTIVE_CSP);
    // The interactive CSP allows inline scripts; the static one does not. BOTH
    // block all network egress (default-src 'none').
    expect(ARTIFACT_INTERACTIVE_CSP).toContain("script-src 'unsafe-inline'");
    expect(ARTIFACT_PROTOTYPE_CSP).not.toContain('script-src');
    expect(ARTIFACT_INTERACTIVE_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_PROTOTYPE_CSP).toContain("default-src 'none'");
  });

  it('isHtmlLoadableAtype consults the registry (3 canvas atypes true, everything else false)', () => {
    expect(isHtmlLoadableAtype('ui-prototype')).toBe(true);
    expect(isHtmlLoadableAtype('generic')).toBe(true);
    expect(isHtmlLoadableAtype('interactive-prototype')).toBe(true);
    expect(isHtmlLoadableAtype('screenshots')).toBe(false);
    expect(isHtmlLoadableAtype('idea-spec')).toBe(false);
    // Not-in-registry strings are rejected (no prototype-pollution false-positive).
    expect(isHtmlLoadableAtype('not-an-atype')).toBe(false);
    expect(isHtmlLoadableAtype('__proto__')).toBe(false);
    expect(isHtmlLoadableAtype('constructor')).toBe(false);
    for (const atype of ALL_ATYPES) {
      expect(isHtmlLoadableAtype(atype)).toBe(ARTIFACT_POLICIES[atype].htmlLoadable);
    }
  });
});
