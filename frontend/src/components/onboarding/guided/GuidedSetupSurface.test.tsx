/**
 * GuidedSetupSurface — the tour's second phase (steps 7 + 8).
 *
 * Drives the REAL onboardingStore + navigationStore (only the IPC/telemetry
 * layers are mocked) so the whole branch → pick → create → finale chain is
 * exercised end to end: which screen each choice renders, the exact
 * `projects:create` payload, the 'project-created' broadcast, and the four
 * finale side effects that have to land BEFORE the shell mounts (rail expanded,
 * greeting primed, Human review opened, status completed).
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

import { GuidedSetupSurface } from './GuidedSetupSurface';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { useNavigationStore } from '../../../stores/navigationStore';
import { peekAssistantGreeting } from '../../agentRail/onboardingGreeting';
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

  it('"Not sure yet" completes the tour instead of advancing', () => {
    enterGuided(7, 'existing');
    render(<GuidedSetupSurface />);

    fireEvent.click(screen.getByRole('radio', { name: /Not sure yet/ }));
    expect(useOnboardingStore.getState().projectChoice).toBe('unsure');

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    expect(useOnboardingStore.getState().status).toBe('completed');
    expect(useOnboardingStore.getState().step).toBe(7);
    // A no-project exit still opens the rail with the generic greeting.
    expect(peekAssistantGreeting()).toBe(
      "You're set up. If you need more help, ask me questions at any time.",
    );
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');
  });

  it('the Skip link completes the tour outright (no Sidebar resume card)', () => {
    enterGuided(7, 'existing');
    render(<GuidedSetupSurface />);

    fireEvent.click(screen.getByTestId('onboarding-guided-skip'));

    expect(useOnboardingStore.getState().status).toBe('completed');
    expect(peekAssistantGreeting()).toBe(
      "You're set up. If you need more help, ask me questions at any time.",
    );
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');
  });
});

describe('GuidedSetupSurface — step 8, existing project', () => {
  it('browses, derives the name from the folder, creates, and runs the finale', async () => {
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

    await waitFor(() => expect(useOnboardingStore.getState().status).toBe('completed'));
    expect(projectsCreate).toHaveBeenCalledWith({
      name: 'dogwalkr',
      path: '/Users/me/Developer/dogwalkr',
      active: false,
    });
    expect(trackEvent).toHaveBeenCalledWith('project_created', {});
    expect(broadcast).toHaveBeenCalledTimes(1);
    // Finale side effects, all staged before the shell mounts. The active
    // project is stamped so the project tree's mount-time auto-select (which
    // opens the project OVERVIEW) cannot override the review queue.
    const created = (await projectsCreate.mock.results[0]?.value) as { data?: { id: number } };
    expect(useNavigationStore.getState().activeProjectId).toBe(created.data?.id);
    expect(useNavigationStore.getState().activeProjectId).not.toBeNull();
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    expect(peekAssistantGreeting()).toBe(
      'dogwalkr is set up. If you need more help, ask me questions at any time.',
    );
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false');

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

    await waitFor(() => expect(useOnboardingStore.getState().status).toBe('completed'));
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
