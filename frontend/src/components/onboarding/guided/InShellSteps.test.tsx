/**
 * Guided steps 9, 12, and 14 — the "in-shell" screens rendered once the
 * project exists and the Sidebar (and later the AgentRail) are mounted beside
 * the guided column. Drives the REAL onboardingStore, activeRunsStore, and
 * sessionStore (no IPC layers involved, so nothing needs mocking there).
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ProjectHomeStep } from './ProjectHomeStep';
import { SessionTypesPreviewStep } from './SessionTypesPreviewStep';
import { AssistantRailStep } from './AssistantRailStep';
import { LaunchingStep } from './LaunchingStep';
import { GuidedMarker } from './GuidedMarker';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { useActiveRunsStore, type ActiveRunRow } from '../../../stores/activeRunsStore';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  ONBOARDING_PROJECT_HOME_STEP,
  ONBOARDING_ASSISTANT_RAIL_STEP,
  ONBOARDING_LAUNCHING_STEP,
} from '../../../utils/onboarding';
import type { Session } from '../../../types/session';

function seedStore(step: number, assistantAvailable = true): void {
  act(() => {
    useOnboardingStore.setState({
      status: 'active',
      step,
      hydrated: true,
      multiRuntime: true,
      assistantAvailable,
      guidedProject: { id: 7, name: 'dogwalkr' },
    });
  });
}

function makeActiveRunRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
  return {
    id: 'run-1',
    workflow_id: 'wf-planner',
    project_id: 7,
    status: 'running',
    worktree_path: '/tmp/wt',
    branch_name: 'run-1-branch',
    permission_mode_snapshot: 'auto',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    workflowName: 'planner',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'quick-1',
    worktreePath: '/tmp/wt',
    prompt: '',
    status: 'ready',
    createdAt: '2026-01-01 12:00:00',
    output: [],
    jsonMessages: [],
    projectId: 7,
    isMainRepo: false,
    runId: null,
    ...overrides,
  };
}

beforeEach(() => {
  act(() => {
    useActiveRunsStore.setState({ runsByProject: {} });
    useSessionStore.setState({ sessions: [] });
  });
});

describe('ProjectHomeStep (tour step 9)', () => {
  beforeEach(() => seedStore(ONBOARDING_PROJECT_HOME_STEP));

  it('renders the heading and both callouts', () => {
    render(<ProjectHomeStep projectName="dogwalkr" onContinue={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByText('Your project lives here')).toBeInTheDocument();
    expect(screen.getByText('Click the project to get an overview of it')).toBeInTheDocument();
    expect(
      screen.getByText('Start a new agent session within the project'),
    ).toBeInTheDocument();
  });

  it('reads "STEP 3 OF 8" when the assistant is available', () => {
    render(<ProjectHomeStep projectName="dogwalkr" onContinue={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByTestId('guided-step-eyebrow')).toHaveTextContent('STEP 3 OF 8');
  });

  it('reads "STEP 3 OF 5" when the assistant is unavailable', () => {
    seedStore(ONBOARDING_PROJECT_HOME_STEP, false);
    render(<ProjectHomeStep projectName="dogwalkr" onContinue={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByTestId('guided-step-eyebrow')).toHaveTextContent('STEP 3 OF 5');
  });

  it('calls onContinue and onSkip', () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();
    render(<ProjectHomeStep projectName="dogwalkr" onContinue={onContinue} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('onboarding-project-home-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe('AssistantRailStep (tour step 12)', () => {
  beforeEach(() => seedStore(ONBOARDING_ASSISTANT_RAIL_STEP));

  it('renders the heading and eyebrow "STEP 6 OF 8"', () => {
    render(<AssistantRailStep onContinue={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByText('Meet the Cyboflow assistant')).toBeInTheDocument();
    expect(screen.getByTestId('guided-step-eyebrow')).toHaveTextContent('STEP 6 OF 8');
  });

  it('calls onContinue and onSkip', () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();
    render(<AssistantRailStep onContinue={onContinue} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('onboarding-assistant-rail-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe('LaunchingStep (tour step 14)', () => {
  beforeEach(() => seedStore(ONBOARDING_LAUNCHING_STEP));

  it('renders the heading and the planner label', () => {
    render(
      <LaunchingStep
        projectId={7}
        projectName="dogwalkr"
        launched={{ kind: 'planner', sessionId: 'sess-1', runId: 'run-1' }}
        onStay={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('Launching your session now')).toBeInTheDocument();
    expect(screen.getByText('Planner · dogwalkr')).toBeInTheDocument();
  });

  it('shows the live run status once activeRunsStore reports it', () => {
    act(() => {
      useActiveRunsStore.setState({
        runsByProject: { 7: [makeActiveRunRow({ id: 'run-1', status: 'running' })] },
      });
    });
    render(
      <LaunchingStep
        projectId={7}
        projectName="dogwalkr"
        launched={{ kind: 'planner', sessionId: 'sess-1', runId: 'run-1' }}
        onStay={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('falls back to "starting" when the run is not yet in activeRunsStore', () => {
    render(
      <LaunchingStep
        projectId={7}
        projectName="dogwalkr"
        launched={{ kind: 'ship', sessionId: 'sess-1', runId: 'run-2' }}
        onStay={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('starting')).toBeInTheDocument();
  });

  it('renders "Quick session · dogwalkr" for a quick-kind launched session', () => {
    act(() => {
      useSessionStore.setState({ sessions: [makeSession({ id: 'sess-1', status: 'running' })] });
    });
    render(
      <LaunchingStep
        projectId={7}
        projectName="dogwalkr"
        launched={{ kind: 'quick', sessionId: 'sess-1', runId: null }}
        onStay={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('Quick session · dogwalkr')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('calls onStay and onOpenSession', () => {
    const onStay = vi.fn();
    const onOpenSession = vi.fn();
    render(
      <LaunchingStep
        projectId={7}
        projectName="dogwalkr"
        launched={{ kind: 'quick', sessionId: 'sess-1', runId: null }}
        onStay={onStay}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByTestId('onboarding-launching-stay'));
    expect(onStay).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('onboarding-launching-open'));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });
});

describe('GuidedMarker', () => {
  it('renders when the store is on its step', () => {
    seedStore(ONBOARDING_LAUNCHING_STEP);
    render(<GuidedMarker step={ONBOARDING_LAUNCHING_STEP} n={1} testId="marker-under-test" />);
    expect(screen.getByTestId('marker-under-test')).toBeInTheDocument();
  });

  it('renders nothing when the store is on a different step', () => {
    seedStore(ONBOARDING_PROJECT_HOME_STEP);
    render(<GuidedMarker step={ONBOARDING_LAUNCHING_STEP} n={1} testId="marker-under-test" />);
    expect(screen.queryByTestId('marker-under-test')).not.toBeInTheDocument();
  });
});

describe('ProjectHomeStep — no project ("Not sure yet")', () => {
  it('renders the future-tense variant with the Add Project callout first', () => {
    seedStore(ONBOARDING_PROJECT_HOME_STEP);
    act(() => useOnboardingStore.setState({ guidedProject: null }));
    render(<ProjectHomeStep projectName={null} onContinue={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Your projects will live here' })).toBeInTheDocument();
    expect(screen.getByText('Click Add Project to add your first one at any time')).toBeInTheDocument();
    // The leader arrow needs real geometry (jsdom rects are 0×0) — nothing portalled.
    expect(screen.queryByTestId('onboarding-callout-add-project-leader')).toBeNull();
    expect(screen.getByText('Click a project to get an overview of it')).toBeInTheDocument();
    expect(screen.getByText('Start a new agent session within the project')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-project-home-continue')).toBeInTheDocument();
  });
});

describe('SessionTypesPreviewStep (tour step 13, no project)', () => {
  it('lists the three session types read-only and offers only Finish set-up', () => {
    seedStore(13);
    act(() => useOnboardingStore.setState({ guidedProject: null }));
    const onFinish = vi.fn();
    render(<SessionTypesPreviewStep onFinish={onFinish} />);

    expect(screen.getByRole('heading', { name: 'Sessions you can launch' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(screen.getByText('Planning session')).toBeInTheDocument();
    expect(screen.getByText('Ship session')).toBeInTheDocument();
    expect(screen.getByText('Quick session')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByTestId('onboarding-guided-skip')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-session-preview-finish'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
