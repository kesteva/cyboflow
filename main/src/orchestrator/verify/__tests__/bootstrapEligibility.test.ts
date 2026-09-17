/**
 * Unit tests for the shared runbook-bootstrap decision
 * (docs/proposals/lane-runbook-bootstrap.md §4, §12 step 1).
 *
 * These are the highest-consequence pure functions in the feature. Two things
 * are being pinned:
 *
 *  1. `taskDerivesEnvironment` is THE definition the §3.2 gate and the preflight
 *     both use. If they ever computed it differently the feature misfires in
 *     both directions — bootstrapping requests the gate would have passed, or
 *     leaving skipped the ones it would not. So the table below is written
 *     against the shapes the gate actually sees, empty `build` included.
 *  2. Deriving a runbook is an UPSERT over a singleton (project, modality)
 *     record. Three different situations answer `'unproven-draft'` and only two
 *     of them are safe to write over; the third is a live proof another branch
 *     depends on. Every discriminant is asserted individually rather than "not
 *     proven ⇒ go", because "not proven ⇒ go" is precisely the bug.
 */
import { describe, it, expect } from 'vitest';
import {
  bootstrapRemedyText,
  bootstrapSupportsModality,
  decideRunbookBootstrap,
  declineForRunbookStatus,
  taskDerivesEnvironment,
  type BootstrapDeclineReason,
} from '../bootstrapEligibility';
import type { VerificationModality } from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookStatusDetail, VerifyRunbookStatusReason } from '../runbookStore';

function status(reason: VerifyRunbookStatusReason): VerifyRunbookStatusDetail {
  // The status half is what the gate acts on; the reason is what the bootstrap
  // acts on. Derived here so a test names only the thing it is about.
  const map: Record<VerifyRunbookStatusReason, VerifyRunbookStatusDetail['status']> = {
    proven: 'proven',
    'no-record': 'absent',
    'file-only': 'unproven-draft',
    draft: 'unproven-draft',
    'proven-file-absent-here': 'unproven-draft',
    drifted: 'unproven-draft',
    'content-drifted': 'unproven-draft',
    indeterminate: 'absent',
  };
  return { status: map[reason], reason };
}

describe('taskDerivesEnvironment', () => {
  it.each([
    ['a serve step', { serve: { cmd: 'pnpm dev --port ${PORT}' } }, true],
    ['a non-empty build', { build: ['pnpm build'] }, true],
    ['both', { build: ['pnpm build'], serve: { cmd: 'x' } }, true],
    ['neither (a degenerate target-only task)', {}, false],
    // The asymmetry that matters: an EMPTY build array derives nothing and must
    // not gate, while `serve` counts by presence alone.
    ['an EMPTY build array', { build: [] }, false],
  ])('%s → %s', (_label, task, expected) => {
    expect(taskDerivesEnvironment(task)).toBe(expected);
  });
});

describe('declineForRunbookStatus', () => {
  it.each<[VerifyRunbookStatusReason, BootstrapDeclineReason | null]>([
    ['no-record', null],
    ['file-only', null],
    ['draft', null],
    ['proven', 'already-proven'],
    ['proven-file-absent-here', 'proof-belongs-elsewhere'],
    ['drifted', 'stale-proof'],
    // The GATE is deliberately coarse: both drifts are the same fact to a
    // request that needs a usable runbook, and the skip string must not fork
    // (`runbookDeclineForSkipReason` reverse-maps it). The finer distinction is
    // made one level up, in decideRunbookBootstrap.
    ['content-drifted', 'stale-proof'],
    ['indeterminate', 'unobservable'],
  ])('%s → %s', (reason, expected) => {
    expect(declineForRunbookStatus(status(reason))).toBe(expected);
  });

  it('NEVER allows deriving over a proof that belongs to another branch', () => {
    // The single most consequential row above, restated on its own because the
    // failure mode is silent and shared: registerDraft would UPSERT the
    // singleton record, and every branch that HAS the runbook would stop
    // verifying. This case answers 'unproven-draft' exactly like a safe draft
    // does, so nothing but the reason distinguishes them.
    const detail = status('proven-file-absent-here');
    expect(detail.status).toBe('unproven-draft');
    expect(declineForRunbookStatus(detail)).toBe('proof-belongs-elsewhere');
  });
});

describe('bootstrapSupportsModality', () => {
  it.each<[VerificationModality, boolean]>([
    ['web', true],
    ['cdp-app', true],
    ['native-screen', true],
    // Declarable by the portable contract since the mobile widening, and still
    // not something a lane authors — the verify-setup flow owns it.
    ['mobile', false],
  ])('%s → %s', (modality, expected) => {
    expect(bootstrapSupportsModality(modality)).toBe(expected);
  });

  it('is the SAME predicate the preflight skips its status read by', () => {
    // Exported precisely so the preflight does not restate the policy as a
    // second `if` — the drift this module exists to prevent. Pinned here so a
    // refactor that inlines one copy fails rather than diverges.
    expect(decideRunbookBootstrap({
      enabled: true,
      derivesEnvironment: true,
      modality: 'mobile',
      status: status('no-record'),
    })).toMatchObject({ proceed: false, reason: 'auto-derive-unsupported' });
    expect(bootstrapSupportsModality('mobile')).toBe(false);
  });
});

describe('decideRunbookBootstrap', () => {
  const on = { enabled: true, derivesEnvironment: true, modality: 'web' as const };

  it('proceeds on a project that has nothing, deriving a new runbook', () => {
    expect(decideRunbookBootstrap({ ...on, status: status('no-record') })).toEqual({
      proceed: true,
      mode: 'derive',
      adopt: false,
    });
  });

  it('proceeds in ADOPT mode when this tree already carries a runbook nobody proved', () => {
    // A teammate committed it; this host merely never proved it. Overwriting it
    // with a machine-authored rival would throw away human intent for no gain.
    expect(decideRunbookBootstrap({ ...on, status: status('file-only') })).toEqual({
      proceed: true,
      mode: 'derive',
      adopt: true,
    });
  });

  it('proceeds on an existing draft record — there is no proof to endanger', () => {
    expect(decideRunbookBootstrap({ ...on, status: status('draft') })).toEqual({
      proceed: true,
      mode: 'derive',
      adopt: false,
    });
  });

  it('a DRIFTED proof proceeds in REPROVE mode, carrying no adopt question at all', () => {
    // F4 / Codex #2, the whole point of stage 2. Drift is now computed on every
    // read and never persisted, so a drifted record answers 'drifted' forever:
    // declining here (which is what the gate's own classification still says,
    // and what stage 1 alone did) would mean the project can never verify again.
    // Deriving here would UPSERT a machine-authored rival over a human-authored
    // runbook whose only defect is a stale proof. Neither is the answer.
    //
    // `adopt` is ABSENT rather than false: a reprove authors nothing, so there
    // is no adopt-vs-author decision, and a made-up `false` would read like one
    // that had been taken.
    expect(decideRunbookBootstrap({ ...on, status: status('drifted') })).toEqual({
      proceed: true,
      mode: 'reprove',
    });
  });

  it('the GATE still classifies that same record as a decline — the two seams differ on purpose', () => {
    // `declineForRunbookStatus` is what the §3.2 gate writes onto a skipped row,
    // and a drifted record genuinely cannot serve a request. Only the BOOTSTRAP
    // decision treats it as actionable. Pinned together so a future "simplify"
    // that folds the two back into one function fails here rather than in
    // production, in whichever direction it folds them.
    expect(declineForRunbookStatus(status('drifted'))).toBe('stale-proof');
    expect(decideRunbookBootstrap({ ...on, status: status('drifted') })).toMatchObject({ proceed: true });
  });

  /**
   * A CONTENT drift must never reach the reprove (F4 fix round).
   *
   * Promotion re-stamps `input_hash`/`host_fingerprint_json` and deliberately
   * never `portable_hash` (Codex #1), so nothing a proof does can make this
   * tree's file agree with the record again. Routed to `'reprove'`, the sequence
   * is: deploy an agent, build and serve the project, PASS, fail `confirmProven`
   * against the same unchanged mismatch, report "still not proven" about a
   * runbook that just proved — and repeat on the next run, and the next, each
   * time spending a deployment and a verification-budget charge. Declining is
   * the honest answer, and the remedy text says the true thing: re-register this
   * revision (the Verify Setup flow), then prove it.
   */
  it('a CONTENT drift declines instead — a proof cannot re-stamp the content hash', () => {
    expect(decideRunbookBootstrap({ ...on, status: status('content-drifted') })).toEqual({
      proceed: false,
      reason: 'stale-proof',
    });
  });

  it('the reprove arm is keyed on the exact reason, not on "the decline was stale-proof"', () => {
    // Both drifts decline as 'stale-proof' at the gate, so a mode decision made
    // off the DECLINE cannot tell them apart — which is how the loop above got
    // built in the first place. Pinned as a pair.
    expect(declineForRunbookStatus(status('content-drifted'))).toBe(
      declineForRunbookStatus(status('drifted')),
    );
    expect(decideRunbookBootstrap({ ...on, status: status('drifted') })).toMatchObject({
      mode: 'reprove',
    });
    expect(decideRunbookBootstrap({ ...on, status: status('content-drifted') })).toMatchObject({
      proceed: false,
    });
  });

  it.each<[VerifyRunbookStatusReason, BootstrapDeclineReason]>([
    ['proven', 'already-proven'],
    ['proven-file-absent-here', 'proof-belongs-elsewhere'],
    ['content-drifted', 'stale-proof'],
    ['indeterminate', 'unobservable'],
  ])('declines on %s with reason %s', (reason, expected) => {
    expect(decideRunbookBootstrap({ ...on, status: status(reason) })).toEqual({
      proceed: false,
      reason: expected,
    });
  });

  it('the toggle beats a drifted record too — reprove is gated by the same switch', () => {
    // The reprove path spends a verification budget charge and deploys an agent
    // exactly like a derive does. A project with the feature off must not get one
    // through the back door of having once been proven.
    expect(
      decideRunbookBootstrap({ ...on, enabled: false, status: status('drifted') }),
    ).toEqual({ proceed: false, reason: 'disabled' });
  });

  it('the toggle wins over everything, and is reported as the toggle', () => {
    // Not 'no-record': a project with the feature off is not a project that
    // needs setting up, and describing it that way would put a runbook CTA in
    // front of someone who deliberately turned this off.
    expect(
      decideRunbookBootstrap({ ...on, enabled: false, status: status('no-record') }),
    ).toEqual({ proceed: false, reason: 'disabled' });
  });

  it('declines a MOBILE lane outright — the verify-setup flow owns those runbooks', () => {
    // The portable contract CAN declare `mobile` now (the `app` block), so the
    // old "undeclarable" reasoning no longer holds and nothing about the
    // project's runbook state is what stops this. What stops it is that the
    // derivation machinery surveys npm scripts and could never discover an
    // Xcode scheme, a bundle id, or a simulator destination — so a lane that
    // "derived" one would register a record no execution path could satisfy.
    expect(decideRunbookBootstrap({ ...on, modality: 'mobile', status: status('no-record') })).toEqual({
      proceed: false,
      reason: 'auto-derive-unsupported',
    });
  });

  it('the mobile decline holds whatever the runbook state says', () => {
    // Keyed on the modality, not on the situation: a mobile project with a
    // draft, or with a drifted proof, must not slip into derive or reprove
    // through a status arm that never looked at the modality.
    for (const reason of ['no-record', 'file-only', 'draft', 'drifted'] as const) {
      expect(
        decideRunbookBootstrap({ ...on, modality: 'mobile', status: status(reason) }),
      ).toEqual({ proceed: false, reason: 'auto-derive-unsupported' });
    }
  });

  it('the mobile decline is reported ahead of the task shape', () => {
    // A mobile task carries `app`, not `serve`, so whether taskDerivesEnvironment
    // is true for it is an accident of its `build` array. "This task derives
    // nothing" would be the wrong sentence to hand someone asking why their
    // mobile verification never ran.
    expect(
      decideRunbookBootstrap({
        ...on,
        modality: 'mobile',
        derivesEnvironment: false,
        status: status('no-record'),
      }),
    ).toEqual({ proceed: false, reason: 'auto-derive-unsupported' });
  });

  it('the toggle still beats the modality policy', () => {
    // Same ordering rule as everywhere else here: a project with the feature off
    // is not a project that needs a runbook CTA of any flavour.
    expect(
      decideRunbookBootstrap({ ...on, enabled: false, modality: 'mobile', status: status('no-record') }),
    ).toEqual({ proceed: false, reason: 'disabled' });
  });

  it.each<VerificationModality>(['web', 'cdp-app', 'native-screen'])(
    'still proceeds normally on %s',
    (modality) => {
      // The allow-list is the change; the three modalities the lane has always
      // derived for must be untouched by it.
      expect(decideRunbookBootstrap({ ...on, modality, status: status('no-record') })).toEqual({
        proceed: true,
        mode: 'derive',
        adopt: false,
      });
    },
  );

  it('a degenerate task declines as no-environment, not as a runbook problem', () => {
    expect(
      decideRunbookBootstrap({ ...on, derivesEnvironment: false, status: status('no-record') }),
    ).toEqual({ proceed: false, reason: 'no-environment' });
  });
});

describe('bootstrapRemedyText', () => {
  it('tells a pre-merge branch to MERGE, and explicitly not to re-run setup', () => {
    // The remedy is the opposite of the default CTA, and following the default
    // one here is what destroys the shared proven record.
    const text = bootstrapRemedyText('proof-belongs-elsewhere') ?? '';
    expect(text).toContain('Merge');
    expect(text).toContain('Do NOT re-run verification setup');
  });

  it('tells a drifted project to re-prove rather than to re-derive', () => {
    expect(bootstrapRemedyText('stale-proof') ?? '').toContain('re-proven');
    // …and, for the content-drift half of the same decline, that the file has
    // to be re-registered first — the one thing a re-prove cannot do.
    expect(bootstrapRemedyText('stale-proof') ?? '').toContain('re-registered');
  });

  it('points an unsupported modality at verification setup, not at a missing runbook', () => {
    const text = bootstrapRemedyText('auto-derive-unsupported') ?? '';
    expect(text).toContain('verification runbook');
    expect(text).toContain('Run verification setup');
  });

  it.each<BootstrapDeclineReason>(['disabled', 'no-environment', 'already-proven'])(
    'has nothing to say about %s',
    (reason) => {
      // These are not problems. Attaching prose to them would put advice on a
      // finding for a lane that did exactly what it should have.
      expect(bootstrapRemedyText(reason)).toBeNull();
    },
  );
});
