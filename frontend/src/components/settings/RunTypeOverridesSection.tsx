/**
 * RunTypeOverridesSection — the "Session type overrides" sub-block of Settings →
 * AI → Session settings, sitting directly below "Global defaults".
 *
 * A grouped inventory of every session type (built-in flows · quick sessions ·
 * custom flows, project-scoped ones grouped under their project) with a
 * `Following defaults` / `N overrides` badge, chips for ONLY the values that
 * differ from the global defaults, and a `Configure ›` CTA that swaps the list
 * for {@link RunTypeOverrideDetail}.
 *
 * Unlike its sibling groups this is a SELF-FETCHING panel (the
 * `IntegrationsSettings` pattern), not a props-in/callback-out container: its
 * writes go through the dedicated `configStore.applyRunTypeDefault` IPC op, NOT
 * `Settings.tsx`'s shared `handleSubmit` — see the RunTypeOverrideDetail module
 * doc for why routing it through the shared form would clobber concurrent
 * launch-screen writes.
 *
 * ## Why this does its OWN cross-project fetch instead of `useWorkflowsStore`
 *
 * The Workflows gallery's `useWorkflowsStore` is a GLOBAL singleton with an
 * in-memory `projectFilter` another view (`WorkflowsView`) can leave scoped to
 * one project. This screen must always show the FULL inventory regardless of
 * that filter — a filtered store would silently drop real flows AND mislabel
 * their saved defaults as "unmatched" (`buildRunTypeGroups`'s stale bucket).
 * Reusing that store (even just its already-idempotent `init()`) would inherit
 * whatever filter it was last left in and — since `setProjectFilter` mutates
 * shared state — clearing it here would leak back into `WorkflowsView`. So this
 * component fetches every project's `workflows.list` directly (mirroring
 * `TrackerIntegrationSection`'s per-project fan-out, not the gallery store) and
 * never touches `workflowsStore` at all.
 *
 * A failed fan-out is surfaced, not swallowed: `error` renders an inline
 * message (with Retry) so a partial or empty list is never mistaken for a
 * complete one, and a per-project failure still commits whatever OTHER
 * projects' rows resolved (stale-not-cleared, same as `workflowsStore`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Layers } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { trpc } from '../../trpc/client';
import { API } from '../../utils/api';
import type { Project } from '../../types/project';
import { RunTypeOverrideDetail } from './RunTypeOverrideDetail';
import {
  buildRunTypeGroups,
  resolveRunTypeBaseline,
  runTypeOverrideChips,
  runTypeStatusLabel,
  type RunTypeRow,
  type RunTypeWorkflowSource,
} from './runTypeOverrides';

interface WorkflowInventory {
  workflows: RunTypeWorkflowSource[];
  /** First fan-out failure's message; null once a fetch fully succeeds. */
  error: string | null;
  /**
   * True once the fetch has settled at least once (success OR failure). The
   * quick-session row renders unconditionally regardless of fetch state, so
   * this is the only reliable "has the inventory actually resolved" signal —
   * tests wait on it instead of racing a group that may or may not appear.
   */
  loaded: boolean;
  retry: () => void;
}

/**
 * Fetch every workflow row across ALL projects, independent of any filter
 * `workflowsStore` might be scoped to — see the module doc's "Why this does
 * its OWN cross-project fetch" section.
 */
function useCrossProjectWorkflowInventory(): WorkflowInventory {
  const [workflows, setWorkflows] = useState<RunTypeWorkflowSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback((): (() => void) => {
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const projectsRes = await API.projects.getAll();
        if (!projectsRes.success || !Array.isArray(projectsRes.data)) {
          throw new Error(projectsRes.error ?? 'Could not list projects');
        }
        const projects = projectsRes.data as Project[];
        const byId = new Map<string, RunTypeWorkflowSource>();
        let firstError: string | null = null;
        await Promise.all(
          projects.map(async (project) => {
            try {
              const rows = await trpc.cyboflow.workflows.list.query({ projectId: project.id });
              for (const row of rows) {
                if (!byId.has(row.id)) {
                  byId.set(row.id, {
                    row,
                    projectName: row.project_id === null ? '' : project.name,
                  });
                }
              }
            } catch (err: unknown) {
              if (firstError === null) {
                firstError =
                  err instanceof Error
                    ? err.message
                    : `Could not load flows for ${project.name}`;
              }
            }
          }),
        );
        if (cancelled) return;
        setWorkflows(Array.from(byId.values()));
        setError(firstError);
        setLoaded(true);
      } catch (err: unknown) {
        if (cancelled) return;
        // The projects list itself failed — leave any PRIOR rows standing
        // (stale-not-cleared) rather than blanking a list that was working.
        setError(err instanceof Error ? err.message : 'Could not load your flows');
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load, attempt]);

  return { workflows, error, loaded, retry: () => setAttempt((a) => a + 1) };
}

export interface RunTypeOverridesSectionProps {
  /**
   * Fires whenever the {@link RunTypeOverrideDetail} sub-screen opens/closes.
   * Its own Save/Cancel are the ONLY sanctioned way to leave a draft there —
   * see the RunTypeOverrideDetail module doc — so `Settings.tsx` uses this to
   * disable the modal's shared footer Save while the sub-screen is open,
   * rather than let that footer's `handleSubmit` silently discard whatever
   * override edits are in progress (they are not part of its payload at all).
   */
  onDetailScreenOpenChange?: (open: boolean) => void;
}

export function RunTypeOverridesSection({
  onDetailScreenOpenChange,
}: RunTypeOverridesSectionProps = {}): React.JSX.Element {
  const config = useConfigStore((s) => s.config);
  const {
    workflows,
    error: workflowsError,
    loaded: workflowsLoaded,
    retry: retryWorkflows,
  } = useCrossProjectWorkflowInventory();
  const [selected, setSelected] = useState<RunTypeRow | null>(null);

  useEffect(() => {
    onDetailScreenOpenChange?.(selected !== null);
    // Reset on unmount too (e.g. the settings modal closes while the
    // sub-screen is open) so the flag never sticks "open" for a screen that
    // no longer exists.
    return () => onDetailScreenOpenChange?.(false);
  }, [selected, onDetailScreenOpenChange]);

  const runTypeDefaults = config?.runTypeDefaults;

  const groups = useMemo(
    () =>
      buildRunTypeGroups(
        workflows,
        runTypeDefaults === undefined ? [] : Object.keys(runTypeDefaults),
      ),
    [workflows, runTypeDefaults],
  );

  if (selected !== null) {
    return (
      <section aria-labelledby="session-settings-run-type-overrides" className="mt-8">
        <h4
          id="session-settings-run-type-overrides"
          className="text-xs font-semibold uppercase tracking-[.08em] text-text-tertiary mb-4"
        >
          Session type overrides
        </h4>
        <RunTypeOverrideDetail
          runTypeKey={selected.key}
          title={selected.label}
          subtitle={selected.sublabel}
          stored={runTypeDefaults?.[selected.key]}
          baseline={resolveRunTypeBaseline(selected.key, config)}
          onClose={() => setSelected(null)}
        />
      </section>
    );
  }

  return (
    <section
      aria-labelledby="session-settings-run-type-overrides"
      className="mt-8"
      data-testid="run-type-overrides"
      data-workflows-loaded={workflowsLoaded}
    >
      <h4
        id="session-settings-run-type-overrides"
        className="text-xs font-semibold uppercase tracking-[.08em] text-text-tertiary mb-4"
      >
        Session type overrides
      </h4>
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-shrink-0 mt-0.5 text-interactive">
          <Layers className="w-4 h-4" />
        </div>
        <p className="text-xs text-text-tertiary leading-relaxed">
          Per-session-type overrides of the global defaults above. A type with no
          override follows the defaults; only the values that actually differ are
          listed.
        </p>
      </div>

      {workflowsError !== null && (
        <div
          role="alert"
          data-testid="run-type-overrides-error"
          className="mb-4 flex items-start justify-between gap-3 rounded-button border border-status-error bg-surface-secondary px-3 py-2"
        >
          <p className="text-xs leading-relaxed text-status-error">
            Couldn't load your flows — this list may be incomplete: {workflowsError}
          </p>
          <button
            type="button"
            data-testid="run-type-overrides-retry"
            onClick={retryWorkflows}
            className="shrink-0 text-xs font-medium text-interactive hover:text-text-primary transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.id}>
            <div className="text-xs font-medium text-text-secondary mb-2">{group.title}</div>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => {
                const chips = runTypeOverrideChips(
                  runTypeDefaults?.[row.key],
                  resolveRunTypeBaseline(row.key, config),
                );
                return (
                  <div
                    key={row.key}
                    data-testid={`run-type-row-${row.key}`}
                    className="flex items-start justify-between gap-3 px-3 py-2 rounded-button border border-border-secondary bg-surface-secondary"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{row.label}</span>
                        <span
                          data-testid={`run-type-status-${row.key}`}
                          className={`text-xs px-1.5 py-0.5 rounded-full border ${
                            chips.length === 0
                              ? 'border-border-secondary text-text-tertiary'
                              : 'border-interactive text-interactive'
                          }`}
                        >
                          {runTypeStatusLabel(chips.length)}
                        </span>
                      </div>
                      {row.sublabel !== '' && (
                        <p className="text-xs text-text-tertiary mt-0.5">{row.sublabel}</p>
                      )}
                      {chips.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                          {chips.map((chip) => (
                            <span
                              key={chip.field}
                              data-testid={`run-type-chip-${row.key}-${chip.field}`}
                              className="text-xs px-1.5 py-0.5 rounded-full border border-border-secondary text-text-secondary"
                              title={
                                chip.baseline === null
                                  ? `${chip.label}: no global default`
                                  : `${chip.label}: default is ${chip.baseline}`
                              }
                            >
                              {chip.label}: {chip.value}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Configure ${row.label}`}
                      onClick={() => setSelected(row)}
                      className="shrink-0 inline-flex items-center gap-0.5 text-xs text-interactive hover:text-text-primary transition-colors"
                    >
                      Configure
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
