/**
 * EpicDetailEditor — modal editor for an `epic` entity (and reused for solo
 * `task` entities, whose editable surface — title / summary / priority / body —
 * is identical to an epic's). Mirror of {@link IdeaDetailEditor} minus the
 * idea-only scope hint.
 *
 * Opened from the dedicated Edit affordance on an epic / task card (NOT a
 * full-card click). Saves through `cyboflow.tasks.update` — which funnels into
 * the TaskChangeRouter.applyChange chokepoint (actor:'user'). The updated row
 * arrives back in the backlogStore via the onTaskChanged subscription; no
 * optimistic write here.
 *
 * Uses the shared Modal primitives so it matches the rest of the app shell.
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { MarkdownPreview } from './MarkdownPreview';
import { trpc } from '../trpc/client';
import type { BacklogTaskItem, Priority } from '../../../shared/types/tasks';

interface EpicDetailEditorProps {
  /** The epic (or solo task) being edited — its current field values seed the form. */
  epic: BacklogTaskItem;
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful save (with the entity id). */
  onSaved?: (taskId: string) => void;
}

const PRIORITIES: Priority[] = ['P0', 'P1', 'P2'];

export function EpicDetailEditor({ epic, isOpen, onClose, onSaved }: EpicDetailEditorProps): React.JSX.Element {
  const [title, setTitle] = useState(epic.title);
  const [summary, setSummary] = useState(epic.summary ?? '');
  const [priority, setPriority] = useState<Priority>(epic.priority);
  const [body, setBody] = useState(epic.body ?? '');
  const [bodyMode, setBodyMode] = useState<'write' | 'preview'>('write');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseed the form whenever a different epic (or a new version of it) opens.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(epic.title);
    setSummary(epic.summary ?? '');
    setPriority(epic.priority);
    setBody(epic.body ?? '');
    setBodyMode('write');
    setError(null);
  }, [isOpen, epic.id, epic.version, epic.title, epic.summary, epic.priority, epic.body]);

  const handleSubmit = async (): Promise<void> => {
    if (title.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tasks.update.mutate({
        projectId: epic.project_id,
        taskId: epic.id,
        title: title.trim(),
        summary: summary.trim().length > 0 ? summary.trim() : null,
        body: body.length > 0 ? body : null,
        priority,
        expectedVersion: epic.version,
      });
      onSaved?.(result.taskId);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save epic');
    } finally {
      setSubmitting(false);
    }
  };

  const entityLabel = epic.type === 'task' ? 'task' : 'epic';

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" className="epic-detail-editor">
      <ModalHeader>Edit {entityLabel} · {epic.ref}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3" data-testid="epic-detail-editor">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Epic title"
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Summary
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={2}
              placeholder="Optional — a sentence or two of context"
              className="resize-none rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Epic summary"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Epic priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">Body (markdown)</span>
              <div className="inline-flex overflow-hidden rounded-button border border-border-primary" role="group" aria-label="Body editor mode">
                <button
                  type="button"
                  onClick={() => setBodyMode('write')}
                  aria-pressed={bodyMode === 'write'}
                  data-testid="body-mode-write"
                  className={`px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                    bodyMode === 'write'
                      ? 'bg-interactive text-text-on-interactive'
                      : 'bg-bg-primary text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  Write
                </button>
                <button
                  type="button"
                  onClick={() => setBodyMode('preview')}
                  aria-pressed={bodyMode === 'preview'}
                  data-testid="body-mode-preview"
                  className={`px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                    bodyMode === 'preview'
                      ? 'bg-interactive text-text-on-interactive'
                      : 'bg-bg-primary text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  Preview
                </button>
              </div>
            </div>
            {bodyMode === 'write' ? (
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                placeholder="# Epic&#10;&#10;Markdown body — the grouped scope / notes for this epic."
                className="resize-y rounded-input border border-border-primary bg-input-bg px-2 py-1.5 font-mono text-sm text-input-text placeholder:text-input-placeholder"
                aria-label="Epic body"
                data-testid="epic-body-input"
              />
            ) : (
              <div
                className="min-h-[160px] rounded-input border border-border-primary bg-bg-primary px-3 py-2 text-sm"
                data-testid="epic-body-preview"
              >
                {body.length > 0 ? (
                  <MarkdownPreview content={body} />
                ) : (
                  <span className="text-text-muted">Nothing to preview.</span>
                )}
              </div>
            )}
          </div>

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
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={title.trim().length === 0 || submitting}
          data-testid="epic-detail-save"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
