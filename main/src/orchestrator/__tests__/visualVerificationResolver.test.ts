/**
 * Unit tests for visualVerificationResolver — the single resolution point for a
 * run's layered visual-verification posture (enabled? + type + live chain).
 *
 * Mirrors the substrateResolver / executionModelResolver test discipline: the
 * enablement override ladder (per-run > project > global > false floor), the
 * type override ladder with fail-soft fall-through to the floor, the chain
 * intersection against the host-available backends (MVP = only 'capturePage'),
 * and the disabled short-circuit. No real env / config is read — every input is
 * passed explicitly.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveVisualVerification,
  inferTypeFromDeliverable,
  DEFAULT_VERIFICATION_TYPE,
  MVP_AVAILABLE_BACKENDS,
} from '../visualVerificationResolver';
import { FALLBACK_CHAINS } from '../../../../shared/types/visualVerification';
import type { VerificationRequestInput } from '../../../../shared/types/visualVerification';

describe('resolveVisualVerification — disabled posture (zero-behavior-change floor)', () => {
  it('floors to disabled when no enablement level is set', () => {
    expect(resolveVisualVerification({})).toEqual({ enabled: false, type: null, chain: [] });
  });

  it('returns the disabled posture (no type, empty chain) when global is false', () => {
    expect(resolveVisualVerification({ globalDefaultEnabled: false })).toEqual({
      enabled: false,
      type: null,
      chain: [],
    });
  });

  it('ignores type inputs entirely when the run resolves disabled', () => {
    // A requested type must NOT turn a disabled run on (per design: a per-request
    // override only narrows within an enabled run, never enables one).
    expect(
      resolveVisualVerification({
        globalDefaultEnabled: false,
        requestedType: 'interactive-web-behavior',
      }),
    ).toEqual({ enabled: false, type: null, chain: [] });
  });
});

describe('resolveVisualVerification — enablement override ladder', () => {
  it('per-run override wins over every lower level', () => {
    // requested true beats project false beats global false.
    expect(
      resolveVisualVerification({
        requestedEnabled: true,
        projectConfigEnabled: false,
        globalDefaultEnabled: false,
      }).enabled,
    ).toBe(true);
  });

  it('a per-run explicit false opts OUT over an enabling lower level', () => {
    expect(
      resolveVisualVerification({
        requestedEnabled: false,
        projectConfigEnabled: true,
        globalDefaultEnabled: true,
      }).enabled,
    ).toBe(false);
  });

  it('project config wins when the per-run override is unset', () => {
    expect(
      resolveVisualVerification({
        projectConfigEnabled: true,
        globalDefaultEnabled: false,
      }).enabled,
    ).toBe(true);
  });

  it('global default wins when per-run and project are unset', () => {
    expect(resolveVisualVerification({ globalDefaultEnabled: true }).enabled).toBe(true);
  });

  it('null/undefined levels are unset and fall through (not treated as false)', () => {
    // requested null, project undefined → global true wins.
    expect(
      resolveVisualVerification({
        requestedEnabled: null,
        projectConfigEnabled: undefined,
        globalDefaultEnabled: true,
      }).enabled,
    ).toBe(true);
  });
});

describe('resolveVisualVerification — type override ladder (only when enabled)', () => {
  it("floors to the default type when enabled with no type set", () => {
    const r = resolveVisualVerification({ globalDefaultEnabled: true });
    expect(r.type).toBe(DEFAULT_VERIFICATION_TYPE);
    expect(DEFAULT_VERIFICATION_TYPE).toBe('static-render-snapshot');
  });

  it('requestedType wins over the project + global default types', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      requestedType: 'responsive-multi-viewport',
      projectConfigDefaultType: 'interactive-web-behavior',
      globalDefaultType: 'native-desktop',
      // Widen availability so the chain is non-empty and the type is exercised.
      availableBackends: ['capturePage', 'playwright', 'peekaboo'],
    });
    expect(r.type).toBe('responsive-multi-viewport');
  });

  it('project default wins when requestedType is unset', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      projectConfigDefaultType: 'interactive-web-behavior',
      globalDefaultType: 'native-desktop',
      availableBackends: ['capturePage', 'playwright', 'peekaboo'],
    });
    expect(r.type).toBe('interactive-web-behavior');
  });

  it('global default type wins when requested + project are unset', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      globalDefaultType: 'responsive-multi-viewport',
    });
    expect(r.type).toBe('responsive-multi-viewport');
  });

  it('skips an unrecognized type (fail-soft) and falls through to the next level', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      requestedType: 'not-a-real-type',
      projectConfigDefaultType: '',
      globalDefaultType: 'responsive-multi-viewport',
    });
    expect(r.type).toBe('responsive-multi-viewport');
  });

  it('floors to the default type when every type candidate is unrecognized', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      requestedType: 'bogus',
      globalDefaultType: 'also-bogus',
    });
    expect(r.type).toBe(DEFAULT_VERIFICATION_TYPE);
  });
});

describe('inferTypeFromDeliverable — type-ladder rung C', () => {
  it('infers interactive-web-behavior when the deliverable has interactions', () => {
    const d: VerificationRequestInput = {
      intent: 'click then check',
      url: 'http://localhost:5173',
      interactions: [{ action: 'click', target: '#go' }],
    };
    expect(inferTypeFromDeliverable(d)).toBe('interactive-web-behavior');
  });

  it('infers static-render-snapshot for a url with no interactions', () => {
    expect(inferTypeFromDeliverable({ intent: 'render', url: 'http://x' })).toBe(
      'static-render-snapshot',
    );
  });

  it('infers static-render-snapshot for an htmlPath with no interactions', () => {
    expect(inferTypeFromDeliverable({ intent: 'render', htmlPath: '/tmp/out.html' })).toBe(
      'static-render-snapshot',
    );
  });

  it('treats an empty interactions array as no interactions (falls to url-only static)', () => {
    expect(inferTypeFromDeliverable({ intent: 'r', url: 'http://x', interactions: [] })).toBe(
      'static-render-snapshot',
    );
  });

  it('returns null for a deliverable with neither url/html nor interactions', () => {
    expect(inferTypeFromDeliverable({ intent: 'nothing actionable' })).toBeNull();
  });

  it('returns null for an absent deliverable (skips the rung)', () => {
    expect(inferTypeFromDeliverable(null)).toBeNull();
    expect(inferTypeFromDeliverable(undefined)).toBeNull();
  });

  it('never infers native-desktop or mobile-flow (those require explicit declaration)', () => {
    // No deliverable shape can yield those types — they are explicit-only.
    expect(inferTypeFromDeliverable({ intent: 'app', interactions: [{ action: 'click' }] })).toBe(
      'interactive-web-behavior',
    );
    expect(inferTypeFromDeliverable({ intent: 'app', url: 'http://x' })).toBe(
      'static-render-snapshot',
    );
  });
});

describe('resolveVisualVerification — type-ladder rung C (infer-from-deliverable) precedence', () => {
  it('uses the inferred type when no requested/project type is set (interactions => interactive)', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      deliverable: { intent: 'i', url: 'http://x', interactions: [{ action: 'click' }] },
      availableBackends: ['capturePage', 'playwright', 'peekaboo'],
    });
    expect(r.type).toBe('interactive-web-behavior');
  });

  it('uses the inferred type when no requested/project type is set (url-only => static)', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      deliverable: { intent: 'i', url: 'http://x' },
    });
    expect(r.type).toBe('static-render-snapshot');
  });

  it('inference beats the global default type (rung C sits ABOVE global)', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      deliverable: { intent: 'i', url: 'http://x', interactions: [{ action: 'click' }] },
      globalDefaultType: 'responsive-multi-viewport',
      availableBackends: ['capturePage', 'playwright', 'peekaboo'],
    });
    expect(r.type).toBe('interactive-web-behavior');
  });

  it('requestedType still beats inference', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      requestedType: 'responsive-multi-viewport',
      deliverable: { intent: 'i', url: 'http://x', interactions: [{ action: 'click' }] },
      availableBackends: ['capturePage', 'playwright', 'peekaboo'],
    });
    expect(r.type).toBe('responsive-multi-viewport');
  });

  it('projectConfigDefaultType beats inference (rung C sits BELOW project default)', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      projectConfigDefaultType: 'responsive-multi-viewport',
      deliverable: { intent: 'i', url: 'http://x', interactions: [{ action: 'click' }] },
      availableBackends: ['capturePage', 'playwright', 'peekaboo'],
    });
    expect(r.type).toBe('responsive-multi-viewport');
  });

  it('an empty deliverable falls through inference to the global default, then the floor', () => {
    // No url/html/interactions => inference returns null; global default wins.
    const withGlobal = resolveVisualVerification({
      globalDefaultEnabled: true,
      deliverable: { intent: 'nothing' },
      globalDefaultType: 'responsive-multi-viewport',
    });
    expect(withGlobal.type).toBe('responsive-multi-viewport');

    // No global either => floor.
    const floored = resolveVisualVerification({
      globalDefaultEnabled: true,
      deliverable: { intent: 'nothing' },
    });
    expect(floored.type).toBe(DEFAULT_VERIFICATION_TYPE);
  });
});

describe('resolveVisualVerification — chain intersection with host-available backends', () => {
  it("defaults to MVP availability (only 'capturePage') and collapses a render chain to it", () => {
    expect(MVP_AVAILABLE_BACKENDS).toEqual(['capturePage']);
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      globalDefaultType: 'static-render-snapshot',
    });
    expect(r.chain).toEqual(['capturePage']);
  });

  it('yields an EMPTY chain for a type whose backends are all unavailable in the MVP', () => {
    // interactive-web-behavior chain is ['playwright','peekaboo'] — neither is in
    // the MVP available set, so the intersection is empty (scheduler will SKIP).
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      globalDefaultType: 'interactive-web-behavior',
    });
    expect(r.enabled).toBe(true);
    expect(r.type).toBe('interactive-web-behavior');
    expect(r.chain).toEqual([]);
  });

  it('native-desktop collapses to [] in the MVP (only peekaboo can do it)', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      globalDefaultType: 'native-desktop',
    });
    expect(r.chain).toEqual([]);
  });

  it('preserves the easy→hard FALLBACK_CHAINS order through the intersection', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      globalDefaultType: 'static-render-snapshot',
      availableBackends: ['peekaboo', 'capturePage', 'playwright'], // deliberately out of order
    });
    // Order must follow FALLBACK_CHAINS, NOT the availableBackends input order.
    expect(r.chain).toEqual(FALLBACK_CHAINS['static-render-snapshot']);
    expect(r.chain).toEqual(['capturePage', 'playwright', 'peekaboo']);
  });

  it('intersects to exactly the available subset (drops absent backends)', () => {
    const r = resolveVisualVerification({
      globalDefaultEnabled: true,
      globalDefaultType: 'static-render-snapshot',
      availableBackends: ['capturePage', 'peekaboo'], // playwright absent
    });
    expect(r.chain).toEqual(['capturePage', 'peekaboo']);
  });
});
