import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeAgent, makeStatus } from './fixtures';

let unlockMutate: ReturnType<typeof vi.fn>;
let listAgentsQuery: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      cloud: {
        status: { query: vi.fn().mockResolvedValue({ available: false }) },
        onCloudChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        unlock: { get mutate() { return unlockMutate; } },
      },
      persistentAgents: {
        status: { query: vi.fn().mockResolvedValue({ devBuild: true, configEnabled: true, enabled: true, killed: false, running: true, bridgeDisabled: false }) },
        listConnectors: { query: vi.fn().mockResolvedValue([]) },
        listAgents: { get query() { return listAgentsQuery; } },
        getThread: { query: vi.fn().mockResolvedValue({ agentId: 'a1', messages: [], hasMore: false }) },
        markRead: { mutate: vi.fn().mockResolvedValue({ unread: 0 }) },
        onThreadEvent: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onAgentsChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

import { AgentsEnvironmentsView } from '../AgentsEnvironmentsView';
import { useNavigationStore } from '../../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';

function seed(agents: ReturnType<typeof makeAgent>[], status: 'ready' | 'loading' = 'ready'): void {
  usePersistentAgentsStore.setState({ agents, agentsStatus: status, featureStatus: makeStatus(), threads: {}, connectors: [] });
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

beforeEach(() => {
  listAgentsQuery = vi.fn().mockResolvedValue([]);
  unlockMutate = vi.fn().mockResolvedValue({ available: false });
  localStorage.clear();
  useNavigationStore.setState({ agentsEnvOpen: true, agentsEnvTab: 'agents', agentsEnvAgentId: null });
  seed([]);
});

describe('AgentsEnvironmentsView', () => {
  it('the Agents tab is selected by default and Environments shows the placeholder', () => {
    render(<AgentsEnvironmentsView />);
    expect(screen.getByTestId('agents-env-tab-agents')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('agents-env-tab-environments'));
    expect(screen.getByTestId('environments-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('agents-env-tab-environments')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('agents-empty')).toBeNull();
  });

  it('the empty state shows a Connect CTA that opens the dialog', async () => {
    render(<AgentsEnvironmentsView />);
    expect(screen.getByTestId('agents-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agents-empty-connect'));
    expect(await screen.findByTestId('connect-agent-dialog')).toBeInTheDocument();
  });

  it('the header Connect button opens the dialog too, and only on the card list', () => {
    render(<AgentsEnvironmentsView />);
    expect(screen.getByTestId('agents-connect-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agents-env-tab-environments'));
    expect(screen.queryByTestId('agents-connect-button')).toBeNull();
  });

  it('a selected agent renders its thread, and All agents goes back', async () => {
    listAgentsQuery.mockResolvedValue([makeAgent()]);
    seed([makeAgent()]);
    useNavigationStore.setState({ agentsEnvAgentId: 'a1' });
    teardown = usePersistentAgentsStore.getState().init();
    render(<AgentsEnvironmentsView />);
    expect(await screen.findByTestId('persistent-agent-thread')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(useNavigationStore.getState().agentsEnvAgentId).toBeNull();
  });

  it('an unknown selected agent is cleared once the list is ready', async () => {
    useNavigationStore.setState({ agentsEnvAgentId: 'gone' });
    render(<AgentsEnvironmentsView />);
    await waitFor(() => expect(useNavigationStore.getState().agentsEnvAgentId).toBeNull());
  });

  it('an unknown selected agent is kept while the list is still loading', () => {
    seed([], 'loading');
    useNavigationStore.setState({ agentsEnvAgentId: 'later' });
    render(<AgentsEnvironmentsView />);
    expect(useNavigationStore.getState().agentsEnvAgentId).toBe('later');
    expect(screen.getByLabelText('Loading agent')).toBeInTheDocument();
  });

  it('ArrowRight on the tablist switches the tab', () => {
    render(<AgentsEnvironmentsView />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(useNavigationStore.getState().agentsEnvTab).toBe('environments');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(useNavigationStore.getState().agentsEnvTab).toBe('agents');
  });

  it('opening the pane calls cloud.unlock once, as an implicit (non-retry) unlock', async () => {
    const { rerender } = render(<AgentsEnvironmentsView />);
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledTimes(1));
    expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: false });
    rerender(<AgentsEnvironmentsView />);
    fireEvent.click(screen.getByTestId('agents-env-tab-environments'));
    expect(unlockMutate).toHaveBeenCalledTimes(1);
  });

  it('a rejecting unlock never surfaces', async () => {
    unlockMutate = vi.fn().mockRejectedValue(new Error('no cloud'));
    render(<AgentsEnvironmentsView />);
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('agents-env-view')).toBeInTheDocument();
  });
});
