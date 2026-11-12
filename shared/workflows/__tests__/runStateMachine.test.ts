import { describe, it, expect } from 'vitest';
import type { WorkflowRunStatus } from '../../types/cyboflow';
import {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  assertTransitionAllowed,
  assertTransitionAllowedFromAny,
  allowedSourcesFor,
  allowedSourcesSqlIn,
  IllegalTransitionError,
} from '../runStateMachine';

// All 10 statuses — used for the terminal-state lockdown sweep.
const ALL_STATUSES: readonly WorkflowRunStatus[] = [
  'queued',
  'starting',
  'running',
  'awaiting_review',
  'awaiting_input',
  'stuck',
  'completed',
  'failed',
  'canceled',
  'paused',
];

// ---------------------------------------------------------------------------
// (a) Positive sweep — every allowed transition returns true
// ---------------------------------------------------------------------------

describe('(a) positive sweep — every allowed transition returns true', () => {
  it('iterates ALLOWED_TRANSITIONS and confirms isTransitionAllowed returns true for each listed pair', () => {
    const entries = Object.entries(ALLOWED_TRANSITIONS) as [
      WorkflowRunStatus,
      readonly WorkflowRunStatus[],
    ][];

    // Guard: ensure we have all 10 states
    expect(entries).toHaveLength(10);

    // Confirm each allowed (from, to) pair is accepted
    for (const [from, targets] of entries) {
      for (const to of targets) {
        expect(
          isTransitionAllowed(from, to),
          `expected isTransitionAllowed('${from}', '${to}') === true`,
        ).toBe(true);
      }
    }
  });

  // Spot-check representative allowed transitions from each source state
  it('queued -> starting is allowed', () => {
    expect(isTransitionAllowed('queued', 'starting')).toBe(true);
  });

  it('queued -> canceled is allowed', () => {
    expect(isTransitionAllowed('queued', 'canceled')).toBe(true);
  });

  it('starting -> running is allowed', () => {
    expect(isTransitionAllowed('starting', 'running')).toBe(true);
  });

  it('running -> awaiting_review is allowed', () => {
    expect(isTransitionAllowed('running', 'awaiting_review')).toBe(true);
  });

  it('running -> completed is allowed', () => {
    expect(isTransitionAllowed('running', 'completed')).toBe(true);
  });

  it('running -> stuck is allowed', () => {
    expect(isTransitionAllowed('running', 'stuck')).toBe(true);
  });

  it('awaiting_review -> running is allowed', () => {
    expect(isTransitionAllowed('awaiting_review', 'running')).toBe(true);
  });

  it('awaiting_review -> failed is allowed', () => {
    expect(isTransitionAllowed('awaiting_review', 'failed')).toBe(true);
  });

  // User accept (Merge / Create-PR) completes from the rest state.
  it('awaiting_review -> completed is allowed (user accept)', () => {
    expect(isTransitionAllowed('awaiting_review', 'completed')).toBe(true);
  });

  it('stuck -> completed is allowed (user accept)', () => {
    expect(isTransitionAllowed('stuck', 'completed')).toBe(true);
  });

  it('stuck -> running is allowed', () => {
    expect(isTransitionAllowed('stuck', 'running')).toBe(true);
  });

  it('stuck -> canceled is allowed', () => {
    expect(isTransitionAllowed('stuck', 'canceled')).toBe(true);
  });

  it('stuck -> failed is allowed', () => {
    expect(isTransitionAllowed('stuck', 'failed')).toBe(true);
  });

  it('running -> awaiting_input is allowed', () => {
    expect(isTransitionAllowed('running', 'awaiting_input')).toBe(true);
  });

  it('awaiting_input -> running is allowed', () => {
    expect(isTransitionAllowed('awaiting_input', 'running')).toBe(true);
  });

  it('awaiting_input -> canceled is allowed', () => {
    expect(isTransitionAllowed('awaiting_input', 'canceled')).toBe(true);
  });

  // Phase 4b — SDK-only Pause/Resume edges.
  it('running -> paused is allowed (Pause from a live turn)', () => {
    expect(isTransitionAllowed('running', 'paused')).toBe(true);
  });

  it('awaiting_review -> paused is allowed (Pause from an idle-rested run)', () => {
    expect(isTransitionAllowed('awaiting_review', 'paused')).toBe(true);
  });

  it('paused -> running is allowed (Resume re-drives via --resume)', () => {
    expect(isTransitionAllowed('paused', 'running')).toBe(true);
  });

  it('paused -> canceled is allowed', () => {
    expect(isTransitionAllowed('paused', 'canceled')).toBe(true);
  });

  it('paused -> failed is allowed', () => {
    expect(isTransitionAllowed('paused', 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Negative sweep — explicit forbidden transitions return false
// ---------------------------------------------------------------------------

describe('(b) negative sweep — explicit forbidden transitions return false', () => {
  it('completed -> running is forbidden', () => {
    expect(isTransitionAllowed('completed', 'running')).toBe(false);
  });

  it('failed -> queued is forbidden', () => {
    expect(isTransitionAllowed('failed', 'queued')).toBe(false);
  });

  it('canceled -> running is forbidden', () => {
    expect(isTransitionAllowed('canceled', 'running')).toBe(false);
  });

  it('queued -> awaiting_review is forbidden (must go through starting -> running first)', () => {
    expect(isTransitionAllowed('queued', 'awaiting_review')).toBe(false);
  });

  it('queued -> running is forbidden (must go through starting first)', () => {
    expect(isTransitionAllowed('queued', 'running')).toBe(false);
  });

  it('starting -> awaiting_review is forbidden', () => {
    expect(isTransitionAllowed('starting', 'awaiting_review')).toBe(false);
  });

  it('awaiting_review -> queued is forbidden', () => {
    expect(isTransitionAllowed('awaiting_review', 'queued')).toBe(false);
  });

  it('stuck -> awaiting_review is forbidden', () => {
    expect(isTransitionAllowed('stuck', 'awaiting_review')).toBe(false);
  });

  it('awaiting_input -> completed is forbidden (must return to running first)', () => {
    expect(isTransitionAllowed('awaiting_input', 'completed')).toBe(false);
  });

  it('awaiting_input -> stuck is forbidden (awaiting_input is exempt from stuck classification)', () => {
    expect(isTransitionAllowed('awaiting_input', 'stuck')).toBe(false);
  });

  it('awaiting_input -> awaiting_review is forbidden', () => {
    expect(isTransitionAllowed('awaiting_input', 'awaiting_review')).toBe(false);
  });

  // Phase 4b — paused only resumes to running (then rests/completes from there).
  it('paused -> completed is forbidden (Resume returns to running first)', () => {
    expect(isTransitionAllowed('paused', 'completed')).toBe(false);
  });

  it('completed -> paused is forbidden (terminal state has no edges)', () => {
    expect(isTransitionAllowed('completed', 'paused')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) assertTransitionAllowed throw semantics
// ---------------------------------------------------------------------------

describe('(c) assertTransitionAllowed throw semantics', () => {
  it('throws IllegalTransitionError on a forbidden transition', () => {
    expect(() => assertTransitionAllowed('completed', 'running')).toThrow(
      IllegalTransitionError,
    );
  });

  it('thrown error carries correct from, to properties', () => {
    let caught: unknown;
    try {
      assertTransitionAllowed('failed', 'queued');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const e = caught as IllegalTransitionError;
    expect(e.from).toBe('failed');
    expect(e.to).toBe('queued');
    expect(e.runId).toBeUndefined();
  });

  it('thrown error message contains both from and to states', () => {
    let caught: unknown;
    try {
      assertTransitionAllowed('canceled', 'running');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const e = caught as IllegalTransitionError;
    expect(e.message).toContain('canceled');
    expect(e.message).toContain('running');
  });

  it('thrown error carries runId when supplied and message contains it', () => {
    const testRunId = 'run-forensic-001';
    let caught: unknown;
    try {
      assertTransitionAllowed('completed', 'queued', testRunId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const e = caught as IllegalTransitionError;
    expect(e.from).toBe('completed');
    expect(e.to).toBe('queued');
    expect(e.runId).toBe(testRunId);
    expect(e.message).toContain('completed');
    expect(e.message).toContain('queued');
    expect(e.message).toContain(testRunId);
  });

  it('does NOT throw on an allowed transition (positive control)', () => {
    expect(() => assertTransitionAllowed('running', 'completed')).not.toThrow();
  });

  it('error name is IllegalTransitionError', () => {
    let caught: unknown;
    try {
      assertTransitionAllowed('stuck', 'awaiting_review');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const e = caught as IllegalTransitionError;
    expect(e.name).toBe('IllegalTransitionError');
  });
});

// ---------------------------------------------------------------------------
// (d) Terminal-state lockdown — every target rejected including self
// ---------------------------------------------------------------------------

describe('(d) terminal-state lockdown', () => {
  const terminals: readonly WorkflowRunStatus[] = ['completed', 'failed', 'canceled'];

  it('terminal states have empty ALLOWED_TRANSITIONS entries', () => {
    for (const terminal of terminals) {
      expect(ALLOWED_TRANSITIONS[terminal]).toHaveLength(0);
    }
  });

  it('isTransitionAllowed returns false for every (terminal -> any) pair', () => {
    for (const terminal of terminals) {
      for (const target of ALL_STATUSES) {
        expect(
          isTransitionAllowed(terminal, target),
          `expected isTransitionAllowed('${terminal}', '${target}') === false`,
        ).toBe(false);
      }
    }
  });

  it('assertTransitionAllowed throws for every (terminal -> any) pair', () => {
    for (const terminal of terminals) {
      for (const target of ALL_STATUSES) {
        expect(
          () => assertTransitionAllowed(terminal, target),
          `expected assertTransitionAllowed('${terminal}', '${target}') to throw`,
        ).toThrow(IllegalTransitionError);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (e) P4 review_items fold — adds no review states; the run-pause/aggregate-
//     blocking invariant reuses awaiting_review / awaiting_input. (Phase 4b adds
//     the explicit 'paused' run state separately; total status count is 10.)
// ---------------------------------------------------------------------------

describe('(e) P4 review-item fold reuses existing review states (no new review states)', () => {
  it('the status set is exactly the 10 documented states (review fold adds NONE; Phase 4b adds only paused)', () => {
    // P4 routes permissions/decisions/human-gates into review_items, NOT into new
    // workflow_runs statuses — a run pauses for review by reusing awaiting_review
    // (permission / human-gate / clean-drain rest) or awaiting_input (AskUserQuestion).
    // Phase 4b adds the single explicit SDK-only 'paused' state for run Pause/Resume,
    // bringing the total to 10. If a NEW state were ever added the count here drifts
    // and this guard fires.
    expect(ALL_STATUSES).toHaveLength(10);
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });
});

// ---------------------------------------------------------------------------
// (f) Multi-source + derived-source helpers — the shapes the raw UPDATE sites
//     across main/src/orchestrator use to validate against this table.
// ---------------------------------------------------------------------------

describe('(f) assertTransitionAllowedFromAny', () => {
  it('accepts a list whose every member has a legal edge to the target', () => {
    // ApprovalRouter's deny path: WHERE status IN ('awaiting_review', 'stuck').
    expect(() =>
      assertTransitionAllowedFromAny(['awaiting_review', 'stuck'], 'running'),
    ).not.toThrow();
  });

  it('SKIPS a from === to member (an idempotent re-stamp is not a transition)', () => {
    // ApprovalRouter's allow path lists 'running' alongside two real sources so an
    // already-restored orphan re-stamps cleanly; humanStepManager lists
    // 'awaiting_review' for the back-to-back gate re-park. Neither is an edge, and
    // neither is in the table (running -> running is absent).
    expect(isTransitionAllowed('running', 'running')).toBe(false);
    expect(() =>
      assertTransitionAllowedFromAny(['awaiting_review', 'running', 'stuck'], 'running'),
    ).not.toThrow();
    expect(() =>
      assertTransitionAllowedFromAny(['running', 'awaiting_review'], 'awaiting_review'),
    ).not.toThrow();
  });

  it('throws IllegalTransitionError naming the OFFENDING member, not the first one', () => {
    // 'awaiting_input' -> 'stuck' is deliberately absent (IDEA-025 Q2).
    let caught: unknown;
    try {
      assertTransitionAllowedFromAny(['awaiting_review', 'awaiting_input'], 'stuck', 'run-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect((caught as IllegalTransitionError).from).toBe('awaiting_input');
    expect((caught as IllegalTransitionError).runId).toBe('run-1');
  });

  it('still rejects a TERMINAL source whose target differs from it', () => {
    expect(() => assertTransitionAllowedFromAny(['running', 'failed'], 'completed')).toThrow(
      IllegalTransitionError,
    );
  });

  it('is a no-op for an empty list (nothing to validate)', () => {
    expect(() => assertTransitionAllowedFromAny([], 'completed')).not.toThrow();
  });
});

describe('(f) allowedSourcesFor / allowedSourcesSqlIn read the table backwards', () => {
  it('completion is reachable ONLY from running / awaiting_review / stuck', () => {
    // This is the set the close-out UPDATEs in trpc/routers/runs.ts and
    // runRecovery.stampSessionRunsPrOpen now guard on. A `queued` or `starting`
    // run — one that never produced an artifact — must NOT be in it.
    expect([...allowedSourcesFor('completed')].sort()).toEqual(
      ['awaiting_review', 'running', 'stuck'].sort(),
    );
  });

  it('cancel is reachable from EVERY non-terminal status', () => {
    // cancelRunHandler / cancelAndRestartHandler / runs.dismiss guard on this; it
    // must stay equivalent to the "not terminal" list they used to hardcode.
    const nonTerminal = ALL_STATUSES.filter(s => !['completed', 'failed', 'canceled'].includes(s));
    expect([...allowedSourcesFor('canceled')].sort()).toEqual([...nonTerminal].sort());
  });

  it('no terminal status is ever a source', () => {
    for (const to of ALL_STATUSES) {
      for (const terminal of ['completed', 'failed', 'canceled'] as const) {
        expect(allowedSourcesFor(to)).not.toContain(terminal);
      }
    }
  });

  it('renders a quoted SQL IN list in table order', () => {
    expect(allowedSourcesSqlIn('completed')).toBe("('running', 'awaiting_review', 'stuck')");
  });

  it('throws rather than rendering an empty IN list for an unreachable target', () => {
    // 'queued' is the INSERT's status; nothing transitions INTO it. An `IN ()`
    // would be a silently-never-matching guard, so the render must refuse.
    expect(allowedSourcesFor('queued')).toEqual([]);
    expect(() => allowedSourcesSqlIn('queued')).toThrow(/no workflow_run status/i);
  });
});
