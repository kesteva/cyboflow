/**
 * useArtifactData — resolve the CONTENT an artifact tab renders, by atype.
 *
 * The artifacts table row (the `Artifact`) carries identity + commit state, but
 * for TEMPLATED artifacts the actual content is RE-DERIVED from the live entity
 * model on every read (per the pinned contract) — never trusted from a stale
 * `payload_json` snapshot:
 *
 *   - 'idea-spec'          -> the originating idea (its markdown `body`), fetched
 *                             via `trpc.cyboflow.tasks.get({ taskId: sourceRef })`.
 *   - 'decomposed-stories' -> the RUN's whole decomposition — ONE idea tree
 *                             (idea root + nested epics + each epic's tasks) PER
 *                             idea the run owns — fetched via the DEDICATED
 *                             `trpc.cyboflow.tasks.runDecomposition({ runId })`
 *                             read (covers the multi-idea planner batch). Keyed by
 *                             `artifact.runId` (ALWAYS set), NOT sourceRef: a run
 *                             can own several ideas, so a single idea id is
 *                             insufficient. An EMPTY array (run owns no resolvable
 *                             idea) is a valid result, not an error.
 *   - 'arch-design'        -> the originating idea (fetched exactly like
 *                             'idea-spec' via `tasks.get`); the renderer extracts
 *                             the '## Architecture design' section from its body
 *                             with the SHARED extractArchDesignSection.
 *   - 'idea-summary'       -> the ledger HUB, in two shapes. SINGLE idea: BOTH
 *                             the originating idea (`tasks.get`) AND the idea
 *                             component ledger's merged hybrid view
 *                             (`cyboflow.ideaComponents.get`, migration 101) —
 *                             sourceRef-keyed like idea-spec/arch-design, but
 *                             needs a SECOND fetch, so it gets its own block.
 *                             COMBINED multi-idea batch (payload_json.combined):
 *                             RUN-scoped instead — `tasks.runDecomposition` for
 *                             the batch's ideas, zipped against ONE batched
 *                             `ideaComponents.getMany`, resolving to kind
 *                             'idea-summaries'.
 *   - 'screenshots'        -> no entity source yet; the parsed `payload_json`
 *                             (`{ fileNames?: string[] }`) is surfaced as-is.
 *   - 'ui-prototype' / 'generic' (canvas) -> the parsed `payload_json`
 *                             (`{ fileName?: string; url?: string }`): a static
 *                             mockup carries a `fileName` pointer (HTML fetched
 *                             by useArtifactHtml), a legacy live canvas a `url`.
 *
 * `sourceRef` is the soft entity link (ideaId for the templated planner artifacts).
 * When it is absent for a templated atype the hook reports a graceful error rather
 * than throwing, so the renderer can show an empty state.
 *
 * Live semantics: the entity-backed atypes (idea-spec / decomposed-stories /
 * arch-design) re-derive from the live entity model, so a first fetch alone is
 * not enough — a task/epic created under this idea after the tab opened would
 * otherwise stay invisible until the tab is closed and reopened. The hook stays
 * reactive via the project-scoped `cyboflow.tasks.onTaskChanged` subscription.
 * idea-spec / arch-design re-fetch on any change to THIS idea or its descendants
 * (epics + tasks carry `originating_idea_id` = the root idea); decomposed-stories
 * re-fetches on ANY task change in the project, because the run's idea set is not
 * known cheaply here. Live re-fetches are SILENT: the current
 * content stays on screen (no loading flash) and a failed refresh keeps the
 * last-good data rather than blanking the tab. `projectId` scopes the channel;
 * when it is null the hook still does its one-shot fetch but cannot stay live.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import { isCanvasArtifact, isCombinedBatchArtifact } from '../../../shared/types/artifacts';
import type {
  Artifact,
  EvalReportPayload,
  RecommendationsArtifactPayload,
  VerifyRunbookArtifactPayload,
  AdversarialReviewArtifactPayload,
  ScreenshotsArtifactPayload,
} from '../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../shared/types/tasks';
import type { IdeaComponentState } from '../../../shared/types/ideaComponents';

/**
 * Parsed `payload_json` shape for the canvas (ui-prototype / generic) embed.
 *
 * A static `ui-prototype` mockup (Approach C) persists a `fileName` POINTER to
 * its on-disk `prototype/index.html` — the HTML itself is NOT in the payload; it
 * is fetched separately by {@link useArtifactHtml} through the `artifacts:load-html`
 * IPC and embedded via `<iframe srcDoc>`. A legacy `generic` live canvas keeps
 * the `url` passthrough (cross-origin dev-server iframe). Both members are
 * optional and extra keys are tolerated (payload is per-atype).
 */
export interface CanvasPayload {
  /** On-disk relative path to the static mockup document (ui-prototype pointer). */
  fileName?: string;
  /** Legacy live-embed URL (e.g. localhost preview) — drives the cross-origin iframe. */
  url?: string;
  /** Free-form extra keys are tolerated (payload is per-atype). */
  [key: string]: unknown;
}

/**
 * Parsed `payload_json` shape for the screenshots gallery. Re-exported alias of
 * the shared {@link ScreenshotsArtifactPayload} (single source of truth for the
 * fileNames + optional verdict block, kept in sync with the main-side verdict
 * delivery chokepoint that enriches the same payload) — kept under this local
 * name so existing renderer imports do not churn.
 */
export type ScreenshotsPayload = ScreenshotsArtifactPayload;

/**
 * Parsed `payload_json` shape for the compound-recommendations doc. Re-exported
 * alias of the shared {@link RecommendationsArtifactPayload} — the compound
 * orchestrator writes `{ markdown }`, resolved straight from the payload (no
 * entity source, no fetch), kept under this local name for renderer imports.
 */
export type RecommendationsPayload = RecommendationsArtifactPayload;

/**
 * Parsed `payload_json` shape for the ad-hoc eval's verdict report. Re-exported
 * alias of the shared {@link EvalReportPayload} — EvalWorker writes `{ markdown }`
 * when it completes an `origin='adhoc'` row, resolved straight from the payload
 * (no entity source, no fetch), kept under this local name for renderer imports.
 */
export type EvalReportArtifactPayload = EvalReportPayload;

/**
 * Parsed `payload_json` shape for the project-brief doc (Launch flow). Same
 * shape as {@link RecommendationsArtifactPayload} — a payload-backed `{
 * markdown }` doc with no entity source — reused rather than duplicated since
 * the two atypes' payload contracts are identical; kept under its own local
 * name for renderer imports (mirrors {@link RecommendationsPayload}).
 */
export type ProjectBriefPayload = RecommendationsArtifactPayload;

/**
 * One row of the COMBINED multi-idea idea-summary tab: an idea the run owns,
 * paired with its merged component-ledger snapshot. Positionally zipped from
 * `tasks.runDecomposition` + `ideaComponents.getMany` (which echoes one entry
 * per requested id, in order), so the two halves can never come apart.
 */
export interface IdeaSummaryEntry {
  idea: BacklogTaskItem;
  components: IdeaComponentState[];
}

/**
 * Discriminated content union the renderer switches on. `kind` mirrors the
 * resolved data source, NOT the atype 1:1 (idea-spec + decomposed-stories both
 * resolve from the entity model but produce different shapes).
 */
export type ArtifactContent =
  | { kind: 'idea'; idea: BacklogTaskItem }
  | { kind: 'stories'; ideas: BacklogTaskItem[] }
  | { kind: 'arch'; idea: BacklogTaskItem }
  | { kind: 'idea-summary'; idea: BacklogTaskItem; components: IdeaComponentState[] }
  | { kind: 'idea-summaries'; entries: IdeaSummaryEntry[] }
  | { kind: 'screenshots'; payload: ScreenshotsPayload }
  | { kind: 'recommendations'; payload: RecommendationsPayload }
  | { kind: 'eval-report'; payload: EvalReportArtifactPayload }
  | { kind: 'verify-runbook'; payload: VerifyRunbookArtifactPayload }
  | { kind: 'adversarial-review'; payload: AdversarialReviewArtifactPayload }
  | { kind: 'brief'; payload: ProjectBriefPayload }
  | { kind: 'canvas'; payload: CanvasPayload };

export interface ArtifactData {
  loading: boolean;
  error: string | null;
  /** Null while loading / on error / when there is no content to derive. */
  data: ArtifactContent | null;
}

/** Tolerant JSON.parse → object; returns {} on null/empty/invalid. */
function parsePayload(payloadJson: string | null): Record<string, unknown> {
  if (!payloadJson) return {};
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function useArtifactData(artifact: Artifact, projectId: number | null): ArtifactData {
  const [state, setState] = useState<ArtifactData>({ loading: true, error: null, data: null });

  const { atype, sourceRef, payloadJson, runId } = artifact;

  useEffect(() => {
    // Canvas + screenshots resolve synchronously from the payload — no fetch,
    // no subscription. Canvas membership comes from the artifact-policy
    // registry (ui-prototype / generic / interactive-prototype), not a literal
    // list — a new canvas atype must not silently fall through to the
    // entity-fetch branches below.
    if (isCanvasArtifact(atype)) {
      setState({ loading: false, error: null, data: { kind: 'canvas', payload: parsePayload(payloadJson) } });
      return;
    }
    if (atype === 'screenshots') {
      setState({
        loading: false,
        error: null,
        data: { kind: 'screenshots', payload: parsePayload(payloadJson) },
      });
      return;
    }
    // compound-recommendations is payload-backed (no entity source): the
    // compound orchestrator wrote the doc into payload_json.markdown, so it
    // resolves synchronously like the canvas/screenshots atypes.
    if (atype === 'compound-recommendations') {
      setState({
        loading: false,
        error: null,
        data: { kind: 'recommendations', payload: parsePayload(payloadJson) },
      });
      return;
    }
    // eval-report is payload-backed for the same reason: EvalWorker composed the
    // verdict doc into payload_json.markdown when the ad-hoc eval completed, so
    // there is no entity to re-derive from and it resolves synchronously.
    if (atype === 'eval-report') {
      setState({
        loading: false,
        error: null,
        data: { kind: 'eval-report', payload: parsePayload(payloadJson) },
      });
      return;
    }
    // verify-runbook is payload-backed for the same reason: the verify-setup
    // orchestrator composed the runbook proposal into payload_json.markdown and
    // enriches the SAME artifact with the proof outcomes, so there is no entity
    // to re-derive from and it resolves synchronously.
    if (atype === 'verify-runbook') {
      setState({
        loading: false,
        error: null,
        data: { kind: 'verify-runbook', payload: parsePayload(payloadJson) },
      });
      return;
    }
    // adversarial-review is payload-backed for the same reason: the planner /
    // launch / ship orchestrator composed the reviewer's Blocking + Findings
    // markdown into payload_json.markdown (one artifact per run, ENRICHED on a
    // re-review), so there is no entity to re-derive from and it resolves
    // synchronously.
    if (atype === 'adversarial-review') {
      setState({
        loading: false,
        error: null,
        data: { kind: 'adversarial-review', payload: parsePayload(payloadJson) },
      });
      return;
    }
    // project-brief mirrors compound-recommendations exactly: payload-backed
    // (no entity source), the Launch interview phase wrote the doc into
    // payload_json.markdown, so it resolves synchronously too.
    if (atype === 'project-brief') {
      setState({
        loading: false,
        error: null,
        data: { kind: 'brief', payload: parsePayload(payloadJson) },
      });
      return;
    }

    // decomposed-stories — RUN-scoped (one idea tree per idea the run owns), so it
    // does NOT require sourceRef; it re-derives from the live entity model via
    // artifact.runId (ALWAYS set). Handled here in its own block so the
    // single-idea (sourceRef) path below stays untouched.
    //
    // A COMBINED idea-spec (payload_json.combined — the multi-idea batch's one
    // rolled-up "Idea specs" tab) takes the SAME run-scoped path: same query,
    // same live subscription, resolving to kind 'stories' with the batch's
    // ideas. Its sourceRef is only an identity anchor, not the data source.
    const isCombinedIdeaSpec = atype === 'idea-spec' && isCombinedBatchArtifact(payloadJson);
    if (atype === 'decomposed-stories' || isCombinedIdeaSpec) {
      let cancelled = false;
      // Monotonic fetch id — a slow earlier (re-)fetch must never clobber a newer.
      let latestFetchId = 0;

      const resolveStories = (silent: boolean): void => {
        if (!silent) setState({ loading: true, error: null, data: null });
        const fetchId = ++latestFetchId;
        trpc.cyboflow.tasks.runDecomposition.query({ runId }).then(
          (ideas) => {
            if (cancelled || fetchId !== latestFetchId) return;
            // [] is valid (run owns no resolvable idea) — the renderer shows its
            // own empty state, this is NOT a fetch error.
            setState({ loading: false, error: null, data: { kind: 'stories', ideas } });
          },
          (err: unknown) => {
            if (cancelled || fetchId !== latestFetchId) return;
            const message = err instanceof Error ? err.message : 'Failed to load artifact content.';
            if (silent) {
              console.warn('[useArtifactData] live refresh failed:', err);
              // Mirror the single-idea path: a silent refresh keeps last-good data,
              // but surfaces the error if the initial load never committed.
              setState((prev) => (prev.loading ? { loading: false, error: message, data: null } : prev));
              return;
            }
            setState({ loading: false, error: message, data: null });
          },
        );
      };

      resolveStories(false);

      // Without a projectId we cannot scope the live channel, so the tab is one-shot.
      if (projectId === null) {
        return () => {
          cancelled = true;
        };
      }

      // Stay live. Unlike the single-idea path we CANNOT cheaply know the run's
      // idea set here (a multi-idea run's artifact carries no single idea id), so
      // re-fetch on ANY task change in the project rather than filtering to one
      // idea root. The read is a couple of indexed selects and refreshes are silent.
      const storiesSub = trpc.cyboflow.tasks.onTaskChanged.subscribe(
        { projectId },
        {
          onData: () => {
            resolveStories(true);
          },
          onError: (err: unknown) => console.warn('[useArtifactData] onTaskChanged error:', err),
        },
      );

      return () => {
        cancelled = true;
        storiesSub.unsubscribe();
      };
    }

    // COMBINED idea-summary (payload_json.combined) — the multi-idea batch's one
    // rolled-up "Idea summaries" tab. RUN-scoped like the combined idea-spec: it
    // re-derives the batch's ideas from `tasks.runDecomposition({ runId })` and
    // their ledgers from ONE batched `ideaComponents.getMany`, so its sourceRef
    // (the first owned idea) is an identity anchor only, never the data source.
    //
    // Archived ideas are dropped here rather than in the renderer — unlike the
    // combined idea-spec, whose two halves are one array, this path zips ideas
    // against ledger rows, so filtering AFTER the getMany call would leave the
    // two lists misaligned. Filter first, then request exactly the ids kept.
    //
    // Stays live on BOTH channels, each unfiltered: a task change anywhere in
    // the project can add/remove an idea from the run's owned set (which is not
    // cheaply knowable here — same reason decomposed-stories re-fetches broadly),
    // and a ledger write to ANY of the batch's ideas changes a rendered cell.
    if (atype === 'idea-summary' && isCombinedBatchArtifact(payloadJson)) {
      let cancelled = false;
      // Monotonic fetch id — a slow earlier (re-)fetch must never clobber a newer.
      let latestFetchId = 0;

      const resolveSummaries = (silent: boolean): void => {
        if (!silent) setState({ loading: true, error: null, data: null });
        const fetchId = ++latestFetchId;
        trpc.cyboflow.tasks.runDecomposition
          .query({ runId })
          .then((ideas) => {
            if (cancelled || fetchId !== latestFetchId) return null;
            const active = ideas.filter((i) => i.archived_at === null);
            if (active.length === 0) return { active, states: [] };
            return trpc.cyboflow.ideaComponents.getMany
              .query({ ideaIds: active.map((i) => i.id) })
              .then((states) => ({ active, states }));
          })
          .then(
            (resolved) => {
              if (cancelled || fetchId !== latestFetchId || resolved === null) return;
              const entries: IdeaSummaryEntry[] = resolved.active.map((idea, i) => ({
                idea,
                components: resolved.states[i]?.states ?? [],
              }));
              setState({ loading: false, error: null, data: { kind: 'idea-summaries', entries } });
            },
            (err: unknown) => {
              if (cancelled || fetchId !== latestFetchId) return;
              const message = err instanceof Error ? err.message : 'Failed to load artifact content.';
              if (silent) {
                console.warn('[useArtifactData] live refresh failed:', err);
                setState((prev) => (prev.loading ? { loading: false, error: message, data: null } : prev));
                return;
              }
              setState({ loading: false, error: message, data: null });
            },
          );
      };

      resolveSummaries(false);

      // Without a projectId we cannot scope the live channels, so the tab is one-shot.
      if (projectId === null) {
        return () => {
          cancelled = true;
        };
      }

      const batchTaskSub = trpc.cyboflow.tasks.onTaskChanged.subscribe(
        { projectId },
        {
          onData: () => {
            resolveSummaries(true);
          },
          onError: (err: unknown) => console.warn('[useArtifactData] onTaskChanged error:', err),
        },
      );
      const batchComponentsSub = trpc.cyboflow.ideaComponents.onComponentsChanged.subscribe(
        { projectId },
        {
          onData: () => {
            resolveSummaries(true);
          },
          onError: (err: unknown) => console.warn('[useArtifactData] onComponentsChanged error:', err),
        },
      );

      return () => {
        cancelled = true;
        batchTaskSub.unsubscribe();
        batchComponentsSub.unsubscribe();
      };
    }

    // idea-summary (SINGLE idea) — the per-idea HUB. It IS sourceRef-keyed (the idea), like
    // idea-spec/arch-design, but needs TWO fetches — the idea itself AND the
    // ledger's merged hybrid view (`cyboflow.ideaComponents.get`, migration
    // 098) — so it gets its own block rather than reusing the toContent
    // ternary below. Stays live on BOTH channels: an entity write to this
    // idea/its descendants (onTaskChanged) refreshes the idea half; a ledger
    // write to this idea specifically (onComponentsChanged) refreshes the
    // component half. Either trigger re-fetches BOTH halves together (silent).
    if (atype === 'idea-summary') {
      if (!sourceRef) {
        setState({ loading: false, error: 'No source entity linked to this artifact.', data: null });
        return;
      }

      let cancelled = false;
      // Monotonic fetch id — a slow earlier (re-)fetch must never clobber a newer.
      let latestFetchId = 0;

      const resolveSummary = (silent: boolean): void => {
        if (!silent) setState({ loading: true, error: null, data: null });
        const fetchId = ++latestFetchId;
        Promise.all([
          trpc.cyboflow.tasks.get.query({ taskId: sourceRef }),
          trpc.cyboflow.ideaComponents.get.query({ ideaId: sourceRef }),
        ]).then(
          ([idea, components]) => {
            if (cancelled || fetchId !== latestFetchId) return;
            if (!idea) {
              setState({ loading: false, error: 'Source entity not found.', data: null });
              return;
            }
            setState({ loading: false, error: null, data: { kind: 'idea-summary', idea, components } });
          },
          (err: unknown) => {
            if (cancelled || fetchId !== latestFetchId) return;
            const message = err instanceof Error ? err.message : 'Failed to load artifact content.';
            if (silent) {
              console.warn('[useArtifactData] live refresh failed:', err);
              setState((prev) => (prev.loading ? { loading: false, error: message, data: null } : prev));
              return;
            }
            setState({ loading: false, error: message, data: null });
          },
        );
      };

      resolveSummary(false);

      // Without a projectId we cannot scope the live channels, so the tab is
      // one-shot.
      if (projectId === null) {
        return () => {
          cancelled = true;
        };
      }

      const taskSub = trpc.cyboflow.tasks.onTaskChanged.subscribe(
        { projectId },
        {
          onData: (event) => {
            if (event.task.id === sourceRef || event.task.originating_idea_id === sourceRef) {
              resolveSummary(true);
            }
          },
          onError: (err: unknown) => console.warn('[useArtifactData] onTaskChanged error:', err),
        },
      );
      const componentsSub = trpc.cyboflow.ideaComponents.onComponentsChanged.subscribe(
        { projectId },
        {
          onData: (event) => {
            if (event.ideaId === sourceRef) {
              resolveSummary(true);
            }
          },
          onError: (err: unknown) => console.warn('[useArtifactData] onComponentsChanged error:', err),
        },
      );

      return () => {
        cancelled = true;
        taskSub.unsubscribe();
        componentsSub.unsubscribe();
      };
    }

    // Templated entity-backed types (idea-spec / arch-design) re-derive from the
    // live entity model via sourceRef (the originating idea id).
    if (!sourceRef) {
      setState({ loading: false, error: 'No source entity linked to this artifact.', data: null });
      return;
    }

    let cancelled = false;
    // Monotonic fetch id: a slow earlier (re-)fetch must never clobber a newer
    // one — the last request issued is the only one allowed to commit state.
    let latestFetchId = 0;

    const toContent = (idea: BacklogTaskItem): ArtifactContent =>
      atype === 'arch-design' ? { kind: 'arch', idea } : { kind: 'idea', idea };

    // Resolve the current content. `silent` = a live refresh triggered by an
    // entity change: keep the on-screen content (no loading flash) and, on
    // failure, keep the last-good data instead of blanking the tab. The initial
    // load (silent=false) shows the loading state and surfaces errors.
    //
    // idea-spec / arch-design fetch the bare idea body (decomposed-stories and
    // idea-summary are each handled in their own block above).
    const resolve = (silent: boolean): void => {
      if (!silent) setState({ loading: true, error: null, data: null });
      const fetchId = ++latestFetchId;
      const fetched = trpc.cyboflow.tasks.get.query({ taskId: sourceRef });

      fetched.then(
        (idea) => {
          if (cancelled || fetchId !== latestFetchId) return;
          if (!idea) {
            setState({ loading: false, error: 'Source entity not found.', data: null });
            return;
          }
          setState({ loading: false, error: null, data: toContent(idea) });
        },
        (err: unknown) => {
          if (cancelled || fetchId !== latestFetchId) return;
          const message = err instanceof Error ? err.message : 'Failed to load artifact content.';
          if (silent) {
            console.warn('[useArtifactData] live refresh failed:', err);
            // A silent refresh normally keeps the last-good content on screen.
            // BUT a live event can fire DURING the initial in-flight load and
            // supersede it (its fetchId is bumped, so its eventual success is
            // discarded by the guard above). If that superseding silent refetch
            // then fails, there is NO last-good data to keep — swallowing the
            // error would strand the tab on a permanent spinner. So when the
            // initial load has not committed yet (`prev.loading` still true),
            // surface the error and clear the spinner; otherwise keep prior data.
            setState((prev) => (prev.loading ? { loading: false, error: message, data: null } : prev));
            return;
          }
          setState({ loading: false, error: message, data: null });
        },
      );
    };

    resolve(false);

    // Stay live: the content is RE-DERIVED from the entity model, so a change to
    // this idea or its descendants must re-fetch — otherwise the tab shows a
    // stale decomposition until it is closed and reopened. The channel is
    // project-scoped; we filter to THIS idea (id) or any epic/task that carries
    // originating_idea_id = the root idea (covers direct + epic-nested tasks).
    // Without a projectId we cannot scope the channel, so the tab is one-shot.
    if (projectId === null) {
      return () => {
        cancelled = true;
      };
    }

    const sub = trpc.cyboflow.tasks.onTaskChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          if (event.task.id === sourceRef || event.task.originating_idea_id === sourceRef) {
            resolve(true);
          }
        },
        onError: (err: unknown) => console.warn('[useArtifactData] onTaskChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [atype, sourceRef, payloadJson, projectId, runId]);

  return state;
}
