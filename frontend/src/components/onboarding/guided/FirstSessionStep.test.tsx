/**
 * FirstSessionStep — guided step 13 ("Launch your first session"). Drives the
 * REAL onboardingStore + backlogStore (radio value, ideas list) so the pick →
 * seed-block → launch wiring is exercised end to end; `launchFirstSession`
 * (the Planner/Ship launcher) and `useQuickSession` (the Quick launcher) are
 * mocked, mirroring how GuidedSetupSurface.test.tsx isolates IPC/telemetry.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

const launchFirstFlow = vi.fn();
const startWithDefaults = vi.fn();
const quickStart = vi.fn();

vi.mock('./launchFirstSession', async () => {
  const actual = await vi.importActual<typeof import('./launchFirstSession')>('./launchFirstSession');
  return {
    ...actual,
    launchFirstFlow: (...a: unknown[]) => launchFirstFlow(...a),
  };
});

let quickOnSuccess: ((sessionId: string) => void) | undefined;
vi.mock('../../../hooks/useQuickSession', () => ({
  useQuickSession: (opts: { onSuccess?: (sessionId: string) => void }) => {
    quickOnSuccess = opts.onSuccess;
    return {
      start: (...a: unknown[]) => quickStart(...a),
      startWithDefaults: (...a: unknown[]) => startWithDefaults(...a),
      isStarting: false,
      error: null,
    };
  },
}));

import { FirstSessionStep } from './FirstSessionStep';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { useBacklogStore } from '../../../stores/backlogStore';

const PROJECT = { id: 7, name: 'dogwalkr' };

function makeIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: overrides.id ?? 'idea-1',
    project_id: 7,
    type: 'idea',
    ref: 'IDEA-001',
    title: 'Untitled idea',
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: 'small',
    board_id: 'board-1',
    stage_id: 'stage-1',
    archived_at: null,
    decomposed_at: null,
    approved_at: null,
    sort_order: null,
    version: 1,
    stage_position: 0,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function enterStep13(): void {
  act(() => {
    useOnboardingStore.setState({
      status: 'active',
      step: 13,
      maxVisitedStep: 13,
      hydrated: true,
      multiRuntime: true,
      assistantAvailable: true,
      sessionChoice: 'planner',
    });
  });
}

describe('FirstSessionStep', () => {
  const onLaunched = vi.fn();
  const onFinishWithoutLaunching = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    quickOnSuccess = undefined;
    enterStep13();
    act(() => {
      useBacklogStore.setState({ tasks: [], loaded: true });
    });
  });

  it('renders three radios with planner preselected, and the eyebrow reads STEP 7 OF 8', () => {
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    const plannerRadio = screen.getByText('Planning session').closest('[role="radio"]');
    expect(plannerRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('guided-step-eyebrow')).toHaveTextContent('STEP 7 OF 8');
  });

  it('lists only the current project’s ideas, all checked by default', () => {
    act(() => {
      useBacklogStore.setState({
        tasks: [
          makeIdea({ id: 'i1', ref: 'IDEA-001', title: 'First idea', created_at: '2026-09-01T00:00:00.000Z' }),
          makeIdea({ id: 'i2', ref: 'IDEA-002', title: 'Second idea', created_at: '2026-09-02T00:00:00.000Z' }),
          makeIdea({ id: 'i3', ref: 'IDEA-003', title: 'Other project idea', project_id: 99 }),
        ],
        loaded: true,
      });
    });
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    expect(screen.getByText('First idea')).toBeInTheDocument();
    expect(screen.getByText('Second idea')).toBeInTheDocument();
    expect(screen.queryByText('Other project idea')).not.toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    for (const cb of checkboxes) expect(cb).toHaveAttribute('aria-checked', 'true');
  });

  it('unchecking one idea then launching planner passes only the remaining id', async () => {
    act(() => {
      useBacklogStore.setState({
        tasks: [
          makeIdea({ id: 'i1', title: 'First idea', created_at: '2026-09-01T00:00:00.000Z' }),
          makeIdea({ id: 'i2', title: 'Second idea', created_at: '2026-09-02T00:00:00.000Z' }),
        ],
        loaded: true,
      });
    });
    const launched = { kind: 'planner' as const, sessionId: 's1', runId: 'r1' };
    launchFirstFlow.mockResolvedValue(launched);

    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );

    fireEvent.click(screen.getByText('First idea').closest('[role="checkbox"]')!);
    fireEvent.click(screen.getByTestId('onboarding-first-session-launch'));

    await waitFor(() => expect(launchFirstFlow).toHaveBeenCalled());
    expect(launchFirstFlow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'planner', projectId: 7, ideaIds: ['i2'] }),
    );
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(launched));
  });

  it('selecting Ship shows the single-select and launches with one ideaId', async () => {
    act(() => {
      useBacklogStore.setState({
        tasks: [
          makeIdea({ id: 'i1', title: 'First idea', created_at: '2026-09-01T00:00:00.000Z' }),
          makeIdea({ id: 'i2', title: 'Second idea', created_at: '2026-09-02T00:00:00.000Z' }),
        ],
        loaded: true,
      });
    });
    const launched = { kind: 'ship' as const, sessionId: 's2', runId: 'r2' };
    launchFirstFlow.mockResolvedValue(launched);

    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );

    fireEvent.click(screen.getByText('Ship session').closest('[role="radio"]')!);
    // 3 session-choice radios + 2 idea single-select radios; the newest idea
    // (i2) is preselected.
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByText('Second idea').closest('[role="radio"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByTestId('onboarding-first-session-launch'));

    await waitFor(() =>
      expect(launchFirstFlow).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'ship', projectId: 7, ideaIds: ['i2'] }), // newest idea preselected
      ),
    );
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(launched));
  });

  it('disables the primary and shows a notice when Ship has no ideas', () => {
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    fireEvent.click(screen.getByText('Ship session').closest('[role="radio"]')!);
    expect(screen.getByTestId('onboarding-first-session-launch')).toBeDisabled();
    expect(screen.getByText(/Ship needs an idea to build/)).toBeInTheDocument();
  });

  it('Quick calls startWithDefaults("quick")', () => {
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    fireEvent.click(screen.getByText('Quick session').closest('[role="radio"]')!);
    fireEvent.click(screen.getByTestId('onboarding-first-session-launch'));
    expect(startWithDefaults).toHaveBeenCalledWith('quick');
  });

  it('Quick session onSuccess forwards the sessionId to onLaunched', () => {
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    quickOnSuccess?.('quick-session-1');
    expect(onLaunched).toHaveBeenCalledWith({ kind: 'quick', sessionId: 'quick-session-1', runId: null });
  });

  it('"Finish without launching" calls the callback', () => {
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));
    expect(onFinishWithoutLaunching).toHaveBeenCalled();
  });

  it('renders an alert when the launch fails', async () => {
    launchFirstFlow.mockRejectedValue(new Error('The planner flow is not available for this project'));
    render(
      <FirstSessionStep
        project={PROJECT}
        onLaunched={onLaunched}
        onFinishWithoutLaunching={onFinishWithoutLaunching}
      />,
    );
    fireEvent.click(screen.getByTestId('onboarding-first-session-launch'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The planner flow is not available for this project'),
    );
    expect(onLaunched).not.toHaveBeenCalled();
  });
});
