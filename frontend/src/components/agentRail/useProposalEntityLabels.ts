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
 * store, so those ids are resolved via a small batched
 * `reviewItems.get` fetch — fired once per distinct set of finding ids this
 * hook is asked to resolve, deduped module-wide so two cards referencing the
 * same finding never issue two queries, and never refetched once resolved
 * (successful AND not-found are both cached — a permanently-deleted finding
 * should not re-query on every render).
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
  /** Display ref (e.g. "TASK-208"); empty for a finding, which has no ref. */
  ref: string;
  type: BacklogTaskItem['type'] | 'finding';
  title: string;
  priority?: BacklogTaskItem['priority'];
  stageId?: string;
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

function flattenStages(boards: { stages: BoardStage[] }[]): Map<string, ResolvedStage> {
  const map = new Map<string, ResolvedStage>();
  for (const board of boards) {
    for (const stage of board.stages) {
      map.set(stage.id, { id: stage.id, label: stage.label, colorOklch: stage.color_oklch });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Findings — batched, deduped, module-cached `reviewItems.get` fetch.
// ---------------------------------------------------------------------------

const findingCache = new Map<string, ResolvedProposalEntity | null>();
const findingInflight = new Map<string, Promise<void>>();

function fetchFinding(id: string): Promise<void> {
  // Already resolved (success OR not-found) by a prior fetch — per this
  // module's contract, never re-query. Without this check a fresh mount
  // referencing an already-cached finding id would re-fire the query, since
  // `findingInflight` alone only dedupes CONCURRENT fetches, not resolved ones.
  if (findingCache.has(id)) return Promise.resolve();
  const cached = findingInflight.get(id);
  if (cached) return cached;
  const promise = trpc.cyboflow.reviewItems.get
    .query({ reviewItemId: id })
    .then((item) => {
      findingCache.set(
        id,
        item !== null ? { id, ref: '', type: 'finding', title: item.title } : null,
      );
    })
    .catch(() => {
      findingCache.set(id, null);
    })
    .finally(() => {
      findingInflight.delete(id);
    });
  findingInflight.set(id, promise);
  return promise;
}

/**
 * Resolve `ids` (task/epic/idea/finding ids) into a Map<id, ResolvedProposalEntity>,
 * plus every board stage the live backlogStore knows about (Map<stageId, ResolvedStage>).
 * Missing entries mean "not (yet) resolvable" — render the unresolved fallback.
 */
export function useProposalEntityLabels(ids: string[]): {
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
    const byId = new Map(flattenTasks(tasks).map((t) => [t.id, t]));
    for (const id of ids) {
      if (id.startsWith(FINDING_ID_PREFIX)) {
        const cached = findingCache.get(id);
        if (cached) map.set(id, cached);
        continue;
      }
      const task = byId.get(id);
      if (task) {
        map.set(id, {
          id,
          ref: task.ref,
          type: task.type,
          title: task.title,
          priority: task.priority,
          stageId: task.stage_id,
          parentEpicId: task.parent_epic_id,
        });
      }
    }
    return map;
    // idsKey is `ids`' stable identity; `tick` re-reads the finding cache once
    // an in-flight fetch settles (the cache itself isn't reactive state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, idsKey, tick]);

  const stages = useMemo(() => flattenStages(boards), [boards]);

  return { entities, stages };
}
