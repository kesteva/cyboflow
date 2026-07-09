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
 *   - 'decomposed-stories' -> the originating idea WITH its epic children and each
 *                             epic's task children, fetched via the DEDICATED
 *                             `trpc.cyboflow.tasks.ideaDecomposition({ ideaId })`
 *                             read (`selectIdeaDecomposition` nests epics under the
 *                             idea via originating_idea_id, then tasks under each
 *                             epic via parent_epic_id). `tasks.get`/`selectTaskById`
 *                             is NOT usable here — it only nests children for an
 *                             EPIC, so an idea id yields children===undefined and
 *                             the renderer would always show its empty state.
 *   - 'arch-design'        -> the originating idea (fetched exactly like
 *                             'idea-spec' via `tasks.get`); the renderer extracts
 *                             the '## Architecture design' section from its body
 *                             with the SHARED extractArchDesignSection.
 *   - 'screenshots'        -> no entity source yet; the parsed `payload_json`
 *                             (`{ fileNames?: string[] }`) is surfaced as-is.
 *   - 'ui-prototype' / 'generic' (canvas) -> the parsed `payload_json`
 *                             (`{ url?: string }`) for the embed seam (M-later).
 *
 * `sourceRef` is the soft entity link (ideaId for the templated planner artifacts).
 * When it is absent for a templated atype the hook reports a graceful error rather
 * than throwing, so the renderer can show an empty state.
 *
 * Live semantics: the entity-backed atypes (idea-spec / decomposed-stories /
 * arch-design) re-derive from the live entity model, so a first fetch alone is
 * not enough — a task/epic created under this idea after the tab opened would
 * otherwise stay invisible until the tab is closed and reopened. The hook stays
 * reactive via the project-scoped `cyboflow.tasks.onTaskChanged` subscription,
 * re-fetching on any change to THIS idea or its descendants (epics + tasks carry
 * `originating_idea_id` = the root idea). Live re-fetches are SILENT: the current
 * content stays on screen (no loading flash) and a failed refresh keeps the
 * last-good data rather than blanking the tab. `projectId` scopes the channel;
 * when it is null the hook still does its one-shot fetch but cannot stay live.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type {
  Artifact,
  RecommendationsArtifactPayload,
  ScreenshotsArtifactPayload,
} from '../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../shared/types/tasks';

/** Parsed `payload_json` shape for the canvas (ui-prototype / generic) embed. */
export interface CanvasPayload {
  /** Live-embed URL (e.g. localhost preview) — drives the iframe seam later. */
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
 * Discriminated content union the renderer switches on. `kind` mirrors the
 * resolved data source, NOT the atype 1:1 (idea-spec + decomposed-stories both
 * resolve from the entity model but produce different shapes).
 */
export type ArtifactContent =
  | { kind: 'idea'; idea: BacklogTaskItem }
  | { kind: 'stories'; idea: BacklogTaskItem }
  | { kind: 'arch'; idea: BacklogTaskItem }
  | { kind: 'screenshots'; payload: ScreenshotsPayload }
  | { kind: 'recommendations'; payload: RecommendationsPayload }
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

  const { atype, sourceRef, payloadJson } = artifact;

  useEffect(() => {
    // Canvas + screenshots resolve synchronously from the payload — no fetch,
    // no subscription.
    if (atype === 'ui-prototype' || atype === 'generic') {
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

    // Templated entity-backed types (idea-spec / decomposed-stories / arch-design)
    // re-derive from the live entity model via sourceRef (the originating idea id).
    if (!sourceRef) {
      setState({ loading: false, error: 'No source entity linked to this artifact.', data: null });
      return;
    }

    let cancelled = false;
    // Monotonic fetch id: a slow earlier (re-)fetch must never clobber a newer
    // one — the last request issued is the only one allowed to commit state.
    let latestFetchId = 0;

    const toContent = (idea: BacklogTaskItem): ArtifactContent =>
      atype === 'idea-spec'
        ? { kind: 'idea', idea }
        : atype === 'arch-design'
          ? { kind: 'arch', idea }
          : { kind: 'stories', idea };

    // Resolve the current content. `silent` = a live refresh triggered by an
    // entity change: keep the on-screen content (no loading flash) and, on
    // failure, keep the last-good data instead of blanking the tab. The initial
    // load (silent=false) shows the loading state and surfaces errors.
    //
    // decomposed-stories uses the DEDICATED ideaDecomposition read so the idea
    // arrives with its epic children + each epic's task children already nested
    // (tasks.get would only nest children for an epic → an idea id there has
    // children===undefined). idea-spec / arch-design fetch the bare idea body.
    const resolve = (silent: boolean): void => {
      if (!silent) setState({ loading: true, error: null, data: null });
      const fetchId = ++latestFetchId;
      const fetched =
        atype === 'decomposed-stories'
          ? trpc.cyboflow.tasks.ideaDecomposition.query({ ideaId: sourceRef })
          : trpc.cyboflow.tasks.get.query({ taskId: sourceRef });

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
  }, [atype, sourceRef, payloadJson, projectId]);

  return state;
}
