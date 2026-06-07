/**
 * QuickSessionCanvas tests — the resting-view top plane (Concept C).
 *
 * useSessionMetrics + useLaunchWorkflow are mocked (each has its own unit test);
 * the workflow catalogue comes from a mocked trpc.cyboflow.workflows.list, and
 * IdeaPickerModal is stubbed so the Planner idea-gate is observable.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLaunch, mockListQuery } = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockListQuery: vi.fn(),
}));

vi.mock('../../../hooks/useSessionMetrics', () => ({
  useSessionMetrics: () => ({
    elapsed: '4m 12s',
    tokens: '12.4k',
    filesSeen: 18,
    diff: { plus: 0, minus: 0 },
    model: 'sonnet 4.5',
    branch: 'quick-20260607',
  }),
}));

vi.mock('../../../hooks/useLaunchWorkflow', () => ({
  useLaunchWorkflow: () => ({ launch: mockLaunch, isLaunching: false, error: null }),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { workflows: { list: { query: mockListQuery } } } },
}));

vi.mock('../IdeaPickerModal', () => ({
  IdeaPickerModal: (props: { isOpen: boolean; onPicked: (id: string) => void }) =>
    props.isOpen ? (
      <button data-testid="mock-pick-idea" onClick={() => props.onPicked('idea-x')}>
        pick idea
      </button>
    ) : null,
}));

import { QuickSessionCanvas } from '../QuickSessionCanvas';
import type { Session } from '../../../types/session';

const SESSION = {
  id: 's1',
  name: 'tester-mctest',
  worktreePath: '/repo/.cyboflow/worktrees/quick-20260607',
  prompt: '',
  status: 'running',
  createdAt: new Date().toISOString(),
  output: [],
  jsonMessages: [],
} as Session;

const WORKFLOWS = [
  { id: 'wf-planner', name: 'planner', spec_json: '' },
  { id: 'wf-sprint', name: 'sprint', spec_json: '' },
];

function renderCanvas(onBrowseAll = vi.fn()) {
  return render(
    <QuickSessionCanvas
      session={SESSION}
      projectId={3}
      projectName="tester-mctest"
      onBrowseAll={onBrowseAll}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListQuery.mockResolvedValue(WORKFLOWS);
});

describe('QuickSessionCanvas', () => {
  it('renders the live session node with metrics', () => {
    renderCanvas();
    expect(screen.getByTestId('quick-session-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('quick-session-node-model')).toHaveTextContent('sonnet 4.5');
    expect(screen.getByTestId('quick-session-stat-elapsed')).toHaveTextContent('4m 12s');
    expect(screen.getByTestId('quick-session-stat-tokens')).toHaveTextContent('12.4k');
    expect(screen.getByTestId('quick-session-stat-files')).toHaveTextContent('18');
    expect(screen.getByTestId('quick-session-stat-diff')).toHaveTextContent('+0 −0');
    expect(screen.getByTestId('quick-session-node-sub')).toHaveTextContent('tester-mctest');
  });

  it('lists the real workflow catalogue with the default (sprint) first', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(screen.getByTestId('quick-session-launch-sprint')).toBeInTheDocument();
    });
    const buttons = screen.getAllByTestId(/^quick-session-launch-/);
    expect(buttons[0]).toHaveAttribute('data-testid', 'quick-session-launch-sprint');
    expect(screen.getByTestId('quick-session-launch-planner')).toHaveTextContent('/planner');
    expect(screen.getByTestId('quick-session-browse-all')).toHaveTextContent('Browse all 2 workflows');
  });

  it('launches Sprint directly (no idea gate)', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-sprint'));
    fireEvent.click(screen.getByTestId('quick-session-launch-sprint'));
    expect(mockLaunch).toHaveBeenCalledWith('wf-sprint');
    expect(screen.queryByTestId('mock-pick-idea')).not.toBeInTheDocument();
  });

  it('routes Planner through the idea-picker gate before launching', async () => {
    renderCanvas();
    await waitFor(() => screen.getByTestId('quick-session-launch-planner'));
    fireEvent.click(screen.getByTestId('quick-session-launch-planner'));
    // Gate opens; launch has NOT fired yet.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-pick-idea')).toBeInTheDocument();
    // Pick an idea → launch with the chosen ideaId.
    fireEvent.click(screen.getByTestId('mock-pick-idea'));
    expect(mockLaunch).toHaveBeenCalledWith('wf-planner', 'idea-x');
  });

  it('opens the full picker via Browse all', async () => {
    const onBrowseAll = vi.fn();
    renderCanvas(onBrowseAll);
    fireEvent.click(screen.getByTestId('quick-session-browse-all'));
    expect(onBrowseAll).toHaveBeenCalledTimes(1);
  });
});
