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
 *   - 'screenshots'        -> no entity source yet; the parsed `payload_json`
 *                             (`{ fileNames?: string[] }`) is surfaced as-is.
 *   - 'ui-prototype' / 'generic' (canvas) -> the parsed `payload_json`
 *                             (`{ url?: string }`) for the embed seam (M-later).
 *
 * `sourceRef` is the soft entity link (ideaId for the templated planner artifacts).
 * When it is absent for a templated atype the hook reports a graceful error rather
 * than throwing, so the renderer can show an empty state.
 *
 * Snapshot semantics: fetched on mount / when the artifact id or sourceRef change.
 * The tab content remounts on focus, so switching back re-fetches.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type { Artifact } from '../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../shared/types/tasks';

/** Parsed `payload_json` shape for the canvas (ui-prototype / generic) embed. */
export interface CanvasPayload {
  /** Live-embed URL (e.g. localhost preview) — drives the iframe seam later. */
  url?: string;
  /** Free-form extra keys are tolerated (payload is per-atype). */
  [key: string]: unknown;
}

/** Parsed `payload_json` shape for the screenshots gallery. */
export interface ScreenshotsPayload {
  /** On-disk file names of captured screenshots (bytes loaded separately later). */
  fileNames?: string[];
  [key: string]: unknown;
}

/**
 * Discriminated content union the renderer switches on. `kind` mirrors the
 * resolved data source, NOT the atype 1:1 (idea-spec + decomposed-stories both
 * resolve from the entity model but produce different shapes).
 */
export type ArtifactContent =
  | { kind: 'idea'; idea: BacklogTaskItem }
  | { kind: 'stories'; idea: BacklogTaskItem }
  | { kind: 'screenshots'; payload: ScreenshotsPayload }
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

export function useArtifactData(artifact: Artifact): ArtifactData {
  const [state, setState] = useState<ArtifactData>({ loading: true, error: null, data: null });

  const { atype, sourceRef, payloadJson } = artifact;

  useEffect(() => {
    let cancelled = false;

    // Canvas + screenshots resolve synchronously from the payload — no fetch.
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

    // Templated entity-backed types (idea-spec / decomposed-stories) re-derive
    // from the live entity model via sourceRef (the originating idea id).
    if (!sourceRef) {
      setState({ loading: false, error: 'No source entity linked to this artifact.', data: null });
      return;
    }

    setState({ loading: true, error: null, data: null });

    // idea-spec fetches the bare idea (markdown body). decomposed-stories uses
    // the DEDICATED ideaDecomposition read so the idea arrives with its epic
    // children + each epic's task children already nested (tasks.get would only
    // nest children for an epic → an idea id there has children===undefined).
    const fetched =
      atype === 'decomposed-stories'
        ? trpc.cyboflow.tasks.ideaDecomposition.query({ ideaId: sourceRef })
        : trpc.cyboflow.tasks.get.query({ taskId: sourceRef });

    fetched.then(
      (idea) => {
        if (cancelled) return;
        if (!idea) {
          setState({ loading: false, error: 'Source entity not found.', data: null });
          return;
        }
        setState({
          loading: false,
          error: null,
          data: atype === 'idea-spec' ? { kind: 'idea', idea } : { kind: 'stories', idea },
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load artifact content.',
          data: null,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [atype, sourceRef, payloadJson]);

  return state;
}
