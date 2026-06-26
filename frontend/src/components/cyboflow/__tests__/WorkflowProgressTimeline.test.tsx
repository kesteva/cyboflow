/**
 * WorkflowProgressTimeline component tests (TASK-781 retrofit, TASK-783 prop-drill).
 *
 * After TASK-783, WorkflowProgressTimeline accepts phaseState as a required prop
 * instead of calling useWorkflowPhaseState internally.  Tests pass the fixture
 * directly — no hook mock needed.
 *
 * Behaviors verified:
 *   1. Renders phase headers + step items with state-keyed border colors.
 *   2. Applies 1.4s pulse animation to running step bullet only.
 *   3. Projects log lines (degraded mode — window is null → empty log section).
 *   4. Delta-driven re-render: changing the phaseState prop causes border updates.
 *   5. runId=null renders placeholder.
 *   6. isLoading → 'Loading workflow state…' placeholder.
 *   7. error !== null → 'Failed to load workflow state: <message>' placeholder.
 *   8. definition === null (not loading, no error) → 'No workflow data' placeholder.
 *   9. Phase headers: swatch color, label, step count.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi so store-level subscription does not attempt real IPC
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { WorkflowProgressTimeline } from '../WorkflowProgressTimeline';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import type { UseWorkflowPhaseStateResult } from '../../../hooks/useWorkflowPhaseState';
import type { WorkflowDefinition, WorkflowStepState } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Helpers — build minimal test fixtures
// ---------------------------------------------------------------------------

const EMPTY_PHASE_STATE: UseWorkflowPhaseStateResult = {
  definition: null,
  currentStepId: null,
  stepStates: [],
  isLoading: false,
  error: null,
};

function makePhaseState(overrides?: {
  currentStepId?: string | null;
  stepStatuses?: Record<string, WorkflowStepState['status']>;
}): UseWorkflowPhaseStateResult {
  const definition: WorkflowDefinition = {
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'implement',
            name: 'Implement task',
            agent: 'executor',
            mcps: ['filesystem'],
            retries: 3,
            desc: 'Reads CODE-PATTERNS.md, writes the diff.',
          },
          {
            id: 'write-tests',
            name: 'Write tests',
            agent: 'test-writer',
            mcps: ['filesystem'],
            retries: 1,
            desc: 'Adds unit / integration tests.',
          },
          {
            id: 'task-verify',
            name: 'Task verification',
            agent: 'verifier',
            mcps: ['filesystem', 'bash'],
            retries: 3,
            desc: 'Checks acceptance criteria.',
          },
        ],
      },
    ],
  };

  const statuses = overrides?.stepStatuses ?? {};
  const stepStates: WorkflowStepState[] = [
    { stepId: 'implement',   status: statuses['implement']   ?? 'pending' },
    { stepId: 'write-tests', status: statuses['write-tests'] ?? 'pending' },
    { stepId: 'task-verify', status: statuses['task-verify'] ?? 'pending' },
  ];

  return {
    definition,
    currentStepId: overrides?.currentStepId ?? null,
    stepStates,
    isLoading: false,
    error: null,
  };
}

function makeTwoPhaseState(): UseWorkflowPhaseStateResult {
  const definition: WorkflowDefinition = {
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          { id: 'implement', name: 'Implement', agent: 'executor', mcps: [], retries: 0 },
          { id: 'write-tests', name: 'Write tests', agent: 'tester', mcps: [], retries: 0 },
        ],
      },
      {
        id: 'verify',
        label: 'Sprint review',
        color: '#a87a2c',
        steps: [
          { id: 'sprint-verify', name: 'Sprint verification', agent: 'verifier', mcps: [], retries: 0 },
          { id: 'human-review', name: 'Human review', agent: 'human', mcps: [], retries: 0 },
        ],
      },
    ],
  };

  return {
    definition,
    currentStepId: null,
    stepStates: [
      { stepId: 'implement', status: 'pending' },
      { stepId: 'write-tests', status: 'pending' },
      { stepId: 'sprint-verify', status: 'pending' },
      { stepId: 'human-review', status: 'pending' },
    ],
    isLoading: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers — hex → rgb conversion for JSDOM style assertions
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });

  // jsdom does not implement scrollIntoView
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowProgressTimeline', () => {

  // ── AC1: State-keyed border colors ────────────────────────────────────────

  it('renders done step with border-status-success border class', () => {
    const phaseState = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const doneItem = screen.getByTestId('step-item-implement');
    expect(doneItem.className).toContain('border-status-success');
  });

  it('renders running step with border-status-error border class (fallback — status-running absent)', () => {
    const phaseState = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const runningItem = screen.getByTestId('step-item-write-tests');
    expect(runningItem.className).toContain('border-status-error');
  });

  it('renders pending step with border-border-primary border class', () => {
    const phaseState = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const pendingItem = screen.getByTestId('step-item-task-verify');
    expect(pendingItem.className).toContain('border-border-primary');
  });

  // ── AC2: Pulse animation on running bullet only ───────────────────────────

  it("applies 1.4s infinite pulse animation to running step's bullet", () => {
    const phaseState = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const runningBullet = screen.getByTestId('step-bullet-write-tests');
    expect(runningBullet.style.animation).toContain('1.4s');
    expect(runningBullet.style.animation).toContain('infinite');
  });

  it('does NOT apply pulse animation to done or pending step bullets', () => {
    const phaseState = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    // done bullet
    const doneBullet = screen.getByTestId('step-bullet-implement');
    expect(doneBullet.style.animation ?? '').toBe('');

    // pending bullet
    const pendingBullet = screen.getByTestId('step-bullet-task-verify');
    expect(pendingBullet.style.animation ?? '').toBe('');
  });

  // ── AC3: Log lines — degraded mode (window is null → no log lines) ────────

  it('renders no log lines for non-pending steps when time-window is unavailable (degraded mode)', () => {
    const phaseState = makePhaseState({
      stepStatuses: { implement: 'done', 'write-tests': 'running', 'task-verify': 'pending' },
    });

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const allLogLines = document.querySelectorAll('[data-testid^="log-line-implement"]');
    expect(allLogLines.length).toBe(0);

    const runningLogLines = document.querySelectorAll('[data-testid^="log-line-write-tests"]');
    expect(runningLogLines.length).toBe(0);
  });

  // ── AC4: Delta-driven re-render ───────────────────────────────────────────

  it('updates step border when phaseState prop changes on rerender', () => {
    const initialState = makePhaseState({
      stepStatuses: { implement: 'pending', 'write-tests': 'pending', 'task-verify': 'pending' },
    });

    const { rerender } = render(
      <WorkflowProgressTimeline runId="run-A" phaseState={initialState} />,
    );

    expect(screen.getByTestId('step-item-implement').className).toContain('border-border-primary');

    const updatedState = makePhaseState({
      stepStatuses: { implement: 'running', 'write-tests': 'pending', 'task-verify': 'pending' },
    });

    act(() => {
      rerender(<WorkflowProgressTimeline runId="run-A" phaseState={updatedState} />);
    });

    expect(screen.getByTestId('step-item-implement').className).toContain('border-status-error');
  });

  // ── AC5: runId=null renders placeholder ──────────────────────────────────

  it('renders "No active run" placeholder when runId is null', () => {
    render(<WorkflowProgressTimeline runId={null} phaseState={EMPTY_PHASE_STATE} />);

    expect(screen.getByTestId('workflow-progress-timeline-empty')).toBeInTheDocument();
    expect(screen.getByText('No active run')).toBeInTheDocument();
  });

  // ── AC6: isLoading placeholder ────────────────────────────────────────────

  it('renders "Loading workflow state…" placeholder when phaseState.isLoading is true', () => {
    const loadingState: UseWorkflowPhaseStateResult = { ...EMPTY_PHASE_STATE, isLoading: true };

    render(<WorkflowProgressTimeline runId="run-A" phaseState={loadingState} />);

    expect(screen.getByText('Loading workflow state…')).toBeInTheDocument();
  });

  // ── AC7: error placeholder ────────────────────────────────────────────────

  it('renders "Failed to load workflow state:" placeholder when phaseState.error is non-null', () => {
    const errorState: UseWorkflowPhaseStateResult = {
      ...EMPTY_PHASE_STATE,
      error: new Error('network timeout'),
    };

    render(<WorkflowProgressTimeline runId="run-A" phaseState={errorState} />);

    expect(screen.getByText(/Failed to load workflow state:.*network timeout/)).toBeInTheDocument();
  });

  // ── AC8: null definition (not loading, no error) ──────────────────────────

  it('renders "No workflow data" when phaseState.definition is null with no loading and no error', () => {
    render(<WorkflowProgressTimeline runId="run-A" phaseState={EMPTY_PHASE_STATE} />);

    expect(screen.getByText('No workflow data')).toBeInTheDocument();
  });

  // ── AC9: Phase headers ────────────────────────────────────────────────────

  it('renders phase headers with swatch background matching phase color, label text, and step count', () => {
    const phaseState = makeTwoPhaseState();

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const execHeader = screen.getByTestId('phase-header-execute');
    expect(execHeader).toBeInTheDocument();

    const execSwatch = screen.getByTestId('phase-swatch-execute');
    expect(execSwatch.style.background).toBe(hexToRgb('#c96442'));

    expect(screen.getByText('Execute')).toBeInTheDocument();
    const stepCounts = screen.getAllByText('2 steps');
    expect(stepCounts.length).toBeGreaterThanOrEqual(1);

    const verifyHeader = screen.getByTestId('phase-header-verify');
    expect(verifyHeader).toBeInTheDocument();

    const verifySwatch = screen.getByTestId('phase-swatch-verify');
    expect(verifySwatch.style.background).toBe(hexToRgb('#a87a2c'));

    expect(screen.getByText('Sprint review')).toBeInTheDocument();
    expect(screen.getAllByText('2 steps').length).toBe(2);
  });

  // ── "creates ⟨artifact⟩" footer chip (Agent D) ────────────────────────────

  it('renders a "creates ⟨artifact⟩" chip for a step with outputArtifact and opens its tab on click', () => {
    useCenterPaneStore.setState({ bySession: {} });

    const phaseState: UseWorkflowPhaseStateResult = {
      definition: {
        id: 'planner',
        phases: [
          {
            id: 'plan',
            label: 'Plan',
            color: '#3b6dd6',
            steps: [
              {
                id: 'write-spec',
                name: 'Write idea spec',
                agent: 'idea-extractor',
                mcps: [],
                retries: 0,
                outputArtifact: { atype: 'idea-spec', label: 'idea spec' },
              },
            ],
          },
        ],
      },
      currentStepId: null,
      stepStates: [{ stepId: 'write-spec', status: 'pending' }],
      isLoading: false,
      error: null,
    };

    render(<WorkflowProgressTimeline runId="run-A" phaseState={phaseState} />);

    const chip = screen.getByTestId('step-artifact-chip-idea-spec');
    expect(chip).toHaveTextContent('creates idea spec');

    // No run in activeRunsStore → sessionKey falls back to the runId ("run-A").
    act(() => {
      fireEvent.click(chip);
    });

    const session = useCenterPaneStore.getState().bySession['run-A'];
    const artifactTab = session?.tabs.find((t) => t.kind === 'artifact' && t.atype === 'idea-spec');
    expect(artifactTab).toBeDefined();
    expect(session?.activeTabId).toBe(artifactTab?.id);
  });
});
