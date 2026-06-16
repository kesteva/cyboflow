/**
 * NewTaskDialog — the "+ New" affordance. Creates a task (idea / epic / task)
 * via `cyboflow.tasks.create`, which routes through the applyChange chokepoint
 * (actor:'user') in the main process. The created task lands at the `idea` stage
 * (the chokepoint's create default) and arrives in the store via the
 * onTaskChanged subscription — no optimistic insert needed here.
 *
 * The board is cross-project (All mode), so the dialog carries its own Project
 * select fed by the backlog store's `projects`. The selection defaults to the
 * board's active project filter, falling back to the `projectId` prop and then
 * to the first known project; the create mutation always sends the SELECTED
 * project id, never the prop directly.
 *
 * Uses the shared Modal primitives so it matches the rest of the app shell.
 */
import { useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { IdeaAttachmentStrip } from '../cyboflow/IdeaAttachmentStrip';
import { useIdeaAttachments } from '../../hooks/useIdeaAttachments';
import { trpc } from '../../trpc/client';
import { useBacklogStore } from '../../stores/backlogStore';
import type { IdeaAttachment, Priority, TaskType } from '../../../../shared/types/tasks';

/** Empty seed for the attachment hook (stable reference). */
const NO_ATTACHMENTS: IdeaAttachment[] = [];

interface NewTaskDialogProps {
  isOpen: boolean;
  /**
   * DEFAULT project for the Project select (NOT necessarily what gets created —
   * the user can re-pick). Used only when the board's project filter is "All";
   * null defers to the first known project.
   */
  projectId: number | null;
  onClose: () => void;
  /** Called after a successful create (with the new task id). */
  onCreated?: (taskId: string) => void;
}

const TYPES: TaskType[] = ['idea', 'epic', 'task'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2'];

export function NewTaskDialog({ isOpen, projectId, onClose, onCreated }: NewTaskDialogProps): React.JSX.Element {
  const projects = useBacklogStore((s) => s.projects);
  const filterProjectId = useBacklogStore((s) => s.filterProjectId);

  const [type, setType] = useState<TaskType>('idea');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  // null = "track the default" — the board's project filter, then the pane's
  // projectId prop, then the first known project. An explicit user pick pins
  // the override; reset() drops back to tracking.
  const [projectOverride, setProjectOverride] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Attachments (ideas only, migration 028). The item has no id yet, so images
  // save under a stable pending key; their paths ride the create mutation.
  const [pendingKey] = useState(() => `pending_${Math.random().toString(36).slice(2)}`);
  const attachmentsCtl = useIdeaAttachments(pendingKey, NO_ATTACHMENTS);

  const defaultProjectId = filterProjectId ?? projectId ?? projects[0]?.id ?? null;
  const selectedProjectId = projectOverride ?? defaultProjectId;

  const reset = (): void => {
    setType('idea');
    setTitle('');
    setSummary('');
    setPriority('P2');
    setProjectOverride(null);
    setError(null);
    attachmentsCtl.reset();
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  const handleSubmit = async (): Promise<void> => {
    if (title.trim().length === 0 || submitting || selectedProjectId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tasks.create.mutate({
        projectId: selectedProjectId,
        type,
        title: title.trim(),
        summary: summary.trim().length > 0 ? summary.trim() : null,
        // Attachments are ideas-only; the chokepoint ignores them otherwise.
        ...(type === 'idea' ? { attachments: attachmentsCtl.attachments } : {}),
        priority,
      });
      onCreated?.(result.taskId);
      reset();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>New backlog item</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Type
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TaskType)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Task type"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Project
            <select
              value={selectedProjectId ?? ''}
              onChange={(e) => setProjectOverride(Number(e.target.value))}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Task project"
              data-testid="new-task-project"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Task title"
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Summary
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onPaste={type === 'idea' ? attachmentsCtl.handlePaste : undefined}
              onDrop={type === 'idea' ? attachmentsCtl.handleDrop : undefined}
              onDragOver={type === 'idea' ? (e) => e.preventDefault() : undefined}
              rows={3}
              placeholder={
                type === 'idea'
                  ? 'Optional — a sentence or two of context. Paste or drop an image to attach it.'
                  : 'Optional — a sentence or two of context'
              }
              className="resize-none rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Task summary"
            />
          </label>

          {/* Attachments — ideas only (the only entity with an attachments column). */}
          {type === 'idea' && (
            <IdeaAttachmentStrip
              previews={attachmentsCtl.previews}
              busy={attachmentsCtl.busy}
              error={attachmentsCtl.error}
              onAddFiles={(files) => void attachmentsCtl.addFiles(files)}
              onRemove={attachmentsCtl.remove}
            />
          )}

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Task priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={title.trim().length === 0 || submitting || selectedProjectId === null}
          data-testid="new-task-submit"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
