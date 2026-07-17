/**
 * EpicGroupedTaskList — the shared collapsible epic-grouped list body for the
 * sprint / A-B seed-task pickers (ABTestLaunchModal + TaskBatchPickerModal).
 *
 * Each surface keeps rendering its OWN task row via {@link renderTask} (so its
 * markup, chips, and `data-testid`s are untouched); this component owns only the
 * grouping chrome: a collapsible header per epic with a tri-state "select whole
 * epic" checkbox, a live selected-count, and a catch-all "No epic" group.
 *
 * Graceful degradation: when no real epic is present (every task is an orphan),
 * it renders the plain flat list it always did — no group chrome — so nothing
 * changes for a flat backlog.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { EpicTaskGroup } from './taskGrouping';
import { flattenGroups } from './taskGrouping';

export interface EpicGroupedTaskListProps {
  groups: EpicTaskGroup[];
  /** Currently-selected task ids (drives each group's tri-state). */
  selectedIds: Set<string>;
  /**
   * A task counts toward its group's tri-state only when selectable — i.e. not
   * in-flight. In-flight tasks can't be selected, so they're excluded from the
   * "all selected" calculation and from a group-select toggle.
   */
  isSelectable: (task: BacklogTaskItem) => boolean;
  /**
   * Toggle a whole group's selectable tasks. `select` is the target state
   * (true ⇒ add up to the caller's cap; false ⇒ remove all). The caller owns
   * cap enforcement.
   */
  onToggleGroup: (taskIds: string[], select: boolean) => void;
  /** Render one task's full row (the surface's own `<label>` markup + testids). */
  renderTask: (task: BacklogTaskItem) => React.ReactNode;
  /** Prefix for the container + group-level test ids, e.g. "task-batch-picker". */
  testIdPrefix: string;
  /** Extra classes for the scroll container (e.g. "max-h-52 overflow-y-auto"). */
  listClassName?: string;
}

const ORPHAN_KEY = '__no_epic__';

/** A checkbox that also renders the indeterminate (partial-selection) state. */
function TriStateCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
  testId,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: () => void;
  ariaLabel: string;
  testId: string;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={ariaLabel}
      data-testid={testId}
      className="mt-0"
    />
  );
}

function Caret({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function EpicGroupedTaskList({
  groups,
  selectedIds,
  isSelectable,
  onToggleGroup,
  renderTask,
  testIdPrefix,
  listClassName = '',
}: EpicGroupedTaskListProps): React.JSX.Element {
  const hasEpics = useMemo(() => groups.some((g) => g.epic !== null), [groups]);
  // Collapse state keyed by epic id (orphans under ORPHAN_KEY). Default expanded
  // (absent ⇒ open) so the user sees their tasks without a click.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // No real epic present → plain flat list, exactly as before grouping existed.
  if (!hasEpics) {
    return (
      <ul
        className={`flex flex-col gap-1 ${listClassName}`}
        data-testid={`${testIdPrefix}-list`}
      >
        {flattenGroups(groups).map((t) => (
          <li key={t.id}>{renderTask(t)}</li>
        ))}
      </ul>
    );
  }

  return (
    <div
      className={`flex flex-col gap-1.5 ${listClassName}`}
      data-testid={`${testIdPrefix}-list`}
    >
      {groups.map((group) => {
        const key = group.epic?.id ?? ORPHAN_KEY;
        const isCollapsed = collapsed.has(key);
        const selectable = group.tasks.filter(isSelectable);
        const selectableIds = selectable.map((t) => t.id);
        const selectedCount = selectable.filter((t) => selectedIds.has(t.id)).length;
        const allSelected = selectable.length > 0 && selectedCount === selectable.length;
        const someSelected = selectedCount > 0 && !allSelected;
        return (
          <div
            key={key}
            data-testid={`${testIdPrefix}-group-${key}`}
            className={`overflow-hidden rounded-button border ${
              group.epic ? 'border-border-primary' : 'border-dashed border-border-primary'
            }`}
          >
            <div className="flex items-center gap-2 bg-bg-tertiary px-2 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => toggleCollapse(key)}
                aria-expanded={!isCollapsed}
                aria-label={group.epic ? `Toggle ${group.epic.ref}` : 'Toggle ungrouped tasks'}
                data-testid={`${testIdPrefix}-group-toggle-${key}`}
                className="flex items-center text-text-tertiary hover:text-text-primary"
              >
                <Caret open={!isCollapsed} />
              </button>
              <TriStateCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={selectable.length === 0}
                onChange={() => onToggleGroup(selectableIds, !allSelected)}
                ariaLabel={
                  group.epic ? `Select all in ${group.epic.ref}` : 'Select all ungrouped tasks'
                }
                testId={`${testIdPrefix}-group-checkbox-${key}`}
              />
              {group.epic ? (
                <>
                  <span className="font-medium text-interactive">{group.epic.ref}</span>
                  <span className="flex-1 truncate text-text-primary">{group.epic.title}</span>
                </>
              ) : (
                <span className="flex-1 italic text-text-tertiary">No epic</span>
              )}
              {selectedCount > 0 && (
                <span className="whitespace-nowrap text-[10px] font-semibold text-interactive">
                  {selectedCount} selected
                </span>
              )}
              <span className="whitespace-nowrap rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
                {group.tasks.length}
              </span>
            </div>
            {!isCollapsed && (
              <ul className="flex flex-col gap-1 p-1.5">
                {group.tasks.map((t) => (
                  <li key={t.id}>{renderTask(t)}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
