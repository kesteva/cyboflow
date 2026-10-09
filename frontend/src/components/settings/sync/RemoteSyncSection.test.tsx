import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSyncProjectStatus, RemoteSyncStatus } from '../../../../../shared/types/remoteSync';
import { CLOUD_STAGING_ORIGIN } from '../../../../../shared/types/cloudOrigins';
import { useConfigStore } from '../../../stores/configStore';

const m = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<RemoteSyncStatus>>(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  syncNow: vi.fn(),
  resumeAfterRewind: vi.fn(),
  getProjectChoices: vi.fn(),
  enableProject: vi.fn(),
  disableProject: vi.fn(),
  getLog: vi.fn(),
  confirmHeldDeletes: vi.fn(),
  restoreHeldDeletes: vi.fn(),
}));
const { getStatus } = m;
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      remoteSync: {
        getStatus: { query: m.getStatus },
        onChanged: { subscribe: m.subscribe },
        syncNow: { mutate: m.syncNow },
        resumeAfterRewind: { mutate: m.resumeAfterRewind },
        getProjectChoices: { query: m.getProjectChoices },
        enableProject: { mutate: m.enableProject },
        disableProject: { mutate: m.disableProject },
        getLog: { query: m.getLog },
        confirmHeldDeletes: { mutate: m.confirmHeldDeletes },
        restoreHeldDeletes: { mutate: m.restoreHeldDeletes },
      },
    },
  },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { RemoteSyncSection } from './RemoteSyncSection';

function devStatus(overrides: Partial<Extract<RemoteSyncStatus, { available: true }>> = {}): RemoteSyncStatus {
  return {
    available: true,
    enabled: false,
    cloudState: 'signed_out',
    device: null,
    serverOrigin: CLOUD_STAGING_ORIGIN,
    staging: true,
    signedIn: false,
    projects: [],
    ...overrides,
  };
}

describe('RemoteSyncSection', () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockReset();
    m.subscribe.mockReturnValue({ unsubscribe: m.unsubscribe });
    m.syncNow.mockResolvedValue(undefined);
    m.disableProject.mockResolvedValue(undefined);
  });

  it('renders nothing in a release build', async () => {
    getStatus.mockResolvedValue({ available: false });
    const { container } = render(<RemoteSyncSection />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Sync across machines')).not.toBeInTheDocument();
  });

  it('renders nothing when the status call fails', async () => {
    getStatus.mockRejectedValue(new Error('no route'));
    const { container } = render(<RemoteSyncSection />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the section with a Staging badge in a dev build, flag off', async () => {
    getStatus.mockResolvedValue(devStatus());
    render(<RemoteSyncSection />);
    expect(await screen.findByText('Sync across machines')).toBeInTheDocument();
    expect(screen.getByTestId('remote-sync-staging-badge')).toHaveTextContent('Staging');
    expect(screen.queryByTestId('remote-sync-signed-out')).not.toBeInTheDocument();
  });

  it('shows the signed-out state once enabled', async () => {
    getStatus.mockResolvedValue(devStatus({ enabled: true }));
    render(<RemoteSyncSection />);
    expect(await screen.findByTestId('remote-sync-signed-out')).toBeInTheDocument();
    expect(screen.getByTestId('remote-sync-signed-out')).toHaveTextContent(
      'Sign in to cyboflow cloud above to sync this machine.',
    );
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('writes the flag through the config store and refreshes', async () => {
    const updateConfig = vi.fn().mockResolvedValue(true);
    useConfigStore.setState({ updateConfig });
    getStatus.mockResolvedValueOnce(devStatus()).mockResolvedValueOnce(devStatus({ enabled: true }));
    render(<RemoteSyncSection />);
    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'Enable sync across machines',
      }),
    );
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        remoteSync: { enabled: true },
      }),
    );
    expect(await screen.findByTestId('remote-sync-signed-out')).toBeInTheDocument();
  });

  describe('signed in', () => {
    function project(o: Partial<RemoteSyncProjectStatus> = {}): RemoteSyncProjectStatus {
      return {
        projectId: 1,
        name: 'Alpha',
        remoteProjectId: null,
        status: null,
        statusDetail: null,
        lastSyncAt: null,
        syncing: false,
        backoffUntil: null,
        openConflicts: 0,
        heldDeletes: 0,
        trackerClaims: [],
        ...o,
      };
    }
    function signedIn(projects: RemoteSyncProjectStatus[]): RemoteSyncStatus {
      return devStatus({
        enabled: true,
        signedIn: true,
        cloudState: 'ok',
        device: { name: 'Studio', code: 'ab12' },
        projects,
      });
    }
    const choices = (o: object = {}) => ({
      projectId: 1,
      fingerprint: 'github.com/o/r',
      localItemCount: 0,
      matches: [{ id: 'r1', name: 'Remote Alpha', createdAt: 1 }],
      others: [{ id: 'r2', name: 'Other', createdAt: 2 }],
      ...o,
    });

    it('points a locked cloud at the cloud card', async () => {
      getStatus.mockResolvedValue(devStatus({ enabled: true, cloudState: 'locked' }));
      render(<RemoteSyncSection />);
      expect(await screen.findByTestId('remote-sync-signed-out')).toHaveTextContent('cyboflow cloud is locked');
    });

    it('shows the device and the projects list', async () => {
      getStatus.mockResolvedValue(
        signedIn([
          project(),
          project({
            projectId: 2,
            name: 'Beta',
            remoteProjectId: 'r9',
            status: 'active',
          }),
        ]),
      );
      render(<RemoteSyncSection />);
      expect(await screen.findByText('Syncing as Studio · refs ab12')).toBeInTheDocument();
      expect(screen.getAllByTestId('remote-sync-project')).toHaveLength(2);
      expect(screen.getByRole('switch', { name: 'Sync Alpha' })).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('switch', { name: 'Sync Beta' })).toHaveAttribute('aria-checked', 'true');
      expect(
        screen.getByText(/Synced/, {
          selector: '[data-testid="remote-sync-state"]',
        }),
      ).toBeInTheDocument();
    });

    it('offers join + create on toggle on, and create calls enableProject', async () => {
      getStatus.mockResolvedValue(signedIn([project()]));
      m.getProjectChoices.mockResolvedValue(choices());
      m.enableProject.mockResolvedValue({ ok: true, remoteProjectId: 'new' });
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('switch', { name: 'Sync Alpha' }));
      expect(await screen.findByRole('button', { name: 'Join Remote Alpha' })).toBeEnabled();
      expect(screen.getByText('Matched by github.com/o/r')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Create new synced project' }));
      await waitFor(() =>
        expect(m.enableProject).toHaveBeenCalledWith({
          projectId: 1,
          mode: 'create',
        }),
      );
      await waitFor(() => expect(screen.queryByTestId('remote-sync-choices')).not.toBeInTheDocument());
    });

    it('joins the picked other project', async () => {
      getStatus.mockResolvedValue(signedIn([project()]));
      m.getProjectChoices.mockResolvedValue(choices());
      m.enableProject.mockResolvedValue({ ok: true, remoteProjectId: 'r2' });
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('switch', { name: 'Sync Alpha' }));
      fireEvent.change(await screen.findByLabelText('Other projects'), {
        target: { value: 'r2' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Join selected' }));
      await waitFor(() =>
        expect(m.enableProject).toHaveBeenCalledWith({
          projectId: 1,
          mode: 'join',
          remoteProjectId: 'r2',
        }),
      );
    });

    it('disables joining when the local backlog is not empty', async () => {
      getStatus.mockResolvedValue(signedIn([project()]));
      m.getProjectChoices.mockResolvedValue(choices({ localItemCount: 7 }));
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('switch', { name: 'Sync Alpha' }));
      expect(await screen.findByRole('button', { name: 'Join Remote Alpha' })).toBeDisabled();
      expect(
        screen.getByText(/Joining needs an empty backlog for now \(this project has 7 items\)/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create new synced project' })).toBeEnabled();
    });

    it('offers joining the existing project after an exists result', async () => {
      getStatus.mockResolvedValue(signedIn([project()]));
      m.getProjectChoices.mockResolvedValue(choices({ matches: [] }));
      m.enableProject.mockResolvedValueOnce({
        ok: false,
        reason: 'exists',
        message: 'Already exists.',
        project: { id: 'rx', name: 'Existing', createdAt: 3 },
      });
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('switch', { name: 'Sync Alpha' }));
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Create new synced project',
        }),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Join Existing' }));
      await waitFor(() =>
        expect(m.enableProject).toHaveBeenLastCalledWith({
          projectId: 1,
          mode: 'join',
          remoteProjectId: 'rx',
        }),
      );
    });

    it('shows a failure message from enableProject', async () => {
      getStatus.mockResolvedValue(signedIn([project()]));
      m.getProjectChoices.mockResolvedValue(choices());
      m.enableProject.mockResolvedValue({
        ok: false,
        reason: 'failed',
        message: 'Server said no.',
      });
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('switch', { name: 'Sync Alpha' }));
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Create new synced project',
        }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('Server said no.');
    });

    it('asks before turning a project off', async () => {
      getStatus.mockResolvedValue(signedIn([project({ remoteProjectId: 'r1', status: 'active' })]));
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('switch', { name: 'Sync Alpha' }));
      expect(m.disableProject).not.toHaveBeenCalled();
      expect(screen.getByText(/Stop syncing Alpha on this computer\?/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Stop syncing' }));
      await waitFor(() => expect(m.disableProject).toHaveBeenCalledWith({ projectId: 1 }));
    });

    it('renders tracker claims', async () => {
      getStatus.mockResolvedValue(
        signedIn([
          project({
            remoteProjectId: 'r1',
            status: 'active',
            trackerClaims: [
              { label: 'Linear (acme) runs on Studio', mine: true },
              { label: 'Beads runs on Laptop', mine: false },
            ],
          }),
        ]),
      );
      render(<RemoteSyncSection />);
      expect(await screen.findByText('Linear (acme) runs on Studio (this computer)')).toBeInTheDocument();
      expect(screen.getByText('Beads runs on Laptop')).toBeInTheDocument();
    });

    it('loads the log on Show log', async () => {
      getStatus.mockResolvedValue(signedIn([project({ remoteProjectId: 'r1', status: 'active' })]));
      m.getLog.mockResolvedValue(['2026-10-08T10:00:00Z pushed 3', '2026-10-08T10:01:00Z pulled 1']);
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('button', { name: 'Show log' }));
      expect(await screen.findByTestId('remote-sync-log')).toHaveTextContent('pulled 1');
      expect(m.getLog).toHaveBeenCalledWith({ projectId: 1 });
    });

    it('Sync now calls syncNow for the section and for a project', async () => {
      getStatus.mockResolvedValue(signedIn([project({ remoteProjectId: 'r1', status: 'active' })]));
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
      await waitFor(() => expect(m.syncNow).toHaveBeenCalledWith({}));
      fireEvent.click(screen.getByRole('button', { name: 'Sync Alpha now' }));
      await waitFor(() => expect(m.syncNow).toHaveBeenCalledWith({ projectId: 1 }));
    });

    it('resumes a rewound project', async () => {
      getStatus.mockResolvedValue(signedIn([project({ remoteProjectId: 'r1', status: 'rewound' })]));
      m.resumeAfterRewind.mockResolvedValue(undefined);
      render(<RemoteSyncSection />);
      fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
      await waitFor(() => expect(m.resumeAfterRewind).toHaveBeenCalledWith({ projectId: 1 }));
    });

    it('applies a subscription push and unsubscribes on unmount', async () => {
      getStatus.mockResolvedValue(signedIn([project({ remoteProjectId: 'r1', status: 'pending' })]));
      const { unmount } = render(<RemoteSyncSection />);
      expect(await screen.findByText(/Pending/)).toBeInTheDocument();
      const handlers = m.subscribe.mock.calls[0][1] as {
        onData: (s: RemoteSyncStatus) => void;
      };
      act(() =>
        handlers.onData(
          signedIn([
            project({
              remoteProjectId: 'r1',
              status: 'error',
              statusDetail: 'boom',
            }),
          ]),
        ),
      );
      expect(await screen.findByText(/Error/)).toBeInTheDocument();
      expect(screen.getByText('boom')).toBeInTheDocument();
      unmount();
      expect(m.unsubscribe).toHaveBeenCalled();
    });

    it('shows held deletions with confirm/restore, and the upgrade/storage lines', async () => {
      getStatus.mockResolvedValue(
        signedIn([
          project({ remoteProjectId: 'r1', status: 'active', heldDeletes: 12 }),
          project({
            projectId: 2,
            name: 'Beta',
            remoteProjectId: 'r2',
            status: 'upgrade_required',
          }),
          project({
            projectId: 3,
            name: 'Gamma',
            remoteProjectId: 'r3',
            status: 'storage_full',
          }),
        ]),
      );
      m.confirmHeldDeletes.mockResolvedValue(undefined);
      m.restoreHeldDeletes.mockResolvedValue(12);
      render(<RemoteSyncSection />);
      expect(await screen.findByTestId('remote-sync-held-deletes')).toHaveTextContent('12 deletions are waiting');
      expect(screen.getByText('Update cyboflow to keep syncing this project')).toBeInTheDocument();
      expect(screen.getByText('The sync server is out of space for this account')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Delete on all machines' }));
      await waitFor(() => expect(m.confirmHeldDeletes).toHaveBeenCalledWith({ projectId: 1 }));
      fireEvent.click(screen.getByRole('button', { name: 'Restore them here' }));
      await waitFor(() => expect(m.restoreHeldDeletes).toHaveBeenCalledWith({ projectId: 1 }));
    });
  });
});
