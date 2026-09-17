/**
 * TaskDetailModal — full-detail overlay for a single backlog task.
 *
 * Opened from a clickable task card in the 'decomposed-stories' artifact body
 * (ArtifactTabRenderer → TaskGrid) AND from the "open root idea" back-link on an
 * epic/task card (Backlog/TaskCard). It shows the task's ref, title, priority,
 * and one-line summary in a warm-paper header, then renders the full markdown
 * `body` via the app's MarkdownPreview (react-markdown — never raw HTML). When
 * the body is null/empty it shows a graceful "No additional detail" state.
 *
 * Idea decomposition + internal navigation: when an IDEA opens, its spawned
 * children (epics + direct tasks, nested under `idea.children` by
 * selectIdeaDecomposition) are listed under a "Decomposed into" section so a
 * decomposed idea — off the board, reachable only via its children — stays
 * inspectable. Clicking a child drills into that child's detail within the same
 * modal (a back-link returns to the idea). `active` tracks the entity currently
 * shown and resets to the prop `task` whenever a new task opens.
 *
 * It wraps the shared ui/Modal (portal to document.body, Escape + overlay-click
 * close, body-scroll lock). The inline hexes mirror the warm-paper palette used
 * across ArtifactTabRenderer (STORIES accent, hairlines, font sizes); the M7
 * polish pass tokenizes them.
 *
 * The category chip in the header doubles as an inline edit control (a plain
 * `<select>`, no separate save step) — it saves through `cyboflow.tasks.update`
 * on change, the same chokepoint path as {@link EpicDetailEditor} /
 * {@link IdeaDetailEditor}'s form fields. `expectedVersion` guards against a
 * stale concurrent edit; on success the local `active` entity is patched with
 * the new category + bumped version so the chip reflects the save without
 * waiting on a store round-trip.
 *
 * The EXECUTOR chip beside it (migration 137) mirrors that pattern exactly —
 * same select shape, same optimistic patch, same expectedVersion guard — and is
 * rendered for TASKS only, because only tasks execute and the chokepoint rejects
 * an executor on an idea/epic.
 *
 * Dependencies are listed below the body with a Remove affordance per row,
 * calling `cyboflow.tasks.removeDependency`. There is deliberately no MCP
 * counterpart for that mutation: cutting a prerequisite is a human judgment, not
 * something an agent should be able to do to unblock itself.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Modal } from '../ui/Modal';
import { MarkdownPreview } from '../MarkdownPreview';
import { trpc } from '../../trpc/client';
import { CATEGORY_LABEL } from '../Backlog/markers';
import { DesignAffordance } from './DesignAffordance';
import type { BacklogTaskItem, EntityCategory, TaskExecutor } from '../../../../shared/types/tasks';
import { TASK_EXECUTORS } from '../../../../shared/types/tasks';

const CATEGORIES: EntityCategory[] = ['feature', 'bug', 'chore'];

const EXECUTOR_LABEL: Record<TaskExecutor, string> = {
  agent: 'Agent',
  human: 'Human',
};

const HAIRLINE = 'var(--color-border-primary)';
const SOFT = 'var(--color-border-tertiary)';
const FAINT = 'var(--color-text-tertiary)';
const MUTED = 'var(--color-text-secondary)';
const INK = 'var(--color-text-primary)';
const STORIES = 'var(--color-phase-refine)';

interface TaskDetailModalProps {
  /** The task to detail, or null when the modal is closed. */
  task: BacklogTaskItem | null;
  onClose: () => void;
}

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps): ReactElement | null {
  // Internal navigation: the entity currently shown. It seeds from the prop
  // `task` and resets whenever a different task opens (or the modal closes), so
  // drilling into an idea's child never leaks across opens.
  const [active, setActive] = useState<BacklogTaskItem | null>(task);
  useEffect(() => {
    setActive(task);
  }, [task]);
  const [savingCategory, setSavingCategory] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [savingExecutor, setSavingExecutor] = useState(false);
  const [executorError, setExecutorError] = useState<string | null>(null);
  /** The prerequisite id currently being removed — disables just that row. */
  const [removingDepId, setRemovingDepId] = useState<string | null>(null);
  const [dependencyError, setDependencyError] = useState<string | null>(null);

  if (!task || !active) return null;

  const handleCategoryChange = async (next: EntityCategory): Promise<void> => {
    if (next === active.category || savingCategory) return;
    setSavingCategory(true);
    setCategoryError(null);
    try {
      await trpc.cyboflow.tasks.update.mutate({
        projectId: active.project_id,
        taskId: active.id,
        category: next,
        expectedVersion: active.version,
      });
      setActive({ ...active, category: next, version: active.version + 1 });
    } catch (err: unknown) {
      setCategoryError(err instanceof Error ? err.message : 'Failed to save category');
    } finally {
      setSavingCategory(false);
    }
  };

  const handleExecutorChange = async (next: TaskExecutor): Promise<void> => {
    if (next === active.executor || savingExecutor) return;
    setSavingExecutor(true);
    setExecutorError(null);
    try {
      await trpc.cyboflow.tasks.update.mutate({
        projectId: active.project_id,
        taskId: active.id,
        executor: next,
        expectedVersion: active.version,
      });
      setActive({ ...active, executor: next, version: active.version + 1 });
    } catch (err: unknown) {
      setExecutorError(err instanceof Error ? err.message : 'Failed to save executor');
    } finally {
      setSavingExecutor(false);
    }
  };

  const handleRemoveDependency = async (dependsOnTaskId: string): Promise<void> => {
    if (removingDepId !== null) return;
    setRemovingDepId(dependsOnTaskId);
    setDependencyError(null);
    try {
      await trpc.cyboflow.tasks.removeDependency.mutate({
        projectId: active.project_id,
        taskId: active.id,
        dependsOnTaskId,
      });
      // Optimistic: drop the row locally (and its waits-on-human entry, if any)
      // so the list reflects the cut without waiting on a store round-trip.
      const removed = (active.blockedBy ?? []).find((d) => d.taskId === dependsOnTaskId);
      setActive({
        ...active,
        blockedBy: (active.blockedBy ?? []).filter((d) => d.taskId !== dependsOnTaskId),
        waitingOnHuman: (active.waitingOnHuman ?? []).filter((ref) => ref !== removed?.ref),
      });
    } catch (err: unknown) {
      setDependencyError(err instanceof Error ? err.message : 'Failed to remove dependency');
    } finally {
      setRemovingDepId(null);
    }
  };

  const body = active.body?.trim() ?? '';
  const blockedBy = active.blockedBy ?? [];
  const waitingOnHuman = new Set(active.waitingOnHuman ?? []);
  // A decomposed idea is OFF the board but stays navigable: list its spawned
  // epics + direct tasks (selectIdeaDecomposition nests both under
  // idea.children). Only ideas carry this list — epics/tasks render plainly.
  const decompositionChildren = active.type === 'idea' ? active.children ?? [] : [];
  // True once the user has drilled from the originating idea into one of its
  // children — surfaces a back-link to return to the idea.
  const drilledIntoChild = active.id !== task.id;

  return (
    <Modal isOpen onClose={onClose} size="lg" showCloseButton>
      <div data-testid="task-detail-modal" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Back-link — only while drilled into a child of the originating idea. */}
        {drilledIntoChild && (
          <button
            type="button"
            onClick={() => setActive(task)}
            data-testid="task-detail-back"
            style={{
              alignSelf: 'flex-start',
              margin: '14px 24px 0',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              color: MUTED,
            }}
          >
            ← Back to {task.ref}
          </button>
        )}

        {/* Header — ref + priority chip, then title + summary. */}
        <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${HAIRLINE}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: STORIES, letterSpacing: '.04em' }}>
              {active.ref}
            </span>
            {active.priority && (
              <span
                data-testid="task-detail-priority"
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  color: FAINT,
                  border: `1px solid ${SOFT}`,
                  borderRadius: 2,
                  padding: '1px 5px',
                }}
              >
                {active.priority}
              </span>
            )}
            <select
              value={active.category}
              onChange={(e) => void handleCategoryChange(e.target.value as EntityCategory)}
              disabled={savingCategory}
              data-testid="task-detail-category"
              aria-label="Task category"
              style={{
                fontSize: '9px',
                fontWeight: 700,
                color: FAINT,
                border: `1px solid ${SOFT}`,
                borderRadius: 2,
                padding: '1px 4px',
                background: 'var(--color-bg-primary)',
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            {/* Executor chip (migration 137) — TASKS only: only tasks execute,
                and the chokepoint rejects an executor on an idea/epic. */}
            {active.type === 'task' && (
              <select
                value={active.executor}
                onChange={(e) => void handleExecutorChange(e.target.value as TaskExecutor)}
                disabled={savingExecutor}
                data-testid="task-detail-executor"
                aria-label="Task executor"
                title="Who performs this task. A human task never runs in a sprint."
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  color: FAINT,
                  border: `1px solid ${SOFT}`,
                  borderRadius: 2,
                  padding: '1px 4px',
                  background: 'var(--color-bg-primary)',
                }}
              >
                {TASK_EXECUTORS.map((x) => (
                  <option key={x} value={x}>
                    {EXECUTOR_LABEL[x]}
                  </option>
                ))}
              </select>
            )}
            {/* Design affordance — opens the approved design bound to this
                entity's originating idea (idea -> itself; epic/task -> its
                idea). No sessionKey: this modal has no running-session
                context, so it opens its own preview modal. */}
            <span style={{ marginLeft: 'auto' }}>
              <DesignAffordance entityId={active.id} projectId={active.project_id} />
            </span>
          </div>
          {categoryError && (
            <p role="alert" style={{ fontSize: '10px', color: 'var(--color-status-error)', margin: '0 0 6px' }}>
              {categoryError}
            </p>
          )}
          {executorError && (
            <p role="alert" style={{ fontSize: '10px', color: 'var(--color-status-error)', margin: '0 0 6px' }}>
              {executorError}
            </p>
          )}
          <h2
            data-testid="task-detail-title"
            style={{ fontSize: '18px', fontWeight: 700, lineHeight: 1.3, color: INK, margin: 0 }}
          >
            {active.title}
          </h2>
          {active.summary && (
            <div data-testid="task-detail-summary" style={{ fontSize: '12px', color: MUTED, marginTop: 6, lineHeight: 1.45 }}>
              {active.summary}
            </div>
          )}
        </div>

        {/* Body — full markdown, or a graceful empty state. */}
        <div data-testid="task-detail-body" style={{ padding: '16px 24px 24px', overflow: 'auto' }}>
          {body ? (
            <MarkdownPreview content={body} />
          ) : (
            <div
              data-testid="task-detail-nobody"
              style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}
            >
              No additional detail.
            </div>
          )}
        </div>

        {/* Blocking prerequisites, each removable. A prerequisite that is itself
            a HUMAN task (migration 137) is labelled and reads as neutral: the
            edge is real, but it never gates this task, so it must not look like
            a blocked state. */}
        {blockedBy.length > 0 && (
          <div
            data-testid="task-detail-dependencies"
            style={{ padding: '14px 24px 18px', borderTop: `1px solid ${HAIRLINE}` }}
          >
            <div style={{ fontSize: '9px', fontWeight: 700, color: FAINT, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 10 }}>
              Depends on
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {blockedBy.map((dep) => (
                <li
                  key={dep.taskId}
                  data-testid={`task-detail-dependency-${dep.taskId}`}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    border: `1px solid ${SOFT}`,
                    borderRadius: 4,
                    padding: '7px 10px',
                  }}
                >
                  <span style={{ fontSize: '9px', fontWeight: 700, color: STORIES, letterSpacing: '.04em', flexShrink: 0 }}>
                    {dep.ref}
                  </span>
                  <span style={{ fontSize: '12px', color: INK, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {dep.title}
                  </span>
                  {waitingOnHuman.has(dep.ref) && (
                    <span
                      data-testid={`task-detail-dependency-human-${dep.taskId}`}
                      style={{ fontSize: '10px', color: FAINT, flexShrink: 0 }}
                    >
                      human · does not block
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleRemoveDependency(dep.taskId)}
                    disabled={removingDepId !== null}
                    data-testid={`task-detail-dependency-remove-${dep.taskId}`}
                    aria-label={`Remove dependency on ${dep.ref}`}
                    style={{
                      marginLeft: 'auto',
                      flexShrink: 0,
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: removingDepId !== null ? 'not-allowed' : 'pointer',
                      fontSize: '10px',
                      fontWeight: 600,
                      color: MUTED,
                    }}
                  >
                    {removingDepId === dep.taskId ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
            {dependencyError && (
              <p role="alert" style={{ fontSize: '10px', color: 'var(--color-status-error)', margin: '8px 0 0' }}>
                {dependencyError}
              </p>
            )}
          </div>
        )}

        {/* Decomposition children (idea only) — the idea's spawned epics + direct
            tasks, each a button that drills into its detail in this modal. */}
        {decompositionChildren.length > 0 && (
          <div
            data-testid="task-detail-children"
            style={{ padding: '14px 24px 22px', borderTop: `1px solid ${HAIRLINE}` }}
          >
            <div style={{ fontSize: '9px', fontWeight: 700, color: FAINT, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 10 }}>
              Decomposed into
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {decompositionChildren.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => setActive(child)}
                    data-testid="task-detail-child"
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      background: 'none',
                      border: `1px solid ${SOFT}`,
                      borderRadius: 4,
                      padding: '7px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: '9px', fontWeight: 700, color: STORIES, letterSpacing: '.04em', flexShrink: 0 }}>
                      {child.ref}
                    </span>
                    <span style={{ fontSize: '8.5px', fontWeight: 700, color: FAINT, letterSpacing: '.05em', textTransform: 'uppercase', flexShrink: 0 }}>
                      {child.type}
                    </span>
                    <span style={{ fontSize: '12px', color: INK, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {child.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
