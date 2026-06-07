import { describe, it, expect } from 'vitest';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';
import { WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
import {
  classifyRun,
  deriveHomeState,
  formatElapsed,
  derivePhaseFill,
} from '../homeClassify';

// ---------------------------------------------------------------------------
// classifyRun — all 10 statuses
// ---------------------------------------------------------------------------

describe('classifyRun', () => {
  const cases: Array<[WorkflowRunStatus, ReturnType<typeof classifyRun>]> = [
    ['queued', 'active'],
    ['starting', 'active'],
    ['running', 'active'],
    ['awaiting_review', 'blocked'],
    ['stuck', 'blocked'],
    ['awaiting_input', 'blocked'],
    ['paused', 'blocked'],
    ['completed', 'terminal'],
    ['failed', 'terminal'],
    ['canceled', 'terminal'],
  ];

  it.each(cases)('classifies %s as %s', (status, expected) => {
    expect(classifyRun(status)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// deriveHomeState — all 5 branches
// ---------------------------------------------------------------------------

describe('deriveHomeState', () => {
  it('returns empty when there are no projects (regardless of other flags)', () => {
    expect(
      deriveHomeState({
        projectsCount: 0,
        reviewsExist: true,
        anyActive: true,
        anyIdle: true,
      }),
    ).toBe('empty');
  });

  it('returns reviews when projects exist and a review is pending', () => {
    expect(
      deriveHomeState({
        projectsCount: 2,
        reviewsExist: true,
        anyActive: false,
        anyIdle: false,
      }),
    ).toBe('reviews');
  });

  it('returns some-idle when work is active and some runs are idle', () => {
    expect(
      deriveHomeState({
        projectsCount: 1,
        reviewsExist: false,
        anyActive: true,
        anyIdle: true,
      }),
    ).toBe('some-idle');
  });

  it('returns all-active when work is active and nothing is idle', () => {
    expect(
      deriveHomeState({
        projectsCount: 1,
        reviewsExist: false,
        anyActive: true,
        anyIdle: false,
      }),
    ).toBe('all-active');
  });

  it('returns caught-up when projects exist but nothing is active (no runs)', () => {
    expect(
      deriveHomeState({
        projectsCount: 3,
        reviewsExist: false,
        anyActive: false,
        anyIdle: false,
      }),
    ).toBe('caught-up');
  });
});

// ---------------------------------------------------------------------------
// formatElapsed — deterministic via explicit nowMs
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('returns the em-dash placeholder when startedAt is null', () => {
    expect(formatElapsed(null, 1_700_000_000_000)).toBe('—');
  });

  it('returns the placeholder when startedAt is unparseable', () => {
    expect(formatElapsed('not-a-date', 1_700_000_000_000)).toBe('—');
  });

  it('formats a sub-minute delta as seconds only', () => {
    const startedAt = '2024-01-01T00:00:00.000Z';
    const nowMs = new Date('2024-01-01T00:00:12.000Z').getTime();
    expect(formatElapsed(startedAt, nowMs)).toBe('12s');
  });

  it('formats a minutes+seconds delta', () => {
    const startedAt = '2024-01-01T00:00:00.000Z';
    const nowMs = new Date('2024-01-01T00:06:36.000Z').getTime();
    expect(formatElapsed(startedAt, nowMs)).toBe('6m 36s');
  });

  it('formats an hours+minutes delta (dropping seconds)', () => {
    const startedAt = '2024-01-01T00:00:00.000Z';
    const nowMs = new Date('2024-01-01T01:12:45.000Z').getTime();
    expect(formatElapsed(startedAt, nowMs)).toBe('1h 12m');
  });

  it('clamps a negative delta to 0s', () => {
    const startedAt = '2024-01-01T00:00:10.000Z';
    const nowMs = new Date('2024-01-01T00:00:00.000Z').getTime();
    expect(formatElapsed(startedAt, nowMs)).toBe('0s');
  });
});

// ---------------------------------------------------------------------------
// derivePhaseFill — built-in planner definition
// ---------------------------------------------------------------------------

describe('derivePhaseFill', () => {
  it('returns [] for a null definition', () => {
    expect(derivePhaseFill(null, 'epics')).toEqual([]);
  });

  it('fills up to and marks the current phase for a step in refine', () => {
    // planner phases: [plan, refine]; 'epics' lives in the 'refine' phase.
    const segments = derivePhaseFill(WORKFLOW_DEFINITIONS.planner, 'epics');

    expect(segments).toHaveLength(2);

    expect(segments[0]).toEqual({
      phaseId: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      filled: true,
      current: false,
    });

    expect(segments[1]).toEqual({
      phaseId: 'refine',
      label: 'Refine',
      color: '#5a4ad6',
      filled: true,
      current: true,
    });
  });

  it('fills nothing when the current step is not found', () => {
    const segments = derivePhaseFill(WORKFLOW_DEFINITIONS.planner, 'does-not-exist');
    expect(segments.every((s) => !s.filled && !s.current)).toBe(true);
  });

  it('fills nothing when currentStepId is null', () => {
    const segments = derivePhaseFill(WORKFLOW_DEFINITIONS.planner, null);
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => !s.filled && !s.current)).toBe(true);
  });
});
