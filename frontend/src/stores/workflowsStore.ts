/**
 * workflowsStore — cross-project Zustand slice feeding the Workflows gallery
 * (workflow cards stacked over agent cards).
 *
 * GLOBAL singleton with an in-memory `projectFilter` (null = ALL projects),
 * mirroring {@link useInsightsStore}: idempotent `init()` that flips `loading`
 * only on the FIRST run, module-scope subscription handles so init cannot
 * double-subscribe, stale-on-error with a first-failure message, and a
 * 2s-debounced live `refresh()`.
 *
 * ## Bounded fan-out
 *
 * When `projectFilter` is null we enumerate `API.projects.getAll()` and, PER
 * project, call `workflows.list` + `agents.list` + ONE `runs.list`. The
 * `lastUsedAt` for each workflow is derived CLIENT-SIDE by grouping that one
 * `runs.list` result by `workflow_id` (newest `created_at` wins) — we never call
 * `runs.list` per workflow. When filtered we fan out over the single project.
 *
 * Workflows are then DEDUPED BY `row.id` (mirroring the agent dedup): a GLOBAL
 * flow (`project_id` null, migration 030) is returned by every project's
 * `workflows.list`, so it would otherwise repeat once per enumerated project.
 * Its `lastUsedAt` is folded to the NEWEST run timestamp across the fan-out,
 * since a global flow's runs are scattered across the projects it ran in.
 *
 * Each workflow row's effective definition is resolved via
 * {@link resolveWorkflowDefinition}; rows whose definition cannot resolve (a
 * stale custom flow with broken spec, or a hidden scheduler-internal row) are
 * dropped so the gallery never renders a card without a ribbon.
 *
 * ## Live refresh
 *
 * After the first fetch we wire `events.onRunStatusChanged` (no input) plus ONE
 * `agents.onChanged({ projectId })` subscription per ENUMERATED project. Both
 * payloads are AppRouter-inferred (CLAUDE.md rule) and used only as debounce
 * triggers. The agent subscriptions are torn down + re-wired whenever the
 * resolved project set changes (e.g. on a filter change), so we never leak a
 * stale per-project subscription.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import type { AgentEntry } from '../../../shared/types/agents';
import type {
  WorkflowRow,
  WorkflowRunListRow,
  WorkflowDefinition,
} from '../../../shared/types/workflows';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import { wfMeta, type WfMeta } from '../components/workflows/wfMeta';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the lifecycle-event-driven live refresh. */
const REFRESH_DEBOUNCE_MS = 2000;

// ---------------------------------------------------------------------------
// Gallery row shapes
// ---------------------------------------------------------------------------

/** One workflow card in the gallery: row + resolved definition + derived meta. */
export interface WorkflowGalleryEntry {
  /** The underlying `workflows` table row (carries the row id used by Run). */
  row: WorkflowRow;
  /** Effective definition (spec_json override or built-in). Always non-null. */
  definition: WorkflowDefinition;
  /** Headline counts derived from {@link definition}. */
  meta: WfMeta;
  /** ISO timestamp of the most recent run of this workflow, or null if never run. */
  lastUsedAt: string | null;
  /** Owning project's display name (for the cross-project "from N projects" view). */
  projectName: string;
}

/**
 * One agent card in the gallery, adapted from {@link AgentEntry}:
 *   - `id`           = `agentKey`
 *   - `name`         = the entry's display name
 *   - `isOverride`   = `isOverridden`
 *   - `tokensEstimate` = `stats.estPromptTokens`
 * Agents are MODEL-AGNOSTIC, so no model field is carried.
 */
export interface AgentGalleryEntry {
  id: string;
  name: string;
  role: string;
  description: string;
  tools: string[];
  isCustom: boolean;
  isOverride: boolean;
  tokensEstimate: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Group a project's run list by `workflow_id` and return the newest run
 * timestamp per workflow id (ISO `created_at`, lexically comparable). Pure +
 * exported so the per-workflow lastUsedAt derivation can be asserted without a
 * live store.
 */
export function deriveLastUsedByWorkflow(runs: WorkflowRunListRow[]): Record<string, string> {
  const byWorkflow: Record<string, string> = {};
  for (const run of runs) {
    const prior = byWorkflow[run.workflow_id];
    if (prior === undefined || prior < run.created_at) {
      byWorkflow[run.workflow_id] = run.created_at;
    }
  }
  return byWorkflow;
}

/** Adapt an {@link AgentEntry} into an {@link AgentGalleryEntry}. Pure + exported. */
export function toAgentGalleryEntry(entry: AgentEntry): AgentGalleryEntry {
  return {
    id: entry.agentKey,
    name: entry.name,
    role: entry.role,
    description: entry.description,
    tools: entry.tools.slice(),
    isCustom: entry.isCustom,
    isOverride: entry.isOverridden,
    tokensEstimate: entry.stats.estPromptTokens,
  };
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

export interface WorkflowsState {
  /** True once the first fetch + subscribe has run. Closure-mirror of the guard. */
  initialized: boolean;
  /** True only during the FIRST fetch — live refreshes do not flip it. */
  loading: boolean;
  /** First fetch failure's message for the current fan-out; null when clean. */
  error: string | null;
  /** Active project filter; null = ALL projects (the default). In-memory only. */
  projectFilter: number | null;

  /** Workflow cards across the resolved project set. */
  workflows: WorkflowGalleryEntry[];
  /** Agent cards across the resolved project set (deduped by agentKey). */
  agents: AgentGalleryEntry[];

  /**
   * Bootstrap the gallery: first fetch (loading=true) for the current
   * projectFilter, then wire the live subscriptions. Idempotent.
   */
  init: () => Promise<void>;
  /**
   * Re-run the fetch fan-out WITHOUT flipping `initialized`/`loading` (live
   * refreshes never flash). Re-wires the per-project agent subscriptions when
   * the resolved project set changed.
   */
  refresh: () => Promise<void>;
  /** Set the project filter (null = ALL projects) and refresh. */
  setProjectFilter: (projectId: number | null) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkflowsStore = create<WorkflowsState>((set, get) => {
  // Closure-private idempotency guard + subscription state (NOT on the state).
  let initialized = false;
  // Global run-status subscription, created once after the first fetch.
  let runStatusSub: { unsubscribe: () => void } | null = null;
  // Per-project agent-change subscriptions, keyed by projectId. Re-wired when
  // the resolved project set changes so we never leak a stale subscription.
  const agentSubs = new Map<number, { unsubscribe: () => void }>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic fetch generation: a stale in-flight fan-out (whose projectFilter
  // changed mid-flight) must not clobber a newer one's committed slices.
  let fetchGeneration = 0;

  /** Debounced live refresh fired by the lifecycle subscriptions. */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  /**
   * Reconcile the per-project agent subscriptions to exactly `projectIds`:
   * unsubscribe any project no longer in the set, subscribe any new one. Each
   * onData ignores the payload and only debounces a refresh.
   */
  const reconcileAgentSubs = (projectIds: number[]): void => {
    const wanted = new Set(projectIds);
    for (const [pid, sub] of agentSubs) {
      if (!wanted.has(pid)) {
        sub.unsubscribe();
        agentSubs.delete(pid);
      }
    }
    for (const pid of projectIds) {
      if (agentSubs.has(pid)) continue;
      agentSubs.set(
        pid,
        trpc.cyboflow.agents.onChanged.subscribe(
          { projectId: pid },
          {
            onData: () => scheduleRefresh(),
            onError: (err: unknown) =>
              console.warn('[workflowsStore] agents.onChanged error for', pid, err),
          },
        ),
      );
    }
  };

  /**
   * Resolve the projectIds to fan out over: a single id when filtered, else the
   * full project list. Returns the ids alongside a name lookup so the gallery
   * can show each workflow's owning project. Records the error (and returns
   * empty) on a project-list failure.
   */
  const resolveProjects = async (
    filter: number | null,
    recordError: (msg: string) => void,
  ): Promise<{ ids: number[]; names: Map<number, string> }> => {
    try {
      const res = await API.projects.getAll();
      if (res.success && res.data) {
        const names = new Map<number, string>();
        for (const p of res.data as Project[]) names.set(p.id, p.name);
        const ids = filter !== null ? [filter] : (res.data as Project[]).map((p) => p.id);
        return { ids, names };
      }
      recordError(res.error ?? 'projects.getAll returned no data');
      return { ids: filter !== null ? [filter] : [], names: new Map() };
    } catch (err: unknown) {
      recordError(err instanceof Error ? err.message : 'projects.getAll failed');
      return { ids: filter !== null ? [filter] : [], names: new Map() };
    }
  };

  /**
   * The core fetch fan-out shared by init() + refresh(). Per project, runs the
   * three queries in parallel; a failed project's queries are caught + recorded
   * but never abort the others. Guarded by a fetch generation so a stale fan-out
   * cannot overwrite a newer one. Commits the merged workflow + agent rows; on a
   * full failure it leaves the prior slices untouched (stale-not-cleared).
   */
  const runFetch = async (): Promise<void> => {
    const generation = ++fetchGeneration;
    const filter = get().projectFilter;

    let firstError: string | null = null;
    const recordError = (msg: string): void => {
      if (firstError === null) firstError = msg;
    };

    const { ids: projectIds, names } = await resolveProjects(filter, recordError);

    const perProject = await Promise.all(
      projectIds.map(async (projectId) => {
        const safe = async <T>(label: string, p: Promise<T>): Promise<T | undefined> => {
          try {
            return await p;
          } catch (err: unknown) {
            recordError(err instanceof Error ? err.message : `${label} failed for ${projectId}`);
            return undefined;
          }
        };
        const [rows, agentEntries, runs] = await Promise.all([
          safe('workflows.list', trpc.cyboflow.workflows.list.query({ projectId })),
          safe('agents.list', trpc.cyboflow.agents.list.query({ projectId })),
          safe('runs.list', trpc.cyboflow.runs.list.query({ projectId })),
        ]);
        return { projectId, rows, agentEntries, runs };
      }),
    );

    // A newer fetch superseded us — drop everything we computed.
    if (generation !== fetchGeneration) return;

    // Dedupe workflows by row.id (migration 030): a GLOBAL flow (project_id null)
    // is returned by EVERY project's workflows.list, so the cross-project fan-out
    // yields the same row once per enumerated project. We keep ONE entry per id
    // (mirrors the agentsByKey dedup below) and fold the per-project run history
    // into it — a global flow's runs are scattered across projects, so lastUsedAt
    // must be the NEWEST created_at across the whole fan-out, not the first seen.
    const workflowsById = new Map<string, WorkflowGalleryEntry>();
    const agentsByKey = new Map<string, AgentGalleryEntry>();

    for (const { projectId, rows, agentEntries, runs } of perProject) {
      const lastUsed = deriveLastUsedByWorkflow(runs ?? []);
      const projectName = names.get(projectId) ?? '';
      for (const row of rows ?? []) {
        const definition = resolveWorkflowDefinition(row.name, row.spec_json);
        // Drop rows whose definition cannot resolve (broken spec / hidden
        // scheduler-internal row) so the gallery never renders a ribbon-less card.
        if (definition === null) continue;
        const lastUsedAt = lastUsed[row.id] ?? null;
        const existing = workflowsById.get(row.id);
        if (existing !== undefined) {
          // Same global row seen under another project — keep the newest run
          // timestamp across the fan-out (ISO strings are lexically comparable).
          if (
            lastUsedAt !== null &&
            (existing.lastUsedAt === null || existing.lastUsedAt < lastUsedAt)
          ) {
            existing.lastUsedAt = lastUsedAt;
          }
          continue;
        }
        workflowsById.set(row.id, {
          row,
          definition,
          meta: wfMeta(definition),
          lastUsedAt,
          // A global row carries no owning project; the chip is hidden for it
          // (project_id null), so projectName is unused there. A project-scoped
          // row gets the project it was fetched under.
          projectName: row.project_id === null ? '' : projectName,
        });
      }
      for (const entry of agentEntries ?? []) {
        // Dedupe across projects by agentKey — built-ins repeat per project.
        if (!agentsByKey.has(entry.agentKey)) {
          agentsByKey.set(entry.agentKey, toAgentGalleryEntry(entry));
        }
      }
    }

    const workflows = Array.from(workflowsById.values());

    // Commit only when at least one project's queries yielded data; an
    // all-failed fan-out keeps the prior slices (stale-not-cleared).
    const anyData = perProject.some((p) => p.rows !== undefined || p.agentEntries !== undefined);
    const prev = get();
    set({
      workflows: anyData ? workflows : prev.workflows,
      agents: anyData ? Array.from(agentsByKey.values()) : prev.agents,
      error: firstError,
    });

    // Re-wire the per-project agent subscriptions to the resolved set (no-op
    // before init() has created the first ones — reconcile runs again in init()).
    if (initialized && runStatusSub !== null) reconcileAgentSubs(projectIds);
  };

  return {
    initialized: false,
    loading: false,
    error: null,
    projectFilter: null,
    workflows: [],
    agents: [],

    init: async () => {
      if (initialized) return;
      initialized = true;
      set({ loading: true });

      await runFetch();
      set({ initialized: true, loading: false });

      // Wire the global run-status subscription once, then reconcile the
      // per-project agent subscriptions to the just-resolved project set.
      runStatusSub = trpc.cyboflow.events.onRunStatusChanged.subscribe(undefined, {
        onData: () => scheduleRefresh(),
        onError: (err: unknown) =>
          console.warn('[workflowsStore] onRunStatusChanged error:', err),
      });
      const filter = get().projectFilter;
      const { ids } = await resolveProjects(filter, () => {});
      reconcileAgentSubs(ids);
    },

    refresh: async () => {
      await runFetch();
    },

    setProjectFilter: async (projectId) => {
      set({ projectFilter: projectId });
      await runFetch();
    },
  };
});
