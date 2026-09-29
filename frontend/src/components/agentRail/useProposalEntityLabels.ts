/**
 * useProposalEntityLabels — resolves the opaque entity ids a proposal payload
 * references (task/epic/idea ids and, for launch-run, finding/review-item
 * ids) into human-readable refs/titles, plus board-stage ids into their
 * label + color, for {@link ProposalCardBodies} (TASK-221).
 *
 * Tasks/epics/ideas resolve SYNCHRONOUSLY off the already-live
 * {@link useBacklogStore} — App.tsx calls `useBacklogStore.getState().init()`
 * once at boot, which loads EVERY project's backlog (`tasks.list({projectId:
 * null})`) and boards (`tasks.boardsForProject({projectId: null})`) and keeps
 * both current via the `onTaskChanged` subscription. Reusing that store (per
 * the task brief's "reuse existing backlog/board queries" ask) means no new
 * tRPC round-trip for the common case — only reprioritize-backlog and the
 * task/idea seeds of launch-run ever hit this path.
 *
 * Findings (review_items, id prefix `rvw_`) have no equivalent standing
 * store, and the reviewItems router has no by-id batch procedure (`list` is a
 * project inbox query that hides orphaned/machine-audience rows, so it cannot
 * stand in for a by-id lookup), so those ids are resolved via one
 * `reviewItems.get` per DISTINCT finding id — deduped module-wide so two cards
 * referencing the same finding never issue two queries. Authoritative answers
 * (found / not-found) are cached for the renderer lifetime — a permanently-
 * deleted finding should not re-query on every render. A TRANSPORT FAILURE is
 * NOT cached: it leaves the id unresolved for this mount and re-queries on the
 * next mount / id-set change, so a transient IPC hiccup never sticks.
 *
 * PROJECT SCOPING: every lookup is filtered to `projectId` — the proposal's
 * own project. This is a human confirmation surface, so an id from ANOTHER
 * project must degrade to the muted unresolved marker rather than resolve to
 * a convincing ref/title. Tasks/epics/ideas filter on `project_id`, stages on
 * the owning board's `project_id`, and a fetched finding on its `project_id`.
 *
 * Unresolved ids (deleted entity, cross-project reference, or a finding fetch
 * still in flight / that came back null) are simply ABSENT from the returned
 * map — callers render the muted "unresolved" fallback for anything missing,
 * never a blank cell (TASK-221 acceptance).
 */
import { useEffect, useMemo, useState } from 'react';
import { useBacklogStore } from '../../stores/backlogStore';
import { trpc } from '../../trpc/client';
import type { BacklogTaskItem, BoardStage } from '../../../../shared/types/tasks';

const FINDING_ID_PREFIX = 'rvw_';

export interface ResolvedProposalEntity {
  id: string;
  /** Owning project — every lookup is scoped to the proposal's project. */
  projectId: number;
  /** Display ref (e.g. "TASK-208"); empty for a finding, which has no ref. */
  ref: string;
  type: BacklogTaskItem['type'] | 'finding';
  title: string;
  /** Only ever set for type==='task' — used to group reprioritize rows by epic. */
  parentEpicId?: string | null;
}

export interface ResolvedStage {
  id: string;
  label: string;
  colorOklch: string;
}

/** `backlogStore.tasks` is top-level items with an epic's tasks under `.children` — flatten both levels. */
function flattenTasks(items: BacklogTaskItem[]): BacklogTaskItem[] {
  const out: BacklogTaskItem[] = [];
  for (const item of items) {
    out.push(item);
    if (item.children) out.push(...item.children);
  }
  return out;
}

function flattenStages(
  boards: { project_id: number; stages: BoardStage[] }[],
  projectId: number,
): Map<string, ResolvedStage> {
  const map = new Map<string, ResolvedStage>();
  for (const board of boards) {
    if (board.project_id !== projectId) continue;
    for (const stage of board.stages) {
      map.set(stage.id, { id: stage.id, label: stage.label, colorOklch: stage.color_oklch });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Findings — deduped, module-cached `reviewItems.get` fetch (one per distinct
// id; see the module doc for why there is no batch procedure to use).
// ---------------------------------------------------------------------------

/**
 * Authoritative answers only: a resolved entity (with its owning project) or
 * `null` for a confirmed not-found. A transport failure is deliberately NOT
 * written here so the next mount retries it.
 *
 * STALENESS: this cache is NOT wired to `reviewItems.onReviewItemChanged` — an
 * answer, once cached, is never invalidated for the renderer's lifetime. A
 * finding whose title is edited after first resolution keeps showing the
 * stale title on every proposal card until reload, and a finding resolved
 * `null` before it was minted stays "(unresolved)" permanently. Acceptable
 * for a one-shot confirmation card (the proposal itself is a point-in-time
 * snapshot); {@link resetProposalFindingCacheForTests} is the only way to
 * clear it, and only in tests.
 */
const findingCache = new Map<string, ResolvedProposalEntity | null>();
const findingInflight = new Map<string, Promise<void>>();

function fetchFinding(id: string): Promise<void> {
  // Already answered (found OR not-found) by a prior fetch — never re-query.
  // Without this check a fresh mount referencing an already-cached finding id
  // would re-fire the query, since `findingInflight` alone only dedupes
  // CONCURRENT fetches, not answered ones.
  if (findingCache.has(id)) return Promise.resolve();
  const cached = findingInflight.get(id);
  if (cached) return cached;
  const promise = trpc.cyboflow.reviewItems.get
    .query({ reviewItemId: id })
    .then((item) => {
      findingCache.set(
        id,
        item !== null
          ? { id, projectId: item.project_id, ref: '', type: 'finding', title: item.title }
          : null,
      );
    })
    .catch((err: unknown) => {
      // Transient (transport) failure: leave the id unanswered so it renders
      // as unresolved for THIS mount and is retried on the next one, instead
      // of pinning "unresolved" for the renderer's lifetime. Still worth a
      // trace — mirrors dynamicWorkflowStore's console.warn on the same
      // failure class — so a persistently failing reviewItems.get isn't
      // silently invisible.
      console.warn('[useProposalEntityLabels] reviewItems.get failed for', id, err);
    })
    .finally(() => {
      findingInflight.delete(id);
    });
  findingInflight.set(id, promise);
  return promise;
}

/** Test-only: drop every cached finding answer (the cache is module-global). */
export function resetProposalFindingCacheForTests(): void {
  findingCache.clear();
  findingInflight.clear();
}

/**
 * Resolve `ids` (task/epic/idea/finding ids) belonging to `projectId` into a
 * Map<id, ResolvedProposalEntity>, plus every board stage of that project the
 * live backlogStore knows about (Map<stageId, ResolvedStage>). Missing entries
 * mean "not (yet) resolvable" — or not this project's — render the unresolved
 * fallback.
 */
export function useProposalEntityLabels(ids: string[], projectId: number): {
  entities: Map<string, ResolvedProposalEntity>;
  stages: Map<string, ResolvedStage>;
} {
  const tasks = useBacklogStore((s) => s.tasks);
  const boards = useBacklogStore((s) => s.boards);

  const idsKey = ids.join(',');

  // The module-level finding cache is not reactive state — `tick` is bumped
  // once every outstanding finding fetch this hook kicked off settles,
  // forcing the `entities` memo below to re-read the now-populated cache.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const findingIds = idsKey.length === 0 ? [] : idsKey.split(',').filter((id) => id.startsWith(FINDING_ID_PREFIX));
    if (findingIds.length === 0) return;
    let cancelled = false;
    void Promise.all(findingIds.map(fetchFinding)).then(() => {
      if (!cancelled) setTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  const entities = useMemo(() => {
    const map = new Map<string, ResolvedProposalEntity>();
    const byId = new Map(
      flattenTasks(tasks)
        .filter((t) => t.project_id === projectId)
        .map((t) => [t.id, t]),
    );
    for (const id of ids) {
      if (id.startsWith(FINDING_ID_PREFIX)) {
        const cached = findingCache.get(id);
        if (cached && cached.projectId === projectId) map.set(id, cached);
        continue;
      }
      const task = byId.get(id);
      if (task) {
        map.set(id, {
          id,
          projectId,
          ref: task.ref,
          type: task.type,
          title: task.title,
          parentEpicId: task.parent_epic_id,
        });
      }
    }
    return map;
    // idsKey is `ids`' stable identity; `tick` re-reads the finding cache once
    // an in-flight fetch settles (the cache itself isn't reactive state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, idsKey, projectId, tick]);

  const stages = useMemo(() => flattenStages(boards, projectId), [boards, projectId]);

  return { entities, stages };
}
