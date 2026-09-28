/**
 * Unit tests for the RUN-LEVEL verification posture (CD1).
 *
 * The posture is a small pure ladder over two injected reads, and every rung of
 * it is a decision someone can get wrong in a way that is invisible until a
 * sprint runs: folding the deliberate off switch into "unavailable" files a
 * finding the enqueue seam was changed to suppress; reading an unwired probe as
 * 'absent' declares a healthy project unverifiable. Both are pinned here.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  resolveVerificationPosture,
  isNoModalityDeclineReason,
  type VerificationPostureDeps,
  type VerificationRunStamp,
} from '../verificationPosture';
import type { VerifyRunbookStatusDetail } from '../runbookStore';

/** The runbook-optional kill switch ENGAGED — the pre-§A6 contract every legacy case below pins. */
const KILL_SWITCH_ON = { requireProvenRunbook: true };

/**
 * Deps over a fixed stamp + a fixed runbook answer, recording the probe args.
 *
 * `liveConfig` defaults to the kill switch ENGAGED, so every pre-existing case
 * asserts the byte-identical legacy ladder (runbook-optional-verification.md
 * §A1 "A6 is off"); the §A6 block passes explore-on configs explicitly.
 */
function makeDeps(
  stamp: VerificationRunStamp | null | (() => never),
  runbook: VerifyRunbookStatusDetail | null | (() => never) = null,
  liveConfig: VerificationPostureDeps['liveConfig'] | null = () => KILL_SWITCH_ON,
): VerificationPostureDeps & { probes: Array<{ projectId: number; modality: string; probePath?: string }> } {
  const probes: Array<{ projectId: number; modality: string; probePath?: string }> = [];
  return {
    probes,
    ...(liveConfig !== null ? { liveConfig } : {}),
    readRunStamp: () => (typeof stamp === 'function' ? stamp() : stamp),
    async runbookStatus(projectId, modality, probePath) {
      probes.push({ projectId, modality, ...(probePath !== undefined ? { probePath } : {}) });
      return typeof runbook === 'function' ? runbook() : runbook;
    },
  };
}

function stamp(partial: Partial<VerificationRunStamp> = {}): VerificationRunStamp {
  return {
    projectId: 7,
    verifyEnabled: true,
    verifyType: 'interactive-web-behavior',
    worktreePath: '/tmp/wt',
    ...partial,
  };
}

describe('resolveVerificationPosture', () => {
  it('reports `disabled` for a run stamped verify_enabled = 0, and probes no runbook', async () => {
    // The deliberate off switch. It must NOT become 'unavailable': the controller
    // files one finding for that, and a user who turned the feature off does not
    // want a review-queue card saying so.
    const deps = makeDeps(stamp({ verifyEnabled: false, verifyType: 'native-desktop' }));
    await expect(resolveVerificationPosture(deps, 'r1')).resolves.toEqual({ kind: 'disabled' });
    expect(deps.probes).toHaveLength(0);
  });

  // ── mobile: the structural twin of native-desktop, since the iOS-Simulator
  //    tier replaced the unconditional deferral (mobile-verification-tier §7 (4))
  it('reports `available` for a mobile-flow run with a PROVEN mobile runbook', async () => {
    const deps = makeDeps(stamp({ verifyType: 'mobile-flow' }), {
      status: 'proven',
      reason: 'proven',
    });
    await expect(resolveVerificationPosture(deps, 'r1')).resolves.toEqual({ kind: 'available' });
    // The probe IS called now — the old short-circuit asserted it never was.
    expect(deps.probes).toEqual([{ projectId: 7, modality: 'mobile', probePath: '/tmp/wt' }]);
  });

  it('reports `unavailable` + the runbook decline CODE for a mobile-flow run with no runbook', async () => {
    const deps = makeDeps(stamp({ verifyType: 'mobile-flow' }), {
      status: 'absent',
      reason: 'no-record',
    });
    const posture = await resolveVerificationPosture(deps, 'r1');
    expect(posture).toEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('no proven mobile verification runbook'),
      declineCode: 'no-verification-runbook',
    });
    expect(deps.probes).toHaveLength(1);
  });

  it('distinguishes the mobile runbook DECLINE reasons, and every one says "verification runbook"', async () => {
    const cases: Array<[VerifyRunbookStatusDetail, string]> = [
      [{ status: 'absent', reason: 'proven-file-absent-here' }, 'merge the branch'],
      [{ status: 'absent', reason: 'drifted' }, 're-proven'],
      [{ status: 'absent', reason: 'indeterminate' }, 'could not be read'],
      [{ status: 'absent', reason: 'no-record' }, 'run verification setup'],
    ];
    for (const [status, fragment] of cases) {
      const posture = await resolveVerificationPosture(
        makeDeps(stamp({ verifyType: 'mobile-flow' }), status),
        'r1',
      );
      expect(posture.kind).toBe('unavailable');
      const reason = posture.kind === 'unavailable' ? posture.reason : '';
      expect(reason).toContain(fragment);
      // Belt and braces for the string-only callers (M6).
      expect(reason).toContain('verification runbook');
      expect(isNoModalityDeclineReason(reason)).toBe(true);
    }
  });

  it('reports `available` for a mobile-flow run when the probe is unwired (null) or throws', async () => {
    await expect(
      resolveVerificationPosture(makeDeps(stamp({ verifyType: 'mobile-flow' }), null), 'r1'),
    ).resolves.toEqual({ kind: 'available' });
    await expect(
      resolveVerificationPosture(
        makeDeps(stamp({ verifyType: 'mobile-flow' }), () => {
          throw new Error('probe exploded');
        }),
        'r1',
      ),
    ).resolves.toEqual({ kind: 'available' });
  });

  it('reports `available` for a native-desktop run with a PROVEN native-screen runbook', async () => {
    const deps = makeDeps(stamp({ verifyType: 'native-desktop' }), {
      status: 'proven',
      reason: 'proven',
    });
    await expect(resolveVerificationPosture(deps, 'r1')).resolves.toEqual({ kind: 'available' });
    // Probes the RUN's worktree — the tree whose commands would execute, the
    // same ladder the scheduler's degrade gate uses.
    expect(deps.probes).toEqual([{ projectId: 7, modality: 'native-screen', probePath: '/tmp/wt' }]);
  });

  it('reports `unavailable` for a native-desktop run with no runbook at all', async () => {
    const deps = makeDeps(stamp({ verifyType: 'native-desktop' }), {
      status: 'absent',
      reason: 'no-record',
    });
    const posture = await resolveVerificationPosture(deps, 'r1');
    expect(posture.kind).toBe('unavailable');
    expect(posture.kind === 'unavailable' && posture.reason).toContain('no proven native-screen runbook');
    expect(posture.kind === 'unavailable' && posture.declineCode).toBe('no-verification-runbook');
  });

  it('distinguishes the runbook DECLINE reasons, because their remedies differ', async () => {
    const elsewhere = await resolveVerificationPosture(
      makeDeps(stamp({ verifyType: 'native-desktop' }), {
        status: 'absent',
        reason: 'proven-file-absent-here',
      }),
      'r1',
    );
    expect(elsewhere.kind === 'unavailable' && elsewhere.reason).toContain('merge the branch');

    const drifted = await resolveVerificationPosture(
      makeDeps(stamp({ verifyType: 'native-desktop' }), { status: 'absent', reason: 'drifted' }),
      'r1',
    );
    expect(drifted.kind === 'unavailable' && drifted.reason).toContain('re-proven');
  });

  it('falls back to the project root when the run has no worktree path', async () => {
    const deps = makeDeps(stamp({ verifyType: 'native-desktop', worktreePath: null }), {
      status: 'proven',
      reason: 'proven',
    });
    await resolveVerificationPosture(deps, 'r1');
    expect(deps.probes[0].probePath).toBeUndefined();
  });

  it('reports `available` for every ordinary web / cdp verification type without probing', async () => {
    for (const verifyType of [
      'static-render-snapshot',
      'interactive-web-behavior',
      'responsive-multi-viewport',
    ] as const) {
      const deps = makeDeps(stamp({ verifyType }));
      await expect(resolveVerificationPosture(deps, 'r1')).resolves.toEqual({ kind: 'available' });
      // web / cdp-app runbooks can be BOOTSTRAPPED mid-run, so a missing one is
      // not a run-level verdict.
      expect(deps.probes).toHaveLength(0);
    }
  });

  // ── fail-open ──────────────────────────────────────────────────────────────

  it('reports `available` when the stamp is unreadable, throws, or was never written', async () => {
    await expect(resolveVerificationPosture(makeDeps(null), 'r1')).resolves.toEqual({
      kind: 'available',
    });
    const thrower = makeDeps(() => {
      throw new Error('db gone');
    });
    await expect(resolveVerificationPosture(thrower, 'r1')).resolves.toEqual({ kind: 'available' });
    await expect(
      resolveVerificationPosture(makeDeps(stamp({ verifyType: null })), 'r1'),
    ).resolves.toEqual({ kind: 'available' });
  });

  it('reports `available` when the runbook probe is unwired (null) or throws', async () => {
    // An unwired probe is UNKNOWN, never 'absent' — reading it as absent would
    // declare a healthy native-desktop project unverifiable on a startup race.
    await expect(
      resolveVerificationPosture(makeDeps(stamp({ verifyType: 'native-desktop' }), null), 'r1'),
    ).resolves.toEqual({ kind: 'available' });
    await expect(
      resolveVerificationPosture(
        makeDeps(stamp({ verifyType: 'native-desktop' }), () => {
          throw new Error('probe exploded');
        }),
        'r1',
      ),
    ).resolves.toEqual({ kind: 'available' });
  });
});

// ── §A6: run posture under the runbook-optional contract ─────────────────────
describe('resolveVerificationPosture — explore on (kill switch NOT engaged, §A6)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const EXPLORE_ON = () => ({ requireProvenRunbook: false });
  const ABSENT: VerifyRunbookStatusDetail = { status: 'absent', reason: 'no-record' };

  it('no longer declines a mobile-flow run for runbook ABSENCE — every decline reason — and reads no probe', async () => {
    // A mobile lane with no pin EXPLORES on a fresh leased simulator (gate 3,
    // isExploreEligible: mobile always), so a run-level "unavailable" would
    // suppress exactly the lanes that can now run. Pre-§A6 each of these was
    // 'unavailable' (the legacy cases above, switch engaged).
    for (const status of [
      ABSENT,
      { status: 'absent', reason: 'drifted' },
      { status: 'unproven-draft', reason: 'content-drifted' },
      { status: 'absent', reason: 'proven-file-absent-here' },
      { status: 'absent', reason: 'indeterminate' },
    ] satisfies VerifyRunbookStatusDetail[]) {
      const deps = makeDeps(stamp({ verifyType: 'mobile-flow' }), status, EXPLORE_ON);
      await expect(resolveVerificationPosture(deps, 'r1')).resolves.toEqual({ kind: 'available' });
      expect(deps.probes).toHaveLength(0);
    }
  });

  it('treats an UNWIRED or THROWING live-config read as the config default (switch off ⇒ explore)', async () => {
    const unwired = makeDeps(stamp({ verifyType: 'mobile-flow' }), ABSENT, null);
    await expect(resolveVerificationPosture(unwired, 'r1')).resolves.toEqual({ kind: 'available' });
    const throwing = makeDeps(stamp({ verifyType: 'mobile-flow' }), ABSENT, () => {
      throw new Error('config gone');
    });
    await expect(resolveVerificationPosture(throwing, 'r1')).resolves.toEqual({ kind: 'available' });
  });

  it('the env override CYBOFLOW_VERIFY_REQUIRE_RUNBOOK=1 engages the switch whatever the config says', async () => {
    vi.stubEnv('CYBOFLOW_VERIFY_REQUIRE_RUNBOOK', '1');
    for (const liveConfig of [EXPLORE_ON, null]) {
      const deps = makeDeps(stamp({ verifyType: 'mobile-flow' }), ABSENT, liveConfig);
      const posture = await resolveVerificationPosture(deps, 'r1');
      expect(posture).toEqual({
        kind: 'unavailable',
        reason: expect.stringContaining('no proven mobile verification runbook'),
        declineCode: 'no-verification-runbook',
      });
      expect(deps.probes).toEqual([{ projectId: 7, modality: 'mobile', probePath: '/tmp/wt' }]);
    }
  });

  it('STILL declines a native-desktop run for runbook absence — native-screen is pinned-only', async () => {
    const deps = makeDeps(stamp({ verifyType: 'native-desktop' }), ABSENT, EXPLORE_ON);
    const posture = await resolveVerificationPosture(deps, 'r1');
    expect(posture).toEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('no proven native-screen runbook'),
      declineCode: 'no-verification-runbook',
    });
    expect(deps.probes).toEqual([{ projectId: 7, modality: 'native-screen', probePath: '/tmp/wt' }]);
  });

  it('leaves `disabled` and the ordinary web types exactly as they were', async () => {
    const off = makeDeps(stamp({ verifyEnabled: false, verifyType: 'mobile-flow' }), ABSENT, EXPLORE_ON);
    await expect(resolveVerificationPosture(off, 'r1')).resolves.toEqual({ kind: 'disabled' });
    const web = makeDeps(stamp({ verifyType: 'interactive-web-behavior' }), ABSENT, EXPLORE_ON);
    await expect(resolveVerificationPosture(web, 'r1')).resolves.toEqual({ kind: 'available' });
    expect(web.probes).toHaveLength(0);
  });
});

describe('isNoModalityDeclineReason', () => {
  it('keys on the CODE when one is present, whatever the wording (M6)', () => {
    // The point of the code: a reason nobody would have matched by substring
    // still classifies as a run-level fact.
    expect(
      isNoModalityDeclineReason({ reason: 'reworded beyond recognition', declineCode: 'no-verification-runbook' }),
    ).toBe(true);
    expect(
      isNoModalityDeclineReason({ reason: 'nothing here matches', declineCode: 'unsupported-modality' }),
    ).toBe(true);
    expect(
      isNoModalityDeclineReason({ reason: 'nothing here matches', declineCode: 'modality-deferred' }),
    ).toBe(true);
  });

  it('falls back to the substrings for a coded object with NO code, and for a bare string', () => {
    expect(isNoModalityDeclineReason({ reason: 'a per-lane accident' })).toBe(false);
    expect(isNoModalityDeclineReason({ reason: 'no proven verification runbook here' })).toBe(true);
  });

  it('classifies the REAL mobile runbook prose true, through both call shapes', async () => {
    const posture = await resolveVerificationPosture(
      makeDeps(stamp({ verifyType: 'mobile-flow' }), { status: 'absent', reason: 'drifted' }),
      'r1',
    );
    expect(posture.kind).toBe('unavailable');
    if (posture.kind !== 'unavailable') return;
    expect(isNoModalityDeclineReason(posture)).toBe(true);
    expect(isNoModalityDeclineReason(posture.reason)).toBe(true);
  });

  it('matches the modality / runbook declines that are facts about the RUN', () => {
    expect(isNoModalityDeclineReason("unsupported modality 'mobile': deferred")).toBe(true);
    expect(
      isNoModalityDeclineReason('no proven verification runbook for this project (run verification setup)'),
    ).toBe(true);
    expect(isNoModalityDeclineReason('the mobile modality is deferred')).toBe(true);
  });

  it('does NOT match per-lane accidents or the deliberate off switch', () => {
    expect(isNoModalityDeclineReason('verification-disabled')).toBe(false);
    expect(isNoModalityDeclineReason('scheduler-unavailable')).toBe(false);
    expect(isNoModalityDeclineReason('no-run-row')).toBe(false);
    expect(isNoModalityDeclineReason('run-stamp-unreadable')).toBe(false);
  });
});
