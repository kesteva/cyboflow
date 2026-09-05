/**
 * TrackerConnectedView — the manage surface for one live tracker connection,
 * rendered as a `size="full"` Modal nested inside the Settings modal (the same
 * nesting the wizard uses).
 *
 * Reads everything but the conflict list off the `TrackerConnectionSummary` the
 * catalog already fetched; conflicts are their own query because they are per
 * connection and only shown when there is something to decide.
 *
 * Writes:
 *   settings toggles -> cyboflow.tracker.updateSettings (one PARTIAL per row)
 *   Sync now         -> cyboflow.tracker.syncNow  (its returned log replaces the card's)
 *   conflict rulings -> cyboflow.tracker.resolveConflict
 *   Disconnect       -> cyboflow.tracker.disconnect (inline confirm first)
 *   Reconnect        -> cyboflow.tracker.updateCredentials (paused connections only)
 *   Remap links      -> cyboflow.tracker.remapRenamedPrefix (paused keyless, prefix renamed)
 *   Adopt workspace  -> cyboflow.tracker.adoptNewWorkspace (paused keyless, database replaced)
 *   Make push target -> cyboflow.tracker.setPushTarget (arms a mapping row, demotes its siblings)
 *   Remove mapping   -> cyboflow.tracker.disconnect (same procedure as header Disconnect, per row)
 *
 * Toggle state is mirrored locally so a row flips immediately and the summary
 * re-read (driven by the parent's onTrackerChanged subscription) reconciles it.
 * v1 has NO edit deep-links back into the wizard: `updateSettings` covers the
 * direction/mirroring/conflict rows, and changing the source, selection or state
 * mapping means re-running the wizard. `pushTarget` is read straight off the
 * summary (no local mirror, no toggle) — it is set by the wizard's Map step
 * when several sibling connections share a cyboflow project.
 *
 * The "Project mappings" card lists every LIVE sibling of this connection's
 * workspace identity (across cyboflow projects — cyboflow.tracker.mappings),
 * so a multi-project rev-4 wizard run has one place to see and manage the whole
 * group: arm a different pusher, remove a mapping, or jump into the wizard's
 * add-mapping mode via `onAddMapping`. It re-reads on every fresh `connection`
 * prop, same cadence as the rest of the view.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { inferRouterInputs } from '@trpc/server';
import { RefreshCw } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { cn } from '../../../utils/cn';
import type { AppRouter } from '../../../../../shared/types/trpc';
import type {
  TrackerConflictMode,
  TrackerConflictSummary,
  TrackerConnectionStatus,
  TrackerConnectionSummary,
  TrackerContentSyncMode,
  TrackerDirectionMode,
  TrackerMappingTarget,
  TrackerRecoveryProbe,
  TrackerStatusSyncMode,
  TrackerSyncLogEntry,
} from '../../../../../shared/types/trackerSync';
import { Eyebrow, PillToggle, ProviderTile, Segmented } from './trackerShared';
import {
  GATED_MODE_OPTIONS,
  gatedModeLabel,
  logMarkerClass,
  mappingTargetLabel,
  providerMeta,
  trackerInputClass,
} from './trackerVocabulary';

const CARD = 'rounded-none border border-border-primary bg-surface-primary';

/** The settings patch shape, inferred from the router — never a local mirror. */
type UpdateSettingsInput = inferRouterInputs<AppRouter>['cyboflow']['tracker']['updateSettings'];

const CONFLICT_OPTIONS: readonly { value: TrackerConflictMode; label: string }[] = [
  { value: 'auto', label: 'Auto-resolve' },
  { value: 'manual', label: 'Manual review' },
];

const DIRECTION_OPTIONS: readonly { value: TrackerDirectionMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
];

function directionLabel(mode: TrackerDirectionMode): string {
  return mode === 'auto' ? 'Auto' : 'Manual';
}

const SELECTION_LABEL: Record<TrackerConnectionSummary['selectionMode'], string> = {
  all: 'All issues',
  assignee: 'By assignee',
  manual: 'Hand-picked',
};

/**
 * Compact status presentation for a mappings-card row — honest tones only, so a
 * paused sibling never reads as green just because it is still "live".
 */
const MAPPING_STATUS_META: Record<
  TrackerConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  active: { label: 'Connected', dotClass: 'bg-status-success', textClass: 'text-status-success' },
  paused: { label: 'Paused', dotClass: 'bg-status-warning', textClass: 'text-status-warning' },
  disconnected: {
    label: 'Disconnected',
    dotClass: 'bg-text-tertiary',
    textClass: 'text-text-tertiary',
  },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `lastSyncAt` is an ISO stamp from the store; an unparseable one renders raw. */
function formatSyncedAt(iso: string | null): string {
  if (iso === null) return 'never';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export interface TrackerConnectedViewProps {
  isOpen: boolean;
  connection: TrackerConnectionSummary;
  onClose: () => void;
  /** Fired after any write so the catalog re-reads its connection rows. */
  onChanged: () => void;
  /** Resolve a mapping row's `projectId` to its display name for the mappings card. */
  projectName: (id: number) => string;
  /** Opens the wizard in add-mapping mode, seeded from this connection. */
  onAddMapping: () => void;
}

export function TrackerConnectedView({
  isOpen,
  connection,
  onClose,
  onChanged,
  projectName,
  onAddMapping,
}: TrackerConnectedViewProps): React.JSX.Element {
  const meta = providerMeta(connection.provider);

  // Optimistic mirror of the editable settings rows.
  const [statusSyncMode, setStatusSyncMode] = useState<TrackerStatusSyncMode>(
    connection.statusSyncMode,
  );
  const [pullMode, setPullMode] = useState<TrackerDirectionMode>(connection.pullMode);
  const [pushMode, setPushMode] = useState<TrackerDirectionMode>(connection.pushMode);
  const [contentSyncMode, setContentSyncMode] = useState<TrackerContentSyncMode>(
    connection.contentSyncMode,
  );
  const [archiveSyncMode, setArchiveSyncMode] = useState<TrackerContentSyncMode>(
    connection.archiveSyncMode,
  );
  const [mirrorSubissues, setMirrorSubissues] = useState(connection.mirrorSubissues);
  const [conflictMode, setConflictMode] = useState<TrackerConflictMode>(connection.conflictMode);

  const [log, setLog] = useState<TrackerSyncLogEntry[]>(connection.lastSyncLog);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const [conflicts, setConflicts] = useState<TrackerConflictSummary[]>([]);

  // Reconnect (paused connections only) — a fresh key for the same connection.
  const [reconnectApiKey, setReconnectApiKey] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  // Re-seed from a fresh summary (the parent re-reads on every tracker event).
  useEffect(() => {
    setStatusSyncMode(connection.statusSyncMode);
    setPullMode(connection.pullMode);
    setPushMode(connection.pushMode);
    setContentSyncMode(connection.contentSyncMode);
    setArchiveSyncMode(connection.archiveSyncMode);
    setMirrorSubissues(connection.mirrorSubissues);
    setConflictMode(connection.conflictMode);
    setLog(connection.lastSyncLog);
  }, [
    connection.statusSyncMode,
    connection.pullMode,
    connection.pushMode,
    connection.contentSyncMode,
    connection.archiveSyncMode,
    connection.mirrorSubissues,
    connection.conflictMode,
    connection.lastSyncLog,
  ]);

  /**
   * The conflict list is only meaningful in Manual mode or while auto-resolution
   * has left something open, so it is fetched under exactly that condition.
   */
  const showConflicts = conflictMode === 'manual' || connection.openConflictCount > 0;

  const loadConflicts = useCallback((): void => {
    if (!showConflicts) {
      setConflicts([]);
      return;
    }
    void trpc.cyboflow.tracker.conflicts
      .query({ connectionId: connection.id })
      .then(setConflicts)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [showConflicts, connection.id]);

  useEffect(() => {
    loadConflicts();
  }, [loadConflicts, connection.openConflictCount]);

  /**
   * WHICH recovery a paused KEYLESS connection needs. Fetched only under exactly
   * that condition, because the answer costs a live `bd` probe in main and there
   * is nothing to classify for a keyed provider (which rejects the call) or for
   * a connection that is not paused.
   *
   * `null` is "not asked yet, or the probe itself failed" — and the banner
   * degrades to its pre-Phase-4b Re-detect shape for it, which is always a safe
   * action: the two typed recoveries are additive affordances, never a
   * precondition for reconnecting.
   */
  const [recovery, setRecovery] = useState<TrackerRecoveryProbe | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [confirmingAdopt, setConfirmingAdopt] = useState(false);
  const needsRecoveryProbe = connection.status === 'paused' && !meta.needsApiKey;

  useEffect(() => {
    if (!needsRecoveryProbe) {
      setRecovery(null);
      return;
    }
    let live = true;
    void trpc.cyboflow.tracker.probeRecovery
      .query({ connectionId: connection.id })
      .then((probe) => {
        if (live) setRecovery(probe);
      })
      .catch(() => {
        // Deliberately silent: a failed classification is not a failed
        // connection, and surfacing it in the card's error slot would bury the
        // pause the user actually came here for.
        if (live) setRecovery(null);
      });
    return () => {
      live = false;
    };
  }, [needsRecoveryProbe, connection.id, connection.status]);

  /**
   * Run one recovery action and let the parent's re-read reconcile the card.
   *
   * `closeAfter` is the ADOPTION's, not a style choice: adoption retires this
   * connection and mints a different one, so the summary this modal is rendering
   * stops describing anything live the moment it succeeds. A remap leaves the
   * same row in place, so the view stays open and simply re-reads.
   */
  const runRecovery = async (
    action: () => Promise<unknown>,
    opts: { closeAfter: boolean },
  ): Promise<void> => {
    setReconnectError(null);
    setRecovering(true);
    try {
      await action();
      setConfirmingAdopt(false);
      onChanged();
      if (opts.closeAfter) onClose();
    } catch (err) {
      setReconnectError(errorMessage(err));
    } finally {
      setRecovering(false);
    }
  };

  // Project mappings card: every live sibling of this connection's workspace
  // identity, across cyboflow projects.
  const [mappings, setMappings] = useState<TrackerConnectionSummary[]>([]);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  const refetchMappings = (): void => {
    void trpc.cyboflow.tracker.mappings
      .query({ connectionId: connection.id })
      .then(setMappings)
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  // Keyed on the whole `connection` prop, not just its id: the parent re-reads
  // summaries on every tracker event, so a fresh prop identity means a sibling's
  // status/linkedCount/pushTarget may have changed too, not only this row's own.
  useEffect(() => {
    refetchMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  const handleSetPushTarget = (rowId: string): void => {
    setError(null);
    void trpc.cyboflow.tracker.setPushTarget
      .mutate({ connectionId: rowId })
      .then(() => {
        refetchMappings();
        onChanged();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleRemoveMapping = (rowId: string): void => {
    setError(null);
    void trpc.cyboflow.tracker.disconnect
      .mutate({ connectionId: rowId })
      .then(() => {
        setConfirmingRemoveId(null);
        if (rowId === connection.id) {
          // This is the row the modal is open on — nothing left to show here.
          onChanged();
          onClose();
        } else {
          refetchMappings();
          onChanged();
        }
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const patchSettings = (patch: UpdateSettingsInput): void => {
    setError(null);
    void trpc.cyboflow.tracker.updateSettings
      .mutate(patch)
      .then(() => onChanged())
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleStatusSyncMode = (next: TrackerStatusSyncMode): void => {
    setStatusSyncMode(next);
    patchSettings({ connectionId: connection.id, statusSyncMode: next });
  };

  const handlePullMode = (next: TrackerDirectionMode): void => {
    setPullMode(next);
    patchSettings({ connectionId: connection.id, pullMode: next });
  };

  const handlePushMode = (next: TrackerDirectionMode): void => {
    setPushMode(next);
    patchSettings({ connectionId: connection.id, pushMode: next });
  };

  const handleContentSyncMode = (next: TrackerContentSyncMode): void => {
    setContentSyncMode(next);
    patchSettings({ connectionId: connection.id, contentSyncMode: next });
  };

  const handleArchiveSyncMode = (next: TrackerContentSyncMode): void => {
    setArchiveSyncMode(next);
    patchSettings({ connectionId: connection.id, archiveSyncMode: next });
  };

  const handleMirror = (next: boolean): void => {
    setMirrorSubissues(next);
    patchSettings({ connectionId: connection.id, mirrorSubissues: next });
  };

  const handleConflictMode = (next: TrackerConflictMode): void => {
    setConflictMode(next);
    patchSettings({ connectionId: connection.id, conflictMode: next });
  };

  const handleSyncNow = async (): Promise<void> => {
    setSyncing(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tracker.syncNow.mutate({ connectionId: connection.id });
      setLog(result.entries);
      if (result.error !== null) setError(result.error);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleResolve = (conflictId: number, choice: 'local' | 'remote'): void => {
    setError(null);
    void trpc.cyboflow.tracker.resolveConflict
      .mutate({ conflictId, choice })
      .then(() => {
        setConflicts((prev) => prev.filter((c) => c.id !== conflictId));
        onChanged();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleDisconnect = (): void => {
    setError(null);
    void trpc.cyboflow.tracker.disconnect
      .mutate({ connectionId: connection.id })
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleReconnect = async (): Promise<void> => {
    setReconnectError(null);
    setReconnecting(true);
    try {
      await trpc.cyboflow.tracker.updateCredentials.mutate({
        connectionId: connection.id,
        // A keyless connection has no key to rotate: the same call means
        // RE-DETECT, and main refuses one that carries a key at all.
        ...(meta.needsApiKey ? { apiKey: reconnectApiKey.trim() } : {}),
      });
      setReconnectApiKey('');
      // The connection flips to 'active' server-side; the parent's
      // onTrackerChanged subscription re-reads the row, same as every other
      // write here.
      onChanged();
    } catch (err) {
      setReconnectError(errorMessage(err));
    } finally {
      setReconnecting(false);
    }
  };

  const mappedCount = Object.values(connection.stateMapping).filter((t) => t !== 'dont').length;
  const totalStates = Object.keys(connection.stateMapping).length;
  /**
   * Read-only counts, wizard-only editing per house convention (no inline
   * editor here). `toProvider` always carries every level's key (the seed
   * fills all of them, whether the user ever touched a picker or not), so the
   * denominator is fixed rather than read off the connection.
   */
  const priorityMappedCount = Object.values(connection.priorityMapping.toProvider).filter(
    (t) => t !== null,
  ).length;
  const categoryMappedCount = Object.values(connection.categoryMapping.toProvider).filter(
    (t) => t !== null,
  ).length;

  /**
   * The distinct cyboflow stages this connection IMPORTS into. 'indev' is
   * excluded alongside 'dont': it is an outbound-only pin, so listing it here
   * would claim an inbound destination that does not exist. It still counts as
   * mapped above, because the user did map it — just not inward.
   */
  const mappedTargets = useMemo(() => {
    const seen = new Set<TrackerMappingTarget>();
    for (const target of Object.values(connection.stateMapping)) {
      if (target !== 'dont' && target !== 'indev') seen.add(target);
    }
    return [...seen].map(mappingTargetLabel).join(' · ');
  }, [connection.stateMapping]);

  const allAuto = statusSyncMode === 'auto' && pullMode === 'auto' && pushMode === 'auto';

  const stats: { label: string; value: string; tone?: string }[] = [
    { label: 'Items linked', value: String(connection.linkedCount) },
    { label: 'Selection', value: SELECTION_LABEL[connection.selectionMode] },
    { label: 'Source', value: connection.sourceLabel },
    {
      label: 'Direction',
      value: `Status ${gatedModeLabel(statusSyncMode)} · Pull ${directionLabel(pullMode)} · Push ${directionLabel(pushMode)}`,
      tone: allAuto ? 'text-status-success' : undefined,
    },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      showCloseButton={false}
      closeOnOverlayClick={false}
      className="rounded-none"
    >
      <div
        className="flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        data-testid="tracker-connected-view"
      >
        {/* ── Head ────────────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2.5">
          <Eyebrow className="text-text-primary">Integrations</Eyebrow>
          <span className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
            / {meta.name}
          </span>
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-status-success">
            <span className="h-1.5 w-1.5 rounded-full bg-status-success" />
            Connected
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-none border border-border-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
          >
            All integrations
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary px-6 py-5">
          <div className="mx-auto w-full max-w-[840px] space-y-4">
            {error !== null && (
              <p
                role="alert"
                className="rounded-none border border-status-error px-3 py-2 text-xs text-status-error"
              >
                {error}
              </p>
            )}

            {/* Paused reconnect banner */}
            {connection.status === 'paused' && (
              <div
                className={cn(CARD, 'border-status-warning p-4')}
                data-testid="tracker-reconnect-banner"
              >
                <p className="text-xs font-semibold text-status-warning">
                  {meta.needsApiKey ? 'Credentials need attention' : 'Workspace needs attention'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {meta.needsApiKey ? (
                    <>
                      {meta.name} rejected the stored key on the last sync, so syncing is paused.
                      Paste a new {meta.apiKeyLabel.toLowerCase()} to reconnect.
                    </>
                  ) : recovery?.recovery === 'renamed' ? (
                    <>
                      This workspace&apos;s issue prefix was renamed from{' '}
                      <code>{recovery.boundWorkspaceName}</code> to{' '}
                      <code>{recovery.currentWorkspaceName}</code>, which rewrote every issue id. It
                      is the same database, so cyboflow can remap this connection&apos;s links onto
                      the new ids and carry on.
                    </>
                  ) : recovery?.recovery === 'replaced' ? (
                    <>
                      This workspace was replaced — the <code>.beads</code> directory at this path
                      holds a different database now, so every linked issue belongs to one that no
                      longer exists. Adopting the new workspace retires this connection and starts a
                      fresh one against it.
                    </>
                  ) : (
                    <>
                      The {meta.name} workspace could not be read on the last sync, so syncing is
                      paused. Re-detect it — cyboflow resumes only if it is still the same database.
                    </>
                  )}
                </p>
                {/*
                  The two typed recoveries REPLACE the Re-detect button rather
                  than sitting beside it: re-detecting a renamed or replaced
                  workspace is exactly the action that cannot work, so offering
                  it would send the user round the loop that brought them here.
                */}
                {recovery?.recovery === 'renamed' ? (
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      className="flex-shrink-0 rounded-none"
                      disabled={recovering}
                      loading={recovering}
                      loadingText="Remapping…"
                      onClick={() =>
                        void runRecovery(
                          () =>
                            trpc.cyboflow.tracker.remapRenamedPrefix.mutate({
                              connectionId: connection.id,
                            }),
                          { closeAfter: false },
                        )
                      }
                    >
                      Remap links
                    </Button>
                  </div>
                ) : recovery?.recovery === 'replaced' ? (
                  <div className="mt-3">
                    {confirmingAdopt ? (
                      <div className="space-y-2">
                        <p className="text-xs leading-relaxed text-status-warning">
                          Adopting retires this connection and cancels every write still queued for
                          it — each one is filed for you to check, because a queued write may
                          already exist in the workspace that was replaced. Your ideas, epics and
                          tasks are never archived: items cyboflow can prove are the same are
                          re-linked, and anything it cannot prove is filed for you to confirm.
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            className="flex-shrink-0 rounded-none"
                            disabled={recovering}
                            loading={recovering}
                            loadingText="Adopting…"
                            onClick={() =>
                              void runRecovery(
                                () =>
                                  trpc.cyboflow.tracker.adoptNewWorkspace.mutate({
                                    connectionId: connection.id,
                                  }),
                                { closeAfter: true },
                              )
                            }
                          >
                            Adopt new workspace
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="flex-shrink-0 rounded-none"
                            disabled={recovering}
                            onClick={() => setConfirmingAdopt(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        className="flex-shrink-0 rounded-none"
                        onClick={() => setConfirmingAdopt(true)}
                      >
                        Adopt new workspace…
                      </Button>
                    )}
                  </div>
                ) : (
                <div className="mt-3 flex items-center gap-2">
                  {meta.needsApiKey && (
                    <input
                      type="password"
                      value={reconnectApiKey}
                      onChange={(e) => setReconnectApiKey(e.target.value)}
                      placeholder="paste your key"
                      aria-label={`New ${meta.apiKeyLabel}`}
                      className={cn(trackerInputClass, 'max-w-[360px]')}
                    />
                  )}
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="flex-shrink-0 rounded-none"
                    // Nothing to paste for a keyless connection, so only an
                    // in-flight probe disables the button.
                    disabled={
                      (meta.needsApiKey && reconnectApiKey.trim().length === 0) || reconnecting
                    }
                    loading={reconnecting}
                    loadingText={meta.needsApiKey ? 'Reconnecting…' : 'Re-detecting…'}
                    onClick={() => void handleReconnect()}
                  >
                    {meta.needsApiKey ? 'Reconnect' : 'Re-detect'}
                  </Button>
                </div>
                )}
                {reconnectError !== null && (
                  <p role="alert" className="mt-2 text-xs text-status-error">
                    {reconnectError}
                  </p>
                )}
              </div>
            )}

            {/* Identity + disconnect */}
            <div className="flex items-center gap-3">
              <ProviderTile mark={meta.mark} />
              <div className="min-w-0">
                <h3 className="text-base font-bold text-text-primary">{meta.name}</h3>
                <p className="text-[11px] text-text-tertiary">
                  workspace {connection.workspaceName || 'unknown'} · authorized as{' '}
                  {connection.actorLabel || 'unknown'}
                  {connection.baseUrl !== null && ` · ${connection.baseUrl}`}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {confirmingDisconnect ? (
                  <>
                    <span className="text-[11px] text-text-secondary">
                      Disconnect? Existing links stay.
                    </span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      className="rounded-none"
                      onClick={handleDisconnect}
                    >
                      Confirm
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="rounded-none"
                      onClick={() => setConfirmingDisconnect(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded-none"
                    onClick={() => setConfirmingDisconnect(true)}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            </div>

            {/* Stat grid */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className={cn(CARD, 'p-3')}>
                  <Eyebrow>{stat.label}</Eyebrow>
                  <p className={cn('mt-1.5 truncate text-sm font-bold', stat.tone ?? 'text-text-primary')}>
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            {/* Project mappings */}
            <div className={CARD} data-testid="tracker-mappings-card">
              <div className="flex items-center justify-between gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
                <Eyebrow>Project mappings</Eyebrow>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-none"
                  data-testid="tracker-add-mapping"
                  onClick={onAddMapping}
                >
                  Add mapping
                </Button>
              </div>
              <div className="divide-y divide-border-primary">
                {mappings.map((row) => {
                  const status = MAPPING_STATUS_META[row.status];
                  const isCurrent = row.id === connection.id;
                  const confirmingRemove = confirmingRemoveId === row.id;
                  return (
                    <div
                      key={row.id}
                      data-testid="tracker-mapping-row"
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5',
                        isCurrent && 'bg-surface-secondary',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-text-primary">
                          {row.sourceLabel}
                          <span className="mx-1.5 text-text-tertiary">·</span>
                          <span className="text-text-secondary">{projectName(row.projectId)}</span>
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className={cn('flex items-center gap-1.5 font-semibold', status.textClass)}>
                            <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', status.dotClass)} />
                            {status.label}
                          </span>
                          <span className="text-text-tertiary">{row.linkedCount} linked</span>
                          {/* Honest chip: a paused row holds the flag but enqueues
                              nothing until reconnected — never a green claim. */}
                          {row.pushTarget && (
                            <span
                              className={cn(
                                'flex-shrink-0 rounded-none border px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em]',
                                row.status === 'active'
                                  ? 'border-status-success text-status-success'
                                  : 'border-status-warning text-status-warning',
                              )}
                            >
                              {row.status === 'active' ? 'Pushes' : 'Pushes when reconnected'}
                            </span>
                          )}
                          {isCurrent && (
                            <span className="text-[10px] uppercase tracking-[0.12em] text-text-tertiary">
                              viewing
                            </span>
                          )}
                        </p>
                      </div>

                      <div className="ml-auto flex flex-shrink-0 items-center gap-2">
                        {confirmingRemove ? (
                          <>
                            <span className="text-[11px] text-text-secondary">
                              Remove this mapping? Existing links stay.
                            </span>
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              className="rounded-none"
                              onClick={() => handleRemoveMapping(row.id)}
                            >
                              Confirm
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="rounded-none"
                              onClick={() => setConfirmingRemoveId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            {/* Offered only where the server would accept it: a
                                paused row cannot take the role away from an
                                ACTIVE same-project sibling (it would silently
                                drop every idea filed until it reconnects). */}
                            {!row.pushTarget &&
                              (row.status === 'active' ||
                                !mappings.some(
                                  (m) =>
                                    m.id !== row.id &&
                                    m.projectId === row.projectId &&
                                    m.status === 'active',
                                )) && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="rounded-none"
                                onClick={() => handleSetPushTarget(row.id)}
                              >
                                Make push target
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="rounded-none"
                              onClick={() => setConfirmingRemoveId(row.id)}
                            >
                              Remove
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                {mappings.length === 0 && (
                  <p className="px-3 py-4 text-xs text-text-tertiary">Loading mappings…</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* Sync settings */}
              <div className={CARD}>
                <div className="border-b border-border-primary bg-surface-secondary px-3 py-2">
                  <Eyebrow>Sync settings</Eyebrow>
                </div>
                <div className="divide-y divide-border-primary">
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Auto-sync</p>
                      <p className="text-[11px] text-text-tertiary">every 5 minutes</p>
                    </div>
                    <span className="flex-shrink-0 rounded-none border border-status-success px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-status-success">
                      On
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Sync task status</p>
                      <p className="text-[11px] text-text-tertiary">
                        Status changes on linked items flow both ways.
                      </p>
                    </div>
                    <Segmented
                      options={GATED_MODE_OPTIONS}
                      value={statusSyncMode}
                      onChange={handleStatusSyncMode}
                      ariaLabel="Sync task status"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">
                        Pull from {meta.name}
                      </p>
                      <p className="text-[11px] text-text-tertiary">
                        New {meta.name} issues import as cyboflow ideas.
                      </p>
                    </div>
                    <Segmented
                      options={DIRECTION_OPTIONS}
                      value={pullMode}
                      onChange={handlePullMode}
                      ariaLabel={`Pull from ${meta.name}`}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">
                        Push to {meta.name}
                      </p>
                      <p className="text-[11px] text-text-tertiary">
                        New cyboflow ideas are created as {meta.name} issues.
                      </p>
                    </div>
                    <Segmented
                      options={DIRECTION_OPTIONS}
                      value={pushMode}
                      onChange={handlePushMode}
                      ariaLabel={`Push to ${meta.name}`}
                    />
                  </div>

                  {/*
                   * Multi-project mapping: several sibling connections can
                   * share this cyboflow project, but only one per provider
                   * pushes new ideas out (push_target). No edit affordance —
                   * push target is set by the wizard's Map step, not here.
                   */}
                  {!connection.pushTarget && (
                    <div className="px-3 py-2.5">
                      <p className="text-[11px] text-text-tertiary">
                        New ideas push · off — another mapping for this project pushes
                      </p>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Sync task fields</p>
                      <p className="text-[11px] text-text-tertiary">
                        Title, description, priority
                        {meta.supportsCategorySync ? ', and category' : ''} push out to {meta.name}.
                      </p>
                    </div>
                    <Segmented
                      options={GATED_MODE_OPTIONS}
                      value={contentSyncMode}
                      onChange={handleContentSyncMode}
                      ariaLabel="Sync task fields"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">
                        Archive in {meta.name}
                      </p>
                      <p className="text-[11px] text-text-tertiary">
                        A local archive or delete trashes the linked issue — never a hard delete.
                      </p>
                    </div>
                    <Segmented
                      options={GATED_MODE_OPTIONS}
                      value={archiveSyncMode}
                      onChange={handleArchiveSyncMode}
                      ariaLabel={`Archive in ${meta.name}`}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">
                        Mirror task breakdowns
                      </p>
                      <p className="text-[11px] text-text-tertiary">
                        Planner tasks become sub-issues of the origin issue.
                      </p>
                    </div>
                    <PillToggle
                      checked={mirrorSubissues}
                      onChange={handleMirror}
                      label="Mirror task breakdowns"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Conflicts</p>
                      <p className="text-[11px] text-text-tertiary">
                        {connection.openConflictCount} open
                      </p>
                    </div>
                    <Segmented
                      options={CONFLICT_OPTIONS}
                      value={conflictMode}
                      onChange={handleConflictMode}
                      ariaLabel="Conflict mode"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">State mapping</p>
                      <p className="text-[11px] text-text-tertiary">
                        {mappedCount} of {totalStates} states mapped
                      </p>
                    </div>
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-[0.12em] text-text-tertiary">
                      {mappedTargets || 'nothing imported'}
                    </span>
                  </div>

                  {/*
                   * Read-only, like State mapping above — editing either
                   * table means re-running the wizard (v1's mapping-only
                   * editing rule), so this is a count, never a picker.
                   */}
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Priority mapping</p>
                      <p className="text-[11px] text-text-tertiary">
                        {priorityMappedCount} of 7 priorities mapped
                      </p>
                    </div>
                  </div>

                  {meta.supportsCategorySync && (
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-text-primary">Category mapping</p>
                        <p className="text-[11px] text-text-tertiary">
                          {categoryMappedCount} of 3 categories mapped
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Last sync */}
              <div className={CARD}>
                <div className="flex items-center justify-between gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
                  <Eyebrow>Last sync · {formatSyncedAt(connection.lastSyncAt)}</Eyebrow>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded-none"
                    icon={<RefreshCw className={cn('h-3 w-3', syncing && 'animate-spin')} />}
                    disabled={syncing}
                    onClick={() => void handleSyncNow()}
                  >
                    Sync now
                  </Button>
                </div>
                <div className="space-y-0.5 px-3 py-2.5 font-mono text-[11px]">
                  {log.map((entry, index) => (
                    <p key={`${index}-${entry.line}`} className="flex gap-2">
                      <span className={cn('flex-shrink-0', logMarkerClass(entry.marker))}>
                        {entry.marker}
                      </span>
                      <span className="min-w-0 break-words text-text-secondary">{entry.line}</span>
                    </p>
                  ))}
                  {log.length === 0 && (
                    <p className="text-text-tertiary">No sync has run on this connection yet.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Open conflicts */}
            {showConflicts && (
              <div className={CARD} data-testid="tracker-conflicts-card">
                <div className="border-b border-border-primary bg-surface-secondary px-3 py-2">
                  <Eyebrow>Open conflicts</Eyebrow>
                </div>
                <div className="divide-y divide-border-primary">
                  {conflicts.map((conflict) => (
                    <div key={conflict.id} className="px-3 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] lowercase text-text-tertiary">
                          {conflict.entityRef ?? 'unlinked'}
                        </span>
                        <span className="truncate text-xs font-semibold text-text-primary">
                          {conflict.entityTitle ?? 'Removed in the tracker'}
                        </span>
                        <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-[0.12em] text-status-warning">
                          {conflict.field ?? conflict.kind}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="border border-border-primary p-2">
                          <Eyebrow>Cyboflow</Eyebrow>
                          <p className="mt-1 break-words text-[11px] text-text-secondary">
                            {conflict.localValue ?? '—'}
                          </p>
                        </div>
                        <div className="border border-border-primary p-2">
                          <Eyebrow>{meta.name}</Eyebrow>
                          <p className="mt-1 break-words text-[11px] text-text-secondary">
                            {conflict.remoteValue ?? '—'}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="rounded-none"
                          onClick={() => handleResolve(conflict.id, 'local')}
                        >
                          Accept ours
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="rounded-none"
                          onClick={() => handleResolve(conflict.id, 'remote')}
                        >
                          Accept theirs
                        </Button>
                      </div>
                    </div>
                  ))}
                  {conflicts.length === 0 && (
                    <p className="px-3 py-4 text-xs text-text-tertiary">
                      Nothing is waiting on a decision.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
