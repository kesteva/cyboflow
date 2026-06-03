import { describe, it, expect } from 'vitest';
import type { WorkflowRunStatus } from '../../../../../shared/types/cyboflow';
import {
  ALLOWED_TRANSITIONS,
  isTransitionAllowed,
  assertTransitionAllowed,
  IllegalTransitionError,
} from '../stateMachine';

// All 9 statuses — used for the terminal-state lockdown sweep.
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

    // Guard: ensure we have all 9 states
    expect(entries).toHaveLength(9);

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

  it('does NOT throw on queued -> starting (positive control)', () => {
    expect(() => assertTransitionAllowed('queued', 'starting')).not.toThrow();
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

  it('completed -> completed same-status no-op is explicitly rejected', () => {
    expect(isTransitionAllowed('completed', 'completed')).toBe(false);
  });

  it('failed -> failed same-status no-op is explicitly rejected', () => {
    expect(isTransitionAllowed('failed', 'failed')).toBe(false);
  });

  it('canceled -> canceled same-status no-op is explicitly rejected', () => {
    expect(isTransitionAllowed('canceled', 'canceled')).toBe(false);
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
// (e) P4 review_items fold — no new states; the run-pause/aggregate-blocking
//     invariant reuses awaiting_review / awaiting_input.
// ---------------------------------------------------------------------------

describe('(e) P4 review-item fold reuses existing pause states (no new states)', () => {
  it('the status set is still exactly the 9 documented states — the review fold adds NONE', () => {
    // P4 routes permissions/decisions/human-gates into review_items, NOT into new
    // workflow_runs statuses. A run pauses by reusing awaiting_review (permission /
    // human-gate / clean-drain rest) or awaiting_input (AskUserQuestion). If a new
    // state were ever added the count here drifts and this guard fires.
    expect(ALL_STATUSES).toHaveLength(9);
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('the human-gate pause path (running -> awaiting_review) is a legal edge', () => {
    // HumanStepManager.openHumanGate issues this exact transition; it must be
    // allowed by the table (it is — shared with the tool-approval gate).
    expect(isTransitionAllowed('running', 'awaiting_review')).toBe(true);
  });

  it('the aggregate-unblock auto-resume edge (awaiting_review -> running) is legal', () => {
    // HumanStepManager.maybeResumeRun / resolveHumanGate issue this when the last
    // blocking review_item resolves. The "cannot leave awaiting_review while a
    // blocking item is still pending" rule is an AGGREGATE-DB gate enforced by
    // HumanStepManager.countPendingBlockingReviewItems — NOT a per-edge state
    // rule — so the edge itself stays legal here (see reviewItemFold.test.ts +
    // mcpQueryHandler.test.ts for the behavioral aggregate-blocking proof).
    expect(isTransitionAllowed('awaiting_review', 'running')).toBe(true);
  });

  it('awaiting_input -> running (question resolve auto-resume) is legal', () => {
    expect(isTransitionAllowed('awaiting_input', 'running')).toBe(true);
  });
});
