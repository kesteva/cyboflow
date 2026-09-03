/**
 * GuidedSetupSurface — the tour's second phase (steps 7 + 8).
 *
 * Drives the REAL onboardingStore + navigationStore (only the IPC/telemetry
 * layers are mocked) so the whole branch → pick → create → finale chain is
 * exercised end to end: which screen each choice renders, the exact
 * `projects:create` payload, the 'project-created' broadcast, and the step-9
 * handover (active project stamped BEFORE the Sidebar mounts, project recorded
 * on the store). The in-shell screens (9-14) have their own tests.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openDirectory = vi.fn();
const projectsCreate = vi.fn();
const trackEvent = vi.fn();

vi.mock('../../../utils/api', () => ({
  API: {
    dialog: { openDirectory: (...a: unknown[]) => openDirectory(...a) },
    projects: { create: (...a: unknown[]) => projectsCreate(...a) },
  },
}));

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: (...a: unknown[]) => trackEvent(...a),
}));

// The in-shell screens that reach the network (assistant thread, launchers)
// are stubbed: this file tests the SURFACE's routing + exits, not the screens.
vi.mock('./FirstIdeaStep', () => ({
  FirstIdeaStep: () => <div data-testid="stub-first-idea" />,
}));
vi.mock('./IdeaProposalsStep', () => ({
  IdeaProposalsStep: () => <div data-testid="stub-idea-proposals" />,
}));
vi.mock('./FirstSessionStep', () => ({
  FirstSessionStep: () => <div data-testid="stub-first-session" />,
}));
vi.mock('../../../trpc/client', () => ({ trpc: {} }));

import { GuidedSetupSurface } from './GuidedSetupSurface';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { useNavigationStore } from '../../../stores/navigationStore';
import { peekAssistantGreeting } from '../../agentRail/onboardingGreeting';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import type { Project } from '../../../types/project';

const RAIL_COLLAPSED_KEY = 'cyboflow.agentRail.collapsed';

function createdProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 7,
    name: 'dogwalkr',
    path: '/Users/me/Developer/dogwalkr',
    active: false,
    created_at: '2026-09-02T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

/** Put the store on a guided step with the tour running. */
function enterGuided(step: number, projectChoice: 'existing' | 'new' | 'unsure'): void {
  act(() => {
    useOnboardingStore.setState({
      status: 'active',
      step,
      maxVisitedStep: step,
      projectChoice,
      hydrated: true,
    });
  });
}

beforeEach(() => {
  openDirectory.mockReset();
  projectsCreate.mockReset();
  trackEvent.mockReset();
  localStorage.clear();
  act(() => {
    useNavigationStore.setState({ view: 'home', humanReviewOpen: false, activeProjectId: null });
    useOnboardingStore.setState({
      status: 'idle',
      step: 0,
      maxVisitedStep: 0,
      projectChoice: 'existing',
      guidedProject: null,
      assistantAvailable: true,
      launched: null,
      hydrated: false,
    });
  });
});

describe('GuidedSetupSurface — step 7 (add a project)', () => {
  it('renders the three choices and advances to the detail step', () => {
    enterGuided(7, 'existing');
    render(<GuidedSetupSurface />);

    expect(screen.getByRole('heading', { name: 'Add a project' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Existing project/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /New project/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Not sure yet/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    expect(useOnboardingStore.getState().step).toBe(8);
    expect(useOnboardingStore.getState().status).toBe('active');
  });

  it('"Not sure yet" continues into the shell (step 9) with no project and no finale', () => {
    enterGuided(7, 'existing');
    render(<GuidedSetupSurface />);

    fireEvent.click(screen.getByRole('radio', { name: /Not sure yet/ }));
    expect(useOnboardingStore.getState().projectChoice).toBe('unsure');

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    expect(useOnboardingStore.getState().status).toBe('active');
    expect(useOnboardingStore.getState().step).toBe(9);
    expect(useOnboardingStore.getState().guidedProject).toBeNull();
    expect(peekAssistantGreeting()).toBeNull();
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBeNull();
    // The no-project variant of step 9.
    expect(screen.getByRole('heading', { name: 'Your projects will live here' })).toBeInTheDocument();
  });

  it('the Skip link parks the tour (Sidebar resume card) and stages the shell frame', () => {
    enterGuided(7, 'existing');
    render(<GuidedSetupSurface />);

    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));

    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useOnboardingStore.getState().step).toBe(7);
    expect(peekAssistantGreeting()).toBe(
      "You're set up. If you need more help, ask me questions at any time.",
    );
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');
  });
});

describe('GuidedSetupSurface — step 8, existing project', () => {
  it('browses, derives the name from the folder, creates, and continues INTO the shell (step 9)', async () => {
    openDirectory.mockResolvedValue({ success: true, data: '/Users/me/Developer/dogwalkr' });
    projectsCreate.mockResolvedValue({ success: true, data: createdProject() });
    const broadcast = vi.fn();
    window.addEventListener('project-created', broadcast);

    enterGuided(8, 'existing');
    render(<GuidedSetupSurface />);

    expect(screen.getByRole('heading', { name: 'Pick the folder' })).toBeInTheDocument();
    // Nothing picked yet — the primary is inert.
    expect(screen.getByRole('button', { name: /Add project/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Browse/ }));
    await waitFor(() => expect(screen.getByText('dogwalkr')).toBeInTheDocument());
    expect(openDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.arrayContaining(['openDirectory', 'createDirectory']),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Add project/ }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(9));
    // The tour is NOT over: the project screens hand over to the in-shell
    // guided steps, which render around the project just created.
    expect(useOnboardingStore.getState().status).toBe('active');
    expect(useOnboardingStore.getState().guidedProject).toEqual({ id: 7, name: 'dogwalkr' });
    expect(projectsCreate).toHaveBeenCalledWith({
      name: 'dogwalkr',
      path: '/Users/me/Developer/dogwalkr',
      active: false,
    });
    expect(trackEvent).toHaveBeenCalledWith('project_created', {});
    expect(broadcast).toHaveBeenCalledTimes(1);
    // The active project is stamped BEFORE the step-9 Sidebar mounts, so the
    // project tree's mount-time auto-select (which opens the project OVERVIEW)
    // has nothing to do.
    const created = (await projectsCreate.mock.results[0]?.value) as { data?: { id: number } };
    expect(useNavigationStore.getState().activeProjectId).toBe(created.data?.id);
    expect(useNavigationStore.getState().activeProjectId).not.toBeNull();
    // No finale yet: Human review is not opened and no greeting is parked —
    // those belong to the exits from steps 9-14.
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
    expect(peekAssistantGreeting()).toBeNull();
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBeNull();

    window.removeEventListener('project-created', broadcast);
  });

  it('shows a friendly message for an already-added folder and stays on the step', async () => {
    openDirectory.mockResolvedValue({ success: true, data: '/Users/me/Developer/dogwalkr' });
    projectsCreate.mockResolvedValue({
      success: false,
      error: 'UNIQUE constraint failed: projects.path',
    });

    enterGuided(8, 'existing');
    render(<GuidedSetupSurface />);

    fireEvent.click(screen.getByRole('button', { name: /Browse/ }));
    await waitFor(() => expect(screen.getByText('dogwalkr')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Add project/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'That folder is already a Cyboflow project.',
      ),
    );
    expect(useOnboardingStore.getState().status).toBe('active');
    expect(useOnboardingStore.getState().step).toBe(8);
    // The primary doubles as retry.
    expect(screen.getByRole('button', { name: /Add project/ })).toBeEnabled();
  });

  it('Back returns to the choice screen', () => {
    enterGuided(8, 'existing');
    render(<GuidedSetupSurface />);

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));

    expect(useOnboardingStore.getState().step).toBe(7);
  });
});

describe('GuidedSetupSurface — step 8, new project', () => {
  it('rejects a name with a separator, then composes <location>/<name> and creates', async () => {
    openDirectory.mockResolvedValue({ success: true, data: '/Users/me/Developer/' });
    projectsCreate.mockResolvedValue({ success: true, data: createdProject() });

    enterGuided(8, 'new');
    render(<GuidedSetupSurface />);

    expect(screen.getByRole('heading', { name: 'Create a project' })).toBeInTheDocument();
    const primary = screen.getByRole('button', { name: /Create project/ });
    expect(primary).toBeDisabled();

    const nameInput = screen.getByLabelText('NAME');
    fireEvent.change(nameInput, { target: { value: 'dog/walkr' } });
    expect(screen.getByText(/can't contain/)).toBeInTheDocument();
    expect(primary).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: 'dogwalkr' } });
    expect(screen.queryByText(/can't contain/)).not.toBeInTheDocument();
    // Location is still empty — a name alone is not enough.
    expect(primary).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Browse/ }));
    // Trailing separator on the location is dropped by the composer.
    await waitFor(() =>
      expect(screen.getByText('/Users/me/Developer/dogwalkr')).toBeInTheDocument(),
    );
    expect(screen.getByText('GIT INIT · MAIN')).toBeInTheDocument();
    expect(screen.getByText('FIRST COMMIT')).toBeInTheDocument();

    fireEvent.click(primary);

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(9));
    expect(useOnboardingStore.getState().status).toBe('active');
    expect(projectsCreate).toHaveBeenCalledWith({
      name: 'dogwalkr',
      path: '/Users/me/Developer/dogwalkr',
      active: false,
    });
  });
});

describe('GuidedSetupSurface — non-guided steps', () => {
  it('renders nothing on a modal step', () => {
    enterGuided(6, 'existing');
    const { container } = render(<GuidedSetupSurface />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('GuidedSetupSurface — the in-shell steps (9-14)', () => {
  const PROJECT = { id: 7, name: 'dogwalkr' };

  function enterShell(step: number, extra: Record<string, unknown> = {}): void {
    act(() => {
      useOnboardingStore.setState({
        status: 'active',
        step,
        maxVisitedStep: step,
        guidedProject: PROJECT,
        hydrated: true,
        ...extra,
      });
      useNavigationStore.setState({ activeProjectId: PROJECT.id });
    });
  }

  it('step 9 renders the project-home screen; Continue walks to the first-idea step', () => {
    enterShell(9);
    render(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Your project lives here' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('onboarding-project-home-continue'));
    expect(useOnboardingStore.getState().step).toBe(10);
    expect(screen.getByTestId('stub-first-idea')).toBeInTheDocument();
  });

  it('step 9 "Skip the set-up" PARKS the tour WITH the greeting (no conversation yet) and lands on Human review', () => {
    enterShell(9);
    render(<GuidedSetupSurface />);
    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));
    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useOnboardingStore.getState().step).toBe(9);
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    expect(useNavigationStore.getState().activeProjectId).toBe(PROJECT.id);
    expect(peekAssistantGreeting()).toBe(
      'dogwalkr is set up. If you need more help, ask me questions at any time.',
    );
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');
  });

  it('step 12 "Skip the set-up" after the thread was used (maxVisited ≥ 11) skips the greeting', () => {
    enterShell(12, { maxVisitedStep: 12 });
    render(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Meet the Cyboflow assistant' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));
    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    expect(peekAssistantGreeting()).toBeNull();
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');
  });

  it('step 14 renders nothing until a launch is recorded, then the launching screen', () => {
    enterShell(14, { launched: null });
    const { container, rerender } = render(<GuidedSetupSurface />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      useOnboardingStore.setState({ launched: { kind: 'planner', sessionId: 'sess-1', runId: 'run-1' } });
    });
    rerender(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Launching your session now' })).toBeInTheDocument();
  });

  it('step 14 "Open the session" selects the launched run, goes to the session view and completes — no Human review', () => {
    enterShell(14, { launched: { kind: 'planner', sessionId: 'sess-1', runId: 'run-1' } });
    // The real setActiveRun reaches the electron bridge (absent in jsdom) — the
    // contract under test is that it is called with the launched run + host.
    const setActiveRun = vi.fn();
    const original = useCyboflowStore.getState().setActiveRun;
    useCyboflowStore.setState({ setActiveRun });
    try {
      render(<GuidedSetupSurface />);
      fireEvent.click(screen.getByTestId('onboarding-launching-open'));
      expect(setActiveRun).toHaveBeenCalledWith('run-1', 'sess-1');
      expect(useOnboardingStore.getState().status).toBe('completed');
      expect(useNavigationStore.getState().view).toBe('session');
      expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
      expect(peekAssistantGreeting()).toBeNull();
    } finally {
      useCyboflowStore.setState({ setActiveRun: original });
    }
  });

  it('step 14 "Done — stay here" completes onto Human review', () => {
    enterShell(14, { launched: { kind: 'quick', sessionId: 'sess-2', runId: null } });
    render(<GuidedSetupSurface />);
    fireEvent.click(screen.getByTestId('onboarding-launching-stay'));
    expect(useOnboardingStore.getState().status).toBe('completed');
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
  });
});

describe('GuidedSetupSurface — the no-project branch ("Not sure yet")', () => {
  function enterNoProject(step: number, extra: Record<string, unknown> = {}): void {
    act(() => {
      useOnboardingStore.setState({
        status: 'active',
        step,
        maxVisitedStep: step,
        projectChoice: 'unsure',
        guidedProject: null,
        hydrated: true,
        ...extra,
      });
    });
  }

  it('step 9 renders the future-tense home screen and walks on to the first-idea step', () => {
    enterNoProject(9);
    render(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Your projects will live here' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('onboarding-project-home-continue'));
    expect(useOnboardingStore.getState().step).toBe(10);
    expect(screen.getByTestId('stub-first-idea')).toBeInTheDocument();
  });

  it('steps 10-12 render (the assistant screens take a null project)', () => {
    enterNoProject(11);
    const { rerender } = render(<GuidedSetupSurface />);
    expect(screen.getByTestId('stub-idea-proposals')).toBeInTheDocument();
    enterNoProject(12);
    rerender(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Meet the Cyboflow assistant' })).toBeInTheDocument();
  });

  it('step 13 is the read-only session preview; "Finish set-up" completes with no navigation', () => {
    enterNoProject(13);
    render(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Sessions you can launch' })).toBeInTheDocument();
    expect(screen.queryByTestId('stub-first-session')).toBeNull();
    expect(screen.queryByTestId('onboarding-guided-skip')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-session-preview-finish'));

    expect(useOnboardingStore.getState().status).toBe('completed');
    // No project: nothing to stamp, no Human review — LandingHome's empty state.
    expect(useNavigationStore.getState().activeProjectId).toBeNull();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');
    // The thread was used (maxVisited ≥ 11), so no parked greeting.
    expect(peekAssistantGreeting()).toBeNull();
  });

  it('step 9 "Skip the set-up" without a project parks the tour with the generic greeting', () => {
    enterNoProject(9);
    render(<GuidedSetupSurface />);
    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));
    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(peekAssistantGreeting()).toBe(
      "You're set up. If you need more help, ask me questions at any time.",
    );
  });

  it('adopts a project created from the Sidebar: active project stamped, screens switch variant', () => {
    enterNoProject(9);
    render(<GuidedSetupSurface />);
    expect(screen.getByRole('heading', { name: 'Your projects will live here' })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('project-created', { detail: createdProject() }));
    });

    expect(useOnboardingStore.getState().guidedProject).toEqual({ id: 7, name: 'dogwalkr' });
    expect(useOnboardingStore.getState().step).toBe(9);
    expect(useOnboardingStore.getState().status).toBe('active');
    expect(useNavigationStore.getState().activeProjectId).toBe(7);
    expect(screen.getByRole('heading', { name: 'Your project lives here' })).toBeInTheDocument();
  });

  it('step 14 never renders without a project', () => {
    enterNoProject(14, { launched: { kind: 'quick', sessionId: 's', runId: null } });
    const { container } = render(<GuidedSetupSurface />);
    expect(container).toBeEmptyDOMElement();
  });
});
