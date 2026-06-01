/**
 * NewTaskDialog — the "+ New" affordance. Creates a task (idea / epic / task)
 * via `cyboflow.tasks.create`, which routes through the applyChange chokepoint
 * (actor:'user') in the main process. The created task lands at the `idea` stage
 * (the chokepoint's create default) and arrives in the store via the
 * onTaskChanged subscription — no optimistic insert needed here.
 *
 * Uses the shared Modal primitives so it matches the rest of the app shell.
 */
import { useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import type { Priority, TaskType } from '../../../../shared/types/tasks';

interface NewTaskDialogProps {
  isOpen: boolean;
  projectId: number;
  onClose: () => void;
  /** Called after a successful create (with the new task id). */
  onCreated?: (taskId: string) => void;
}

const TYPES: TaskType[] = ['idea', 'epic', 'task'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2'];

export function NewTaskDialog({ isOpen, projectId, onClose, onCreated }: NewTaskDialogProps): React.JSX.Element {
  const [type, setType] = useState<TaskType>('idea');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setType('idea');
    setTitle('');
    setSummary('');
    setPriority('P2');
    setError(null);
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  const handleSubmit = async (): Promise<void> => {
    if (title.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tasks.create.mutate({
        projectId,
        type,
        title: title.trim(),
        summary: summary.trim().length > 0 ? summary.trim() : null,
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
              rows={3}
              placeholder="Optional — a sentence or two of context"
              className="resize-none rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Task summary"
            />
          </label>

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
          disabled={title.trim().length === 0 || submitting}
          data-testid="new-task-submit"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
