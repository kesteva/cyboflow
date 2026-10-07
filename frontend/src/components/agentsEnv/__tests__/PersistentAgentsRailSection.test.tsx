import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { makeAgent, makeConnection, makeStatus } from './fixtures';

const queries = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../../trpc/client', () => {
  const spy = (name: string) => vi.fn().mockImplementation(async () => {
    queries.calls.push(name);
    return [];
  });
  return {
    trpc: {
      cyboflow: {
        persistentAgents: {
          status: { query: spy('status') },
          listAgents: { query: spy('listAgents') },
          markRead: { mutate: spy('markRead') },
        },
      },
    },
  };
});

import { PersistentAgentsRailSection } from '../PersistentAgentsRailSection';
import { useNavigationStore } from '../../../stores/navigationStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';

function seed(agents: ReturnType<typeof makeAgent>[], status = makeStatus()): void {
  usePersistentAgentsStore.setState({ agents, featureStatus: status, agentsStatus: 'ready' });
}

beforeEach(() => {
  queries.calls.length = 0;
  useNavigationStore.setState({ agentsEnvOpen: false, agentsEnvAgentId: null, agentsEnvTab: 'agents' });
  seed([]);
});

describe('PersistentAgentsRailSection', () => {
  it('renders nothing when the feature is off', () => {
    seed([makeAgent()], makeStatus({ enabled: false, running: false }));
    const { container } = render(<PersistentAgentsRailSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a killed status (enabled, not running) renders nothing', () => {
    seed([makeAgent()], makeStatus({ enabled: true, killed: true, running: false }));
    const { container } = render(<PersistentAgentsRailSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with zero agents', () => {
    const { container } = render(<PersistentAgentsRailSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('rows show the name, the kind chip and a health dot', () => {
    seed([makeAgent()]);
    render(<PersistentAgentsRailSection />);
    const row = screen.getByTestId('rail-agent-row-a1');
    expect(row).toHaveTextContent('My dot');
    expect(row).toHaveTextContent('dots · Bridge');
    expect(row.querySelector('[data-dot]')).not.toBeNull();
  });

  it('the unread pill shows only above zero', () => {
    seed([makeAgent({ id: 'a1', unreadCount: 0 }), makeAgent({ id: 'a2', displayName: 'Other', unreadCount: 4 })]);
    render(<PersistentAgentsRailSection />);
    expect(screen.queryByTestId('rail-agent-unread-a1')).toBeNull();
    expect(screen.getByTestId('rail-agent-unread-a2')).toHaveTextContent('4');
  });

  it('clicking a row opens the pane on that agent', () => {
    seed([makeAgent()]);
    useNavigationStore.setState({ agentsEnvTab: 'environments' });
    render(<PersistentAgentsRailSection />);
    fireEvent.click(screen.getByTestId('rail-agent-row-a1'));
    const s = useNavigationStore.getState();
    expect(s.agentsEnvOpen).toBe(true);
    expect(s.agentsEnvAgentId).toBe('a1');
    expect(s.agentsEnvTab).toBe('agents');
  });

  it('aria-current marks the selected row only while the pane is open', () => {
    seed([makeAgent({ id: 'a1' }), makeAgent({ id: 'a2', displayName: 'Other' })]);
    const { rerender } = render(<PersistentAgentsRailSection />);
    expect(screen.getByTestId('rail-agent-row-a1')).not.toHaveAttribute('aria-current');
    useNavigationStore.setState({ agentsEnvOpen: true, agentsEnvAgentId: 'a1' });
    rerender(<PersistentAgentsRailSection />);
    expect(screen.getByTestId('rail-agent-row-a1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('rail-agent-row-a2')).not.toHaveAttribute('aria-current');
    useNavigationStore.setState({ agentsEnvOpen: false });
    rerender(<PersistentAgentsRailSection />);
    expect(screen.getByTestId('rail-agent-row-a1')).not.toHaveAttribute('aria-current');
  });

  it('an 80-character name renders in full at 320px with no clamp or truncate class', () => {
    const name = 'W'.repeat(80);
    seed([makeAgent({ displayName: name })]);
    render(
      <div style={{ width: '320px' }}>
        <PersistentAgentsRailSection />
      </div>,
    );
    const el = screen.getByTitle(name);
    expect(el).toHaveTextContent(name);
    expect(el.className).not.toMatch(/line-clamp|truncate/);
  });

  it('rendering calls no tRPC function', () => {
    seed([makeAgent({ connection: makeConnection() })]);
    render(<PersistentAgentsRailSection />);
    expect(queries.calls).toEqual([]);
  });

  it('the section hides once the last agent is archived', () => {
    seed([makeAgent()]);
    const { container } = render(<PersistentAgentsRailSection />);
    expect(screen.getByTestId('rail-persistent-agents')).toBeInTheDocument();
    act(() => {
      usePersistentAgentsStore.setState({ agents: [] });
    });
    expect(container.querySelector('[data-testid="rail-persistent-agents"]')).toBeNull();
  });
});
