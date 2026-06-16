/**
 * IdeaDetailEditor — modal editor for an `idea` entity.
 *
 * Opened from the dedicated Edit affordance on an idea card (NOT a full-card
 * click). Edits the idea's title / summary / scope hint and its single markdown
 * `body` column, saving through `cyboflow.tasks.update` — which funnels into the
 * TaskChangeRouter.applyChange chokepoint (actor:'user'). The updated row arrives
 * back in the backlogStore via the onTaskChanged subscription; no optimistic
 * write here.
 *
 * The body field is a plain textarea with a Write / Preview toggle (the preview
 * reuses the shared MarkdownPreview component). `expectedVersion` drives the
 * chokepoint's optimistic-concurrency guard so a stale edit surfaces as a
 * concurrency conflict rather than silently clobbering a newer write.
 *
 * Uses the shared Modal primitives so it matches the rest of the app shell.
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { MarkdownPreview } from './MarkdownPreview';
import { IdeaAttachmentStrip } from './cyboflow/IdeaAttachmentStrip';
import { useIdeaAttachments } from '../hooks/useIdeaAttachments';
import { trpc } from '../trpc/client';
import type { BacklogTaskItem, IdeaAttachment, IdeaScope } from '../../../shared/types/tasks';

interface IdeaDetailEditorProps {
  /** The idea being edited (its current field values seed the form). */
  idea: BacklogTaskItem;
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful save (with the idea id). */
  onSaved?: (taskId: string) => void;
}

/** The scope-hint options; `null` means "unset". */
const SCOPE_OPTIONS: Array<{ value: IdeaScope | ''; label: string }> = [
  { value: '', label: 'Unset' },
  { value: 'small', label: 'Small (skip epics)' },
  { value: 'large', label: 'Large (extract epics)' },
];

export function IdeaDetailEditor({ idea, isOpen, onClose, onSaved }: IdeaDetailEditorProps): React.JSX.Element {
  const [title, setTitle] = useState(idea.title);
  const [summary, setSummary] = useState(idea.summary ?? '');
  const [scope, setScope] = useState<IdeaScope | ''>(idea.scope ?? '');
  const [body, setBody] = useState(idea.body ?? '');
  const [bodyMode, setBodyMode] = useState<'write' | 'preview'>('write');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Attachments live in their own column and are NOT on the BacklogTaskItem read
  // model — fetch them when the editor opens and feed the attachment hook.
  const [initialAttachments, setInitialAttachments] = useState<IdeaAttachment[]>([]);
  // Guards the save from clobbering existing attachments with [] before the
  // fetch above resolves: attachments are only included in the update once loaded
  // (undefined = "no change" at the chokepoint, so existing ones are preserved).
  const [attachmentsLoaded, setAttachmentsLoaded] = useState(false);
  const attachmentsCtl = useIdeaAttachments(idea.id, initialAttachments);

  // Reseed the form whenever a different idea (or a new version of it) opens.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(idea.title);
    setSummary(idea.summary ?? '');
    setScope(idea.scope ?? '');
    setBody(idea.body ?? '');
    setBodyMode('write');
    setError(null);
    setAttachmentsLoaded(false);
    let cancelled = false;
    trpc.cyboflow.tasks.getAttachments
      .query({ ideaId: idea.id })
      .then((rows) => {
        if (!cancelled) setInitialAttachments(rows);
      })
      .catch(() => {
        if (!cancelled) setInitialAttachments([]);
      })
      .finally(() => {
        if (!cancelled) setAttachmentsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, idea.id, idea.version, idea.title, idea.summary, idea.scope, idea.body]);

  const handleSubmit = async (): Promise<void> => {
    if (title.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tasks.update.mutate({
        projectId: idea.project_id,
        taskId: idea.id,
        title: title.trim(),
        summary: summary.trim().length > 0 ? summary.trim() : null,
        body: body.length > 0 ? body : null,
        scope: scope === '' ? null : scope,
        // Only send attachments once loaded — otherwise omit (preserve existing).
        ...(attachmentsLoaded ? { attachments: attachmentsCtl.attachments } : {}),
        expectedVersion: idea.version,
      });
      onSaved?.(result.taskId);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save idea');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" className="idea-detail-editor">
      <ModalHeader>Edit idea · {idea.ref}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3" data-testid="idea-detail-editor">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Idea title"
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
              aria-label="Idea summary"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Scope hint
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as IdeaScope | '')}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Idea scope"
            >
              {SCOPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
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
                onPaste={attachmentsCtl.handlePaste}
                onDrop={attachmentsCtl.handleDrop}
                onDragOver={(e) => e.preventDefault()}
                rows={10}
                placeholder="# Idea&#10;&#10;Markdown body — the full spec / notes for this idea.&#10;Paste or drop an image to attach it."
                className="resize-y rounded-input border border-border-primary bg-input-bg px-2 py-1.5 font-mono text-sm text-input-text placeholder:text-input-placeholder"
                aria-label="Idea body"
                data-testid="idea-body-input"
              />
            ) : (
              <div
                className="min-h-[160px] rounded-input border border-border-primary bg-bg-primary px-3 py-2 text-sm"
                data-testid="idea-body-preview"
              >
                {body.length > 0 ? (
                  <MarkdownPreview content={body} />
                ) : (
                  <span className="text-text-muted">Nothing to preview.</span>
                )}
              </div>
            )}
          </div>

          <IdeaAttachmentStrip
            previews={attachmentsCtl.previews}
            busy={attachmentsCtl.busy}
            error={attachmentsCtl.error}
            onAddFiles={(files) => void attachmentsCtl.addFiles(files)}
            onRemove={attachmentsCtl.remove}
          />

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
          data-testid="idea-detail-save"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
