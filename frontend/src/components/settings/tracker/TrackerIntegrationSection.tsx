/**
 * TrackerIntegrationSection — the issue-tracker catalog inside
 * Settings → Integrations, rendered below the Claude/Codex provider rows.
 *
 * One row per entry in TRACKER_PROVIDERS (Linear, Plane, Dart) — the catalog is
 * data-driven, so a new provider is one row in that table and nothing here.
 * A connection is one (tracker group -> cyboflow project) mapping, so a single
 * wizard run can mint several sibling connections at once; each row lists
 * EVERY project's connection for that provider (project chip + status +
 * Manage) — not just the active project's. Connect renders only while the
 * provider has NO live connection: once one exists, further mappings are added
 * through Manage (the connected view's mappings card opens the wizard in
 * add-mapping mode against the existing authorization).
 *
 * Connections are read across all projects and re-read on every
 * `onTrackerChanged` notification (one subscription per project): the event is
 * a signal, not a patch, so the handler always re-queries rather than mutating
 * a card from the payload.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { useNavigationStore } from '../../../stores/navigationStore';
import { cn } from '../../../utils/cn';
import type { Project } from '../../../types/project';
import type {
  TrackerConnectionStatus,
  TrackerConnectionSummary,
  TrackerProvider,
} from '../../../../../shared/types/trackerSync';
import { ProviderTile } from './trackerShared';
import { TRACKER_PROVIDERS } from './trackerVocabulary';
import { TrackerWizardModal } from './TrackerWizardModal';
import { TrackerConnectedView } from './TrackerConnectedView';

/** Honest per-status presentation — paused is a warning, never a green dot. */
const STATUS_META: Record<
  TrackerConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  active: { label: 'Connected', dotClass: 'bg-status-success', textClass: 'text-status-success' },
  paused: {
    label: 'Paused — check credentials',
    dotClass: 'bg-status-warning',
    textClass: 'text-status-warning',
  },
  disconnected: {
    label: 'Disconnected',
    dotClass: 'bg-text-tertiary',
    textClass: 'text-text-tertiary',
  },
};

export function TrackerIntegrationSection(): React.JSX.Element {
  const activeProjectId = useNavigationStore((s) => s.activeProjectId);

  const [projects, setProjects] = useState<Project[]>([]);
  const [connections, setConnections] = useState<TrackerConnectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Which sub-modal is open: the wizard for a provider, or one connection's manage view. */
  const [wizardProvider, setWizardProvider] = useState<TrackerProvider | null>(null);
  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null);
  /**
   * The connection whose authorization the ADD-MAPPING wizard is extending —
   * opened from the manage view's mappings card. Non-null is the only state
   * that mounts the second wizard, and it stacks ON TOP of the manage view
   * rather than replacing it, so closing it returns to the card that opened it.
   */
  const [addMappingSource, setAddMappingSource] = useState<TrackerConnectionSummary | null>(null);

  const refresh = useCallback((): void => {
    void (async () => {
      try {
        let projectRows: Project[] = [];
        try {
          const res = await API.projects.getAll();
          if (res.success && Array.isArray(res.data)) projectRows = res.data;
        } catch {
          projectRows = [];
        }
        // Keep the array identity stable when nothing changed, so the
        // per-project subscription effect below does not churn on every event.
        setProjects((prev) =>
          prev.length === projectRows.length &&
          prev.every((p, i) => p.id === projectRows[i].id && p.name === projectRows[i].name)
            ? prev
            : projectRows,
        );
        const ids =
          projectRows.length > 0
            ? projectRows.map((p) => p.id)
            : activeProjectId !== null
              ? [activeProjectId]
              : [];
        const rows = await Promise.all(
          ids.map((id) => trpc.cyboflow.tracker.connections.query({ projectId: id })),
        );
        setConnections(rows.flat());
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [activeProjectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live refresh, one subscription per known project. The onData payload type
  // is AppRouter-inferred — do not annotate it.
  useEffect(() => {
    const ids =
      projects.length > 0
        ? projects.map((p) => p.id)
        : activeProjectId !== null
          ? [activeProjectId]
          : [];
    const subs = ids.map((id) =>
      trpc.cyboflow.tracker.onTrackerChanged.subscribe(
        { projectId: id },
        { onData: () => refresh() },
      ),
    );
    return () => subs.forEach((sub) => sub.unsubscribe());
  }, [projects, activeProjectId, refresh]);

  const projectName = (id: number): string =>
    projects.find((p) => p.id === id)?.name ?? `Project ${id}`;

  const managed = connections.find((c) => c.id === manageConnectionId) ?? null;

  return (
    <SettingsSection
      title="Issue trackers"
      description="Two-way sync between a project's backlog and an external tracker."
      icon={<Link2 className="h-4 w-4" />}
      className="ml-0"
    >
      {error !== null && (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      )}

      {activeProjectId === null && (
        <p className="text-xs text-text-tertiary">
          Select a project to connect an issue tracker.
        </p>
      )}

      <div className="divide-y divide-border-primary overflow-hidden rounded-none border border-border-primary bg-surface-primary">
        {TRACKER_PROVIDERS.map((meta) => {
          const providerConnections = connections.filter((c) => c.provider === meta.provider);
          return (
            <div key={meta.provider} className="flex items-start gap-3 px-4 py-4">
              <ProviderTile mark={meta.mark} />
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-text-primary">{meta.name}</h4>
                <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                  {meta.description}
                </p>
              </div>

              <div className="flex flex-shrink-0 flex-col items-end gap-2">
                {providerConnections.length === 0 && (
                  <span className="text-xs text-text-tertiary">Not connected</span>
                )}
                {/*
                  Connect renders only while the provider has NO live connection:
                  once one exists, adding a mapping goes through Manage (the
                  connected view's mappings card + add-mapping wizard), and a
                  standing Connect here would mint a SECOND workspace
                  authorization when the user almost always means "another
                  mapping". Connecting a genuinely different workspace of the
                  same provider means disconnecting first — the deliberate
                  trade-off of this rule.
                */}
                {providerConnections.length === 0 && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="rounded-none"
                    disabled={activeProjectId === null}
                    onClick={() => setWizardProvider(meta.provider)}
                  >
                    Connect
                  </Button>
                )}
                {providerConnections.map((connection) => {
                  const status = STATUS_META[connection.status];
                  return (
                    <div key={connection.id} className="flex items-center gap-2">
                      <span className="rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
                        {projectName(connection.projectId)}
                      </span>
                      <span
                        className={cn(
                          'flex items-center gap-2 text-xs font-semibold',
                          status.textClass,
                        )}
                      >
                        <span
                          className={cn('h-2 w-2 flex-shrink-0 rounded-full', status.dotClass)}
                        />
                        {/* A connection paused because another machine holds its sync claim says so. */}
                        {connection.status === 'paused' && connection.claimHold ? connection.claimHold : status.label}
                      </span>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="rounded-none"
                        onClick={() => setManageConnectionId(connection.id)}
                      >
                        Manage
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/*
        Nested sub-modals — each mounted only while open, so it opens with fresh
        state. The add-mapping wizard is the one deliberate STACK: it mounts over
        a manage view that stays mounted underneath, because dismissing it must
        land back on the mappings card it was launched from.
      */}
      {wizardProvider !== null && activeProjectId !== null && (
        <TrackerWizardModal
          isOpen
          provider={wizardProvider}
          projectId={activeProjectId}
          // Which projects this provider already covers — the workspace-bound
          // Map step renders those rows inert instead of probing them. Read off
          // the connections this section already holds, live rows only: a
          // disconnected one covers nothing.
          connectedProjectIds={connections
            .filter((c) => c.provider === wizardProvider && c.status !== 'disconnected')
            .map((c) => c.projectId)}
          onClose={() => setWizardProvider(null)}
          onConnected={refresh}
        />
      )}

      {managed !== null && (
        <TrackerConnectedView
          isOpen
          connection={managed}
          projectName={projectName}
          onAddMapping={() => setAddMappingSource(managed)}
          onClose={() => setManageConnectionId(null)}
          onChanged={refresh}
        />
      )}

      {addMappingSource !== null && (
        <TrackerWizardModal
          isOpen
          provider={addMappingSource.provider}
          // The Map step pre-selects the active project where there is one; the
          // source connection's own project is the honest fallback when none is.
          projectId={activeProjectId ?? addMappingSource.projectId}
          sourceConnection={addMappingSource}
          onClose={() => setAddMappingSource(null)}
          onConnected={refresh}
        />
      )}
    </SettingsSection>
  );
}
