/**
 * TrackerIntegrationSection — catalog tests.
 *
 * Harness mirrors IntegrationsSettings.test.tsx: render the real component over
 * module mocks of its dependencies (the tRPC client + the IPC API facade), then
 * assert on what the user sees.
 *
 * Coverage: exactly two rows regardless of what came back; connections are
 * listed ACROSS projects with a project chip (a connection on a non-active
 * project must not render as "Not connected"); paused renders as a warning, not
 * green; Connect renders only for a provider with NO live connection (an
 * already-connected one adds mappings through Manage → Add mapping instead);
 * no active project disables Connect; the live subscription re-reads on a
 * change event; and Manage → Add mapping stacks the wizard in add-mapping mode
 * over the connected view it was launched from.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerConnectionSummary } from '../../../../../shared/types/trackerSync';

// The connected view and the add-mapping wizard are rendered for real once
// Manage is pressed, so their procedures are stubbed here too.
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        connections: { query: vi.fn() },
        conflicts: { query: vi.fn() },
        onTrackerChanged: { subscribe: vi.fn() },
        mappings: { query: vi.fn() },
        setPushTarget: { mutate: vi.fn() },
        disconnect: { mutate: vi.fn() },
        wizardGroups: { mutate: vi.fn() },
      },
    },
  },
}));

// The project list comes over IPC, not tRPC — same module-mock pattern.
vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: vi.fn() } },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerIntegrationSection } from './TrackerIntegrationSection';
import { TRACKER_PROVIDERS } from './trackerVocabulary';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { useNavigationStore } from '../../../stores/navigationStore';

const mockConnections = vi.mocked(trpc.cyboflow.tracker.connections.query);
const mockSubscribe = vi.mocked(trpc.cyboflow.tracker.onTrackerChanged.subscribe);
const mockMappings = vi.mocked(trpc.cyboflow.tracker.mappings.query);
const mockWizardGroups = vi.mocked(trpc.cyboflow.tracker.wizardGroups.mutate);
const mockProjectsGetAll = vi.mocked(API.projects.getAll);

const PROJECTS = [
  {
    id: 7,
    name: 'Cyboflow',
    path: '/dev/cyboflow',
    active: true,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 9,
    name: 'Website',
    path: '/dev/website',
    active: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
];

function makeConnection(
  overrides: Partial<TrackerConnectionSummary> = {},
): TrackerConnectionSummary {
  return {
    id: 'conn-1',
    projectId: 7,
    provider: 'linear',
    status: 'active',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
    baseUrl: null,
    sourceLabel: 'Core · Current cycle',
    sourceScope: { containerId: 'team-1', narrowId: 'cycle-12', narrowKind: 'cycle' },
    selectionMode: 'all',
    statusSyncMode: 'auto',
    pullMode: 'auto',
    pushMode: 'auto',
    contentSyncMode: 'off',
    archiveSyncMode: 'off',
    priorityMapping: {
      toProvider: { P0: '1', P1: '2', P2: '3', P3: '3', P4: '4', P5: '4', P6: '0' },
      toLocal: { '0': 'P6', '1': 'P0', '2': 'P1', '3': 'P2', '4': 'P4' },
    },
    categoryMapping: { toProvider: { feature: null, bug: null, chore: null }, toLocal: {} },
    mirrorSubissues: true,
    conflictMode: 'auto',
    pushTarget: true,
    stateMapping: { s1: 'idea', s2: 'ready' },
    lastSyncAt: '2026-07-30T10:00:00.000Z',
    lastSyncLog: [],
    linkedCount: 12,
    openConflictCount: 0,
    ...overrides,
  };
}

/** Route the per-project connections query: rows are returned by project id. */
function stubConnections(byProject: Record<number, TrackerConnectionSummary[]>): void {
  mockConnections.mockImplementation(({ projectId }) =>
    Promise.resolve(byProject[projectId] ?? []),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnections.mockResolvedValue([]);
  mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  mockMappings.mockResolvedValue([]);
  mockWizardGroups.mockResolvedValue({ sections: [] });
  mockProjectsGetAll.mockResolvedValue({ success: true, data: PROJECTS });
  useNavigationStore.setState({ activeProjectId: 7 });
});

describe('TrackerIntegrationSection', () => {
  it('renders exactly the catalog rows and nothing else', async () => {
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Linear')).toBeInTheDocument();
    expect(screen.getByText('Plane')).toBeInTheDocument();
    expect(screen.getByText('Dart')).toBeInTheDocument();
    // No GitHub/Jira/Slack rows survive from the prototype.
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Jira')).not.toBeInTheDocument();
    // Counted off the catalog rather than restated: the section is data-driven,
    // so adding a provider must not require editing an arithmetic literal here.
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(
      TRACKER_PROVIDERS.length,
    );
  });

  it('shows Connected + Manage for a connected provider and drops its Connect CTA', async () => {
    stubConnections({ 7: [makeConnection()] });
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Cyboflow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    // Only Linear's active project is taken, so every OTHER row stays connectable.
    expect(screen.getAllByText('Not connected')).toHaveLength(TRACKER_PROVIDERS.length - 1);
    // Linear's own row loses Connect: further mappings on an existing
    // authorization are added through Manage (add-mapping mode), and a standing
    // Connect would mint a second workspace when the user means another mapping.
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(
      TRACKER_PROVIDERS.length - 1,
    );
  });

  it('lists a connection on a NON-active project with its project chip', async () => {
    // The user's own trap: Plane connected to project 9 while viewing project 7.
    stubConnections({ 9: [makeConnection({ id: 'conn-9', projectId: 9, provider: 'plane' })] });
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    // The hide rule is per PROVIDER, not per project: Plane is connected
    // (wherever), so its Connect goes; the untouched providers keep theirs.
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(
      TRACKER_PROVIDERS.length - 1,
    );
  });

  it('renders a paused connection as a warning, never green', async () => {
    stubConnections({ 7: [makeConnection({ status: 'paused' })] });
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Paused — check credentials')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('says which computer runs it when another one holds the sync claim', async () => {
    stubConnections({
      7: [makeConnection({ status: 'paused', claimHold: 'Paused: beads (smk) runs on Studio' })],
    });
    render(<TrackerIntegrationSection />);

    // Cut to fit the card, so the whole reason is also the tooltip.
    const chip = await screen.findByText('Paused: beads (smk) runs on Studio');
    expect(chip).toHaveClass('truncate');
    expect(chip).toHaveAttribute('title', 'Paused: beads (smk) runs on Studio');
    expect(screen.queryByText('Paused — check credentials')).not.toBeInTheDocument();
  });

  it('queries every project and re-reads when a tracker change arrives', async () => {
    render(<TrackerIntegrationSection />);

    await waitFor(() => expect(mockConnections).toHaveBeenCalledWith({ projectId: 7 }));
    await waitFor(() => expect(mockConnections).toHaveBeenCalledWith({ projectId: 9 }));
    await waitFor(() =>
      expect(mockSubscribe).toHaveBeenCalledWith({ projectId: 9 }, expect.anything()),
    );

    // Fire the subscription's onData the way the router would.
    const before = mockConnections.mock.calls.length;
    const handlers = mockSubscribe.mock.calls[0][1];
    handlers.onData?.({ projectId: 7, connectionId: 'conn-1', kind: 'sync' });
    await waitFor(() => expect(mockConnections.mock.calls.length).toBeGreaterThan(before));
  });

  it('cannot connect without an active project', async () => {
    useNavigationStore.setState({ activeProjectId: null });
    render(<TrackerIntegrationSection />);

    expect(
      await screen.findByText('Select a project to connect an issue tracker.'),
    ).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'Connect' })) {
      expect(button).toBeDisabled();
    }
  });

  it('opens the wizard for the provider whose Connect was pressed', async () => {
    render(<TrackerIntegrationSection />);

    const [linearConnect] = await screen.findAllByRole('button', { name: 'Connect' });
    fireEvent.click(linearConnect);

    expect(await screen.findByTestId('tracker-wizard-modal')).toBeInTheDocument();
    expect(screen.getByText('/ Connect Linear')).toBeInTheDocument();
  });

  it('stacks the add-mapping wizard over the connected view that launched it', async () => {
    const connection = makeConnection();
    stubConnections({ 7: [connection] });
    mockMappings.mockResolvedValue([connection]);
    render(<TrackerIntegrationSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    // The manage view resolves the sibling rows' project chips through the
    // catalog's own name lookup, so the section must hand it `projectName`.
    expect(await screen.findByTestId('tracker-mappings-card')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tracker-add-mapping'));

    // The wizard opens in add-mapping mode — no Connect step, no key prompt —
    // and against the connection Manage was opened on.
    expect(await screen.findByTestId('tracker-wizard-modal')).toBeInTheDocument();
    expect(screen.getByText('/ Add a Linear mapping')).toBeInTheDocument();
    expect(screen.queryByTestId('tracker-step-0')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mockWizardGroups).toHaveBeenCalledWith({ connectionId: 'conn-1' }),
    );

    // Both surfaces stay mounted: dismissing the wizard lands back on the card.
    expect(screen.getByTestId('tracker-mappings-card')).toBeInTheDocument();
  });
});
