/**
 * HumanTasksSection — the blue band: work assigned to a person rather than an
 * agent.
 *
 * Two sources, one band:
 *   - Backlog human tasks (executor 'human', see ./humanTasks.ts) — selectable,
 *     with three bulk actions over the selection: "Mark complete" (moves each to
 *     its board's Done stage), and "Verify complete" / "Help me with it", which
 *     open ONE in-place quick session covering every selected task. A quick
 *     session belongs to one project, so a cross-project selection prompts the
 *     user to narrow it to a single project first.
 *   - Loose action items — `human_task` review items NOT tied to a backlog task
 *     (a task's own `human-task:<id>` item is folded into its row upstream).
 *     Single-line with "Details ▸" and one verdict, "Mark done".
 *
 * The section is omitted entirely when empty — an empty well here would imply
 * the queue expects you to have chores, which it does not.
 */
import React from 'react';
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { useQuickSession } from '../../hooks/useQuickSession';
import { useNavigationStore } from '../../stores/navigationStore';
import { trpc } from '../../trpc/client';
import { Chip, GhostButton, PrimaryButton, SecondaryButton, SectionHeader } from './QueuePrimitives';
import { compactAge } from './queueSelectors';
import { buildHumanTaskKickoff, findDoneStageId, type HumanTaskSessionMode } from './humanTasks';

const ROW_CHROME =
  'flex flex-col gap-1.5 border bg-surface-raised px-3.5 py-2.5 shadow-[inset_3px_0_0_var(--color-status-info)]';

function HumanBacklogTaskRow({
  task,
  checked,
  onToggle,
  projectName,
  dependents,
}: {
  task: BacklogTaskItem;
  checked: boolean;
  onToggle: () => void;
  projectName: string | null;
  dependents: readonly string[];
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const body = task.body?.trim() || task.summary?.trim() || '';
  return (
    <div
      data-testid={`rq-human-task-${task.id}`}
      className={`${ROW_CHROME} ${checked ? 'border-interactive' : 'border-border-primary'}`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-interactive-primary)]"
          aria-label={`Select ${task.ref} ${task.title}`}
        />
        <span className="shrink-0 text-[10px] text-text-tertiary">{task.ref}</span>
        <span className="min-w-0 truncate text-[12.5px] font-bold text-text-primary" title={task.title}>
          {task.title}
        </span>
        {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {dependents.length > 0 && (
            <span className="text-[10px] text-text-tertiary" title={dependents.join(', ')}>
              {dependents.length === 1 ? `${dependents[0]} waits on this` : `${dependents.length} tasks wait on this`}
            </span>
          )}
          {body !== '' && (
            <GhostButton className="text-[11px]" onClick={() => setExpanded((v) => !v)}>
              Details {expanded ? '▾' : '▸'}
            </GhostButton>
          )}
        </span>
      </div>
      {expanded && body !== '' && (
        <p className="whitespace-pre-wrap border-t border-dashed border-border-primary pt-2 text-[11px] leading-relaxed text-text-secondary">
          {body}
        </p>
      )}
    </div>
  );
}

function ActionItemRow({
  item,
  projectName,
  nowMs,
  onResolved,
}: {
  item: ReviewItem;
  projectName: string | null;
  nowMs: number;
  onResolved: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const { resolve, pendingItemId } = useReviewItemActions();
  const hasBody = item.body !== null && item.body !== '';
  const busy = pendingItemId === item.id;

  const markDone = (): void => {
    void resolve(item.project_id, item.id).then((result) => {
      if (result !== null) onResolved();
    });
  };

  return (
    <div className={`${ROW_CHROME} border-border-primary`}>
      <div className="flex items-center gap-2">
        <span className="eyebrow shrink-0 text-status-info">Action</span>
        <span className="min-w-0 truncate text-[12.5px] font-bold text-text-primary" title={item.title}>
          {item.title}
        </span>
        {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
        <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">
          {compactAge(item.created_at, nowMs)}
        </span>
      </div>
      <div className="flex items-center gap-2.5 text-[11px]">
        {hasBody && !expanded && (
          <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.body ?? undefined}>
            {item.body}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {hasBody && (
            <GhostButton className="text-[11px]" onClick={() => setExpanded((v) => !v)}>
              Details {expanded ? '▾' : '▸'}
            </GhostButton>
          )}
          <SecondaryButton onClick={markDone} disabled={busy}>
            {busy ? 'Marking…' : 'Mark done'}
          </SecondaryButton>
        </span>
      </div>
      {expanded && hasBody && (
        <p className="whitespace-pre-wrap border-t border-dashed border-border-primary pt-2 text-[11px] leading-relaxed text-text-secondary">
          {item.body}
        </p>
      )}
    </div>
  );
}

const MODE_LABEL: Record<HumanTaskSessionMode, string> = {
  verify: 'Verify complete',
  help: 'Help me with it',
};

export interface HumanTasksSectionProps {
  /** Pending backlog human tasks (selectPendingHumanTasks). */
  tasks: BacklogTaskItem[];
  /** `<projectId>:<ref>` → refs of the tasks waiting on that human task. */
  dependentsByHumanRef: ReadonlyMap<string, string[]>;
  /** Every board — for each task's Done stage. */
  boards: readonly Board[];
  /** Loose `human_task` review items not tied to a backlog task. */
  actionItems: ReviewItem[];
  projectNameById: Record<number, string>;
  nowMs: number;
  /** Called after a successful resolve so the page can re-derive its counts. */
  onResolved: () => void;
}

/** HumanTasksSection — see {@link HumanTasksSectionProps}. */
export function HumanTasksSection({
  tasks,
  dependentsByHumanRef,
  boards,
  actionItems,
  projectNameById,
  nowMs,
  onResolved,
}: HumanTasksSectionProps): React.JSX.Element | null {
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [marking, setMarking] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // Set when Verify / Help was asked of a selection spanning several projects.
  const [crossProjectMode, setCrossProjectMode] = React.useState<HumanTaskSessionMode | null>(null);

  const { startWithKickoff, isStarting, error: startError } = useQuickSession({
    projectId: null,
    onSuccess: () => useNavigationStore.getState().goToSession(),
  });

  // A task that left the list (completed elsewhere) drops out of the selection.
  const selected = React.useMemo(() => tasks.filter((t) => selectedIds.has(t.id)), [tasks, selectedIds]);
  const selectedByProject = React.useMemo(() => {
    const map = new Map<number, BacklogTaskItem[]>();
    for (const task of selected) map.set(task.project_id, [...(map.get(task.project_id) ?? []), task]);
    return map;
  }, [selected]);

  if (tasks.length === 0 && actionItems.length === 0) return null;

  const allSelected = tasks.length > 0 && selected.length === tasks.length;
  const busy = marking || isStarting;
  const showProject = new Set(tasks.map((t) => t.project_id)).size > 1;

  const toggle = (id: string): void => {
    setCrossProjectMode(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (): void => {
    setCrossProjectMode(null);
    setSelectedIds(allSelected ? new Set() : new Set(tasks.map((t) => t.id)));
  };

  const markComplete = async (): Promise<void> => {
    setActionError(null);
    setMarking(true);
    const failed: string[] = [];
    for (const task of selected) {
      const stageId = findDoneStageId(boards, task.board_id);
      try {
        if (stageId === null) throw new Error('no Done stage');
        await trpc.cyboflow.tasks.setStage.mutate({
          projectId: task.project_id,
          taskId: task.id,
          stageId,
          expectedVersion: task.version,
        });
      } catch {
        failed.push(task.ref);
      }
    }
    setMarking(false);
    setSelectedIds(new Set());
    if (failed.length > 0) setActionError(`Could not mark ${failed.join(', ')} complete.`);
    onResolved();
  };

  const launch = (mode: HumanTaskSessionMode, projectTasks: readonly BacklogTaskItem[]): void => {
    setActionError(null);
    setCrossProjectMode(null);
    const projectId = projectTasks[0]?.project_id;
    if (projectId === undefined) return;
    useNavigationStore.getState().setActiveProjectId(projectId);
    void startWithKickoff({
      projectId,
      kickoffPrompt: buildHumanTaskKickoff(mode, projectTasks, boards),
      // In place: human tasks are about local state (.env files, logins) a
      // fresh worktree would not have.
      worktreeMode: 'in-place',
    });
  };

  const requestSession = (mode: HumanTaskSessionMode): void => {
    if (selectedByProject.size > 1) {
      setCrossProjectMode(mode);
      return;
    }
    launch(mode, selected);
  };

  const errorText = actionError ?? startError;
  const noSelection = selected.length === 0;

  return (
    <section data-testid="rq-human-tasks-section" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionHeader dotClass="bg-status-info" title="Human tasks" count={tasks.length + actionItems.length} />
        {tasks.length > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-text-tertiary">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-3 w-3 accent-[var(--color-interactive-primary)]"
                aria-label="Select all human tasks"
              />
              {noSelection ? 'Select all' : `${selected.length} selected`}
            </label>
            <SecondaryButton
              data-testid="rq-human-tasks-mark-complete"
              disabled={noSelection || busy}
              onClick={() => void markComplete()}
            >
              {marking ? 'Marking…' : 'Mark complete'}
            </SecondaryButton>
            <SecondaryButton
              data-testid="rq-human-tasks-verify"
              disabled={noSelection || busy}
              title="Open a session that checks the selected tasks are really done"
              onClick={() => requestSession('verify')}
            >
              {MODE_LABEL.verify}
            </SecondaryButton>
            <PrimaryButton
              data-testid="rq-human-tasks-help"
              disabled={noSelection || busy}
              title="Open a session that walks you through the selected tasks"
              onClick={() => requestSession('help')}
            >
              {isStarting ? 'Opening…' : MODE_LABEL.help}
            </PrimaryButton>
          </span>
        )}
      </div>

      {crossProjectMode !== null && (
        <div
          data-testid="rq-human-tasks-cross-project"
          className="flex flex-wrap items-center gap-2 border border-status-warning bg-surface-raised px-3.5 py-2.5 text-[11px] text-text-secondary"
        >
          <span className="min-w-0 flex-1">
            {MODE_LABEL[crossProjectMode]} opens one session in a single project, and your selection spans{' '}
            {selectedByProject.size} projects. Select tasks from one project:
          </span>
          {[...selectedByProject.entries()].map(([projectId, projectTasks]) => (
            <SecondaryButton
              key={projectId}
              onClick={() => {
                setSelectedIds(new Set(projectTasks.map((t) => t.id)));
                launch(crossProjectMode, projectTasks);
              }}
            >
              {projectNameById[projectId] ?? `Project ${projectId}`} ({projectTasks.length})
            </SecondaryButton>
          ))}
          <GhostButton className="text-[11px]" onClick={() => setCrossProjectMode(null)}>
            Cancel
          </GhostButton>
        </div>
      )}

      {errorText !== null && (
        <p role="alert" className="text-[11px] text-status-error">
          {errorText}
        </p>
      )}

      {tasks.map((task) => (
        <HumanBacklogTaskRow
          key={task.id}
          task={task}
          checked={selectedIds.has(task.id)}
          onToggle={() => toggle(task.id)}
          projectName={showProject ? (projectNameById[task.project_id] ?? null) : null}
          dependents={dependentsByHumanRef.get(`${task.project_id}:${task.ref}`) ?? []}
        />
      ))}
      {actionItems.map((item) => (
        <ActionItemRow
          key={item.id}
          item={item}
          projectName={projectNameById[item.project_id] ?? null}
          nowMs={nowMs}
          onResolved={onResolved}
        />
      ))}
    </section>
  );
}
