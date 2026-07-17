/**
 * taskGrouping — turns the nested backlog list into epic-grouped task buckets
 * for the sprint / A-B seed-task pickers.
 *
 * The `tasks.list` payload nests epic-owned tasks under their parent epic's
 * `children`; orphan tasks (no parent epic) sit at the top level. The pickers
 * used to `flatMap` the epics away — discarding the association — before
 * filtering to eligible tasks. This preserves the parent epic (ref + title) so
 * the picker can group tasks under a collapsible epic header.
 *
 * Ordering: epic groups appear in the order their epics appear in `rows`, with
 * the catch-all "No epic" group (orphan tasks) last. An epic with zero eligible
 * children is dropped entirely (no empty group).
 */
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

export interface EpicTaskGroup {
  /** The parent epic, or `null` for the catch-all group of orphan tasks. */
  epic: { id: string; ref: string; title: string } | null;
  /** The group's eligible tasks, in list order. Always non-empty. */
  tasks: BacklogTaskItem[];
}

/**
 * Group the backlog `rows` into epic buckets, keeping only tasks that satisfy
 * `isEligible`. Mirrors the old flatten-then-filter, but retains the parent
 * epic. `isEligible` is expected to already gate on `type === 'task'`, so epic
 * and idea rows never leak into a group's tasks.
 */
export function groupTasksByEpic(
  rows: BacklogTaskItem[],
  isEligible: (task: BacklogTaskItem) => boolean,
): EpicTaskGroup[] {
  const groups: EpicTaskGroup[] = [];
  const orphans: BacklogTaskItem[] = [];
  for (const row of rows) {
    if (row.type === 'epic') {
      const kids = (row.children ?? []).filter(isEligible);
      if (kids.length > 0) {
        groups.push({ epic: { id: row.id, ref: row.ref, title: row.title }, tasks: kids });
      }
    } else if (isEligible(row)) {
      orphans.push(row);
    }
  }
  if (orphans.length > 0) groups.push({ epic: null, tasks: orphans });
  return groups;
}

/** Flatten grouped tasks back to a single list-ordered array (for selection logic). */
export function flattenGroups(groups: EpicTaskGroup[]): BacklogTaskItem[] {
  return groups.flatMap((g) => g.tasks);
}
