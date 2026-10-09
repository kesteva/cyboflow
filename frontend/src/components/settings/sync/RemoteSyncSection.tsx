/**
 * Settings → Integrations → Sync: cross-machine backlog sync.
 *
 * MACHINE-scoped, unlike the issue-tracker list beside it (which is per project
 * and needs an active project): this section renders without one and holds the
 * per-project opt-in list. Sign-in is owned by the cyboflow cloud card above. It is not a tracker row and not a
 * TrackerProvider.
 *
 * DEV BUILDS ONLY. `cyboflow.remoteSync.getStatus` answers `{ available: false }`
 * in a release build (main wires no facade there), and this renders nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import type {
  RemoteSyncProjectChoices,
  RemoteSyncProjectState,
  RemoteSyncProjectStatus,
  RemoteSyncRemoteProject,
  RemoteSyncStatus,
} from '../../../../../shared/types/remoteSync';
import { trpc } from '../../../trpc/client';
import { useConfigStore } from '../../../stores/configStore';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { Toggle } from '../../ui/Toggle';
import { useRemoteSyncConflictsStore } from '../../../stores/remoteSyncConflictsStore';
import { cn } from '../../../utils/cn';
import { formatDistanceToNow } from '../../../utils/timestampUtils';

const STATE_LABEL: Record<RemoteSyncProjectState, { label: string; dot: string }> = {
  pending: { label: 'Pending', dot: 'bg-status-warning' },
  active: { label: 'Synced', dot: 'bg-status-success' },
  paused: { label: 'Paused', dot: 'bg-status-warning' },
  error: { label: 'Error', dot: 'bg-status-error' },
  rewound: { label: 'Rewound', dot: 'bg-status-warning' },
  upgrade_required: { label: 'Update required', dot: 'bg-status-warning' },
  storage_full: { label: 'Storage full', dot: 'bg-status-error' },
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** The account row's copy for a cloud state that is not signed in. */
function accountLine(cloudState: string): string {
  switch (cloudState) {
    case 'locked':
      return 'cyboflow cloud is locked — unlock it above to sync.';
    case 'revoked':
      return 'This computer was removed from your cyboflow cloud account — sign in again above.';
    case 'needs_update':
      return 'cyboflow cloud needs an app update before it can sync.';
    case 'undecryptable':
      return 'cyboflow cloud could not read its saved sign-in — sign in again above.';
    case 'secrets_unavailable':
      return 'Secure storage is unavailable, so cyboflow cloud cannot sign in on this computer.';
    default:
      return 'Sign in to cyboflow cloud above to sync this machine.';
  }
}

type Panel =
  | {
      kind: 'choices';
      choices: RemoteSyncProjectChoices;
      exists: RemoteSyncRemoteProject | null;
      note: string | null;
    }
  | { kind: 'confirm-off' };

interface ProjectRowProps {
  project: RemoteSyncProjectStatus;
  onError: (message: string | null) => void;
}

function ProjectRow({ project, onError }: ProjectRowProps): React.JSX.Element {
  const [panel, setPanel] = useState<Panel | null>(null);
  const openConflictsView = useRemoteSyncConflictsStore((s) => s.openView);
  const [busy, setBusy] = useState(false);
  const [otherId, setOtherId] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const linked = project.remoteProjectId !== null;
  const state = project.status !== null ? STATE_LABEL[project.status] : null;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openChoices = (): Promise<void> =>
    run(async () => {
      const choices = await trpc.cyboflow.remoteSync.getProjectChoices.query({
        projectId: project.projectId,
      });
      setOtherId('');
      setPanel({ kind: 'choices', choices, exists: null, note: null });
    });

  const enable = (req: { mode: 'create' } | { mode: 'join'; remoteProjectId: string }): Promise<void> =>
    run(async () => {
      const result = await trpc.cyboflow.remoteSync.enableProject.mutate({
        projectId: project.projectId,
        ...req,
      });
      if (result.ok) {
        setPanel(null);
      } else if (result.reason === 'exists' && result.project) {
        setPanel((p) => (p?.kind === 'choices' ? { ...p, exists: result.project ?? null, note: result.message } : p));
      } else {
        onError(result.message);
      }
    });

  const disable = (): Promise<void> =>
    run(async () => {
      await trpc.cyboflow.remoteSync.disableProject.mutate({
        projectId: project.projectId,
      });
      setPanel(null);
      setLogOpen(false);
      setLog(null);
    });

  const loadLog = (): Promise<void> =>
    run(async () => {
      setLog(
        await trpc.cyboflow.remoteSync.getLog.query({
          projectId: project.projectId,
        }),
      );
    });

  const toggleLog = (): void => {
    const next = !logOpen;
    setLogOpen(next);
    if (next) void loadLog();
  };

  const detail: string[] = [];
  if (project.statusDetail) detail.push(project.statusDetail);
  if (project.lastSyncAt) detail.push(`Last sync ${formatDistanceToNow(project.lastSyncAt)}`);
  if (project.openConflicts > 0) {
    detail.push(`${project.openConflicts} open conflict${project.openConflicts === 1 ? '' : 's'}`);
  }

  return (
    <div className="px-4 py-3" data-testid="remote-sync-project">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-text-primary">{project.name}</h4>
            <span className="flex items-center gap-1.5 text-xs text-text-secondary" data-testid="remote-sync-state">
              <span className={cn('inline-block h-2 w-2 rounded-full', state?.dot ?? 'bg-status-neutral')} />
              {state?.label ?? 'Off'}
              {project.syncing && ' · Syncing…'}
              {project.backoffUntil && ` · Retrying at ${new Date(project.backoffUntil).toLocaleTimeString()}`}
            </span>
          </div>
          {detail.length > 0 && <p className="mt-1 text-xs text-text-tertiary">{detail.join(' · ')}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project.status === 'rewound' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await trpc.cyboflow.remoteSync.resumeAfterRewind.mutate({
                    projectId: project.projectId,
                  });
                })
              }
            >
              Resume
            </Button>
          )}
          {linked && project.openConflicts > 0 && (
            <Button type="button" variant="secondary" size="sm" onClick={openConflictsView}>
              Review conflicts
            </Button>
          )}
          {linked && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || project.syncing}
              aria-label={`Sync ${project.name} now`}
              onClick={() =>
                void run(async () => {
                  await trpc.cyboflow.remoteSync.syncNow.mutate({
                    projectId: project.projectId,
                  });
                })
              }
            >
              Sync now
            </Button>
          )}
          <Toggle
            checked={linked}
            disabled={busy}
            aria-label={`Sync ${project.name}`}
            onChange={(next) => {
              if (next) void openChoices();
              else setPanel({ kind: 'confirm-off' });
            }}
          />
        </div>
      </div>

      {linked && project.status === 'upgrade_required' && (
        <p className="mt-2 text-xs text-status-warning">Update cyboflow to keep syncing this project</p>
      )}
      {linked && project.status === 'storage_full' && (
        <p className="mt-2 text-xs text-status-error">The sync server is out of space for this account</p>
      )}

      {linked && project.heldDeletes > 0 && (
        <div
          className="mt-2 flex items-center justify-between gap-3 border border-status-warning px-3 py-2"
          data-testid="remote-sync-held-deletes"
        >
          <p className="text-xs text-status-warning">
            {project.heldDeletes} deletions are waiting: this machine deleted more items than usual in the last hour, so
            they have not synced yet.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await trpc.cyboflow.remoteSync.confirmHeldDeletes.mutate({
                    projectId: project.projectId,
                  });
                })
              }
            >
              Delete on all machines
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await trpc.cyboflow.remoteSync.restoreHeldDeletes.mutate({
                    projectId: project.projectId,
                  });
                })
              }
            >
              Restore them here
            </Button>
          </div>
        </div>
      )}

      {linked && project.trackerClaims.length > 0 && (
        <ul className="mt-2 space-y-0.5" data-testid="remote-sync-claims">
          {project.trackerClaims.map((c) => (
            <li key={c.label} className="text-xs text-text-tertiary">
              {c.label}
              {c.mine && ' (this computer)'}
            </li>
          ))}
        </ul>
      )}

      {panel?.kind === 'confirm-off' && (
        <div
          className="mt-3 border border-border-primary bg-surface-secondary p-3"
          data-testid="remote-sync-confirm-off"
        >
          <p className="text-xs text-text-secondary">
            Stop syncing {project.name} on this computer? Its backlog stays here and on your other machines.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => void disable()}>
              Stop syncing
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPanel(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {panel?.kind === 'choices' && (
        <ChoicesPanel
          panel={panel}
          busy={busy}
          otherId={otherId}
          setOtherId={setOtherId}
          onEnable={(req) => void enable(req)}
          onCancel={() => setPanel(null)}
        />
      )}

      {linked && (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-text-tertiary underline hover:text-text-secondary"
            aria-expanded={logOpen}
            onClick={toggleLog}
          >
            {logOpen ? 'Hide log' : 'Show log'}
          </button>
          {logOpen && (
            <pre
              data-testid="remote-sync-log"
              className="mt-1 max-h-48 overflow-auto border border-border-primary bg-surface-secondary p-2 font-mono text-[11px] text-text-secondary"
            >
              {log === null ? 'Loading…' : log.length === 0 ? 'No log entries yet.' : log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface ChoicesPanelProps {
  panel: Extract<Panel, { kind: 'choices' }>;
  busy: boolean;
  otherId: string;
  setOtherId: (id: string) => void;
  onEnable: (req: { mode: 'create' } | { mode: 'join'; remoteProjectId: string }) => void;
  onCancel: () => void;
}

function ChoicesPanel({ panel, busy, otherId, setOtherId, onEnable, onCancel }: ChoicesPanelProps): React.JSX.Element {
  const { choices, exists, note } = panel;
  const blocked = choices.localItemCount > 0;
  const matches = exists ? [exists] : choices.matches;
  return (
    <div
      className="mt-3 space-y-3 border border-border-primary bg-surface-secondary p-3"
      data-testid="remote-sync-choices"
    >
      <p className="text-xs text-text-secondary">
        {note ??
          (choices.fingerprint
            ? `Matched by ${choices.fingerprint}`
            : 'This project has no git remote; pick a project to join or create a new one.')}
      </p>
      {blocked && (
        <p className="text-xs text-status-warning">
          Joining needs an empty backlog for now (this project has {choices.localItemCount} items).
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {matches.map((m) => (
          <Button
            key={m.id}
            type="button"
            variant="primary"
            size="sm"
            disabled={busy || blocked}
            onClick={() => onEnable({ mode: 'join', remoteProjectId: m.id })}
          >
            Join {m.name}
          </Button>
        ))}
        <Button
          type="button"
          variant={matches.length > 0 ? 'secondary' : 'primary'}
          size="sm"
          disabled={busy || exists !== null}
          onClick={() => onEnable({ mode: 'create' })}
        >
          Create new synced project
        </Button>
      </div>
      {choices.others.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            aria-label="Other projects"
            value={otherId}
            disabled={busy || blocked}
            onChange={(e) => setOtherId(e.target.value)}
            className="min-w-0 flex-1 border border-border-primary bg-surface-primary px-2 py-1 text-xs text-text-primary"
          >
            <option value="">Other projects…</option>
            {choices.others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || blocked || otherId === ''}
            onClick={() => onEnable({ mode: 'join', remoteProjectId: otherId })}
          >
            Join selected
          </Button>
        </div>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function RemoteSyncSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<RemoteSyncStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const refresh = useCallback(async () => {
    try {
      setStatus(await trpc.cyboflow.remoteSync.getStatus.query());
    } catch {
      // Unreachable surface reads as unavailable: render nothing.
      setStatus({ available: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    let subscription: { unsubscribe: () => void } | null = null;
    try {
      subscription = trpc.cyboflow.remoteSync.onChanged.subscribe(undefined, {
        onData: (next) => setStatus(next),
        onError: () => undefined,
      });
    } catch {
      // The initial query still renders; live pushes are an enhancement.
    }
    return () => subscription?.unsubscribe();
  }, [refresh]);

  const syncAll = useCallback(async () => {
    setSyncingAll(true);
    setError(null);
    try {
      await trpc.cyboflow.remoteSync.syncNow.mutate({});
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSyncingAll(false);
    }
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setError(null);
      const ok = await updateConfig({ remoteSync: { enabled } });
      if (!ok) setError('Could not save the sync setting.');
      await refresh();
      setSaving(false);
    },
    [refresh, updateConfig],
  );

  if (status === null || !status.available) return null;
  const ready = status.enabled && status.signedIn && status.cloudState === 'ok';

  return (
    <div data-testid="remote-sync-section">
      <SettingsSection
        title="Sync across machines"
        description="Keep this machine's backlog in sync with your other machines. Each project opts in separately; nothing syncs until you turn it on."
        icon={<RefreshCcw className="h-4 w-4" />}
        className="ml-0"
      >
        <div className="flex items-center gap-2">
          <span className="border border-border-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.08em] text-text-tertiary">
            Dev build
          </span>
          {status.staging && (
            <span
              data-testid="remote-sync-staging-badge"
              className="border border-interactive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.08em] text-interactive"
              title={status.serverOrigin ?? undefined}
            >
              Staging
            </span>
          )}
        </div>

        <div className="divide-y divide-border-primary border border-border-primary bg-surface-primary">
          <div className="flex items-start justify-between gap-4 px-4 py-4">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-text-primary">Enable sync</h4>
              <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                Turns on the sync engine for this machine. Available in dev builds only.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {ready && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={syncingAll}
                  onClick={() => void syncAll()}
                >
                  Sync now
                </Button>
              )}
              <Toggle
                checked={status.enabled}
                onChange={(next) => void setEnabled(next)}
                disabled={saving}
                aria-label="Enable sync across machines"
              />
            </div>
          </div>

          {status.enabled && (
            <div className="px-4 py-4" data-testid={ready ? 'remote-sync-account' : 'remote-sync-signed-out'}>
              <h4 className="text-sm font-semibold text-text-primary">{ready ? 'Account' : 'Not signed in'}</h4>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                {ready && status.device
                  ? `Syncing as ${status.device.name} · refs ${status.device.code}`
                  : ready
                    ? 'Syncing'
                    : accountLine(status.cloudState)}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
                Synced projects send their backlog (titles, bodies, stages and links) to the sync server; tracker
                credentials and links never leave this machine. A synced project&apos;s git remote URL (without
                credentials) identifies it on the server.
              </p>
            </div>
          )}

          {ready && status.projects.length === 0 && (
            <p className="px-4 py-4 text-xs text-text-tertiary">No projects yet.</p>
          )}
          {ready && status.projects.map((p) => <ProjectRow key={p.projectId} project={p} onError={setError} />)}
        </div>

        {error !== null && (
          <p role="alert" className="text-xs text-status-error">
            {error}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
