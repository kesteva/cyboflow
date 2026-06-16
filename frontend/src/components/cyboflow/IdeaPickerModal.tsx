/**
 * IdeaPickerModal — the pre-launch idea-selection gate for the Planner flow
 * (migration 017, Piece A). Before a Planner run starts, the user either:
 *   - picks an existing backlog idea (cyboflow.tasks.list, filtered client-side
 *     to type==='idea' && !isDone), or
 *   - types a brand-new idea (cyboflow.tasks.create with type:'idea' + body),
 * and the chosen/minted idea id is handed back via onPicked. WorkflowPicker then
 * threads it into runs.start.mutate({ ideaId }) so RunExecutor.getPrompt can
 * inject the idea body as a `# Selected idea` block.
 *
 * Mirrors NewTaskDialog: shared Modal primitives, inline error state, and a
 * submit latch (the `submitting` guard) so a double-click can't double-create.
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { IdeaAttachmentStrip } from './IdeaAttachmentStrip';
import { useIdeaAttachments } from '../../hooks/useIdeaAttachments';
import { trpc } from '../../trpc/client';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

/** Empty seed for the create-form attachment hook (stable reference). */
const NO_ATTACHMENTS: never[] = [];

interface IdeaPickerModalProps {
  isOpen: boolean;
  projectId: number;
  onClose: () => void;
  /** Called with the chosen (existing) or minted (free-text) idea id. */
  onPicked: (ideaId: string) => void;
}

type Mode = 'pick' | 'new';

export function IdeaPickerModal({ isOpen, projectId, onClose, onPicked }: IdeaPickerModalProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('pick');
  const [ideas, setIdeas] = useState<BacklogTaskItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The idea has no id yet, so attachments are saved under a stable pending key;
  // the resulting file paths are persisted with the create mutation.
  const [pendingKey] = useState(() => `pending_${Math.random().toString(36).slice(2)}`);
  const attachmentsCtl = useIdeaAttachments(pendingKey, NO_ATTACHMENTS);

  // Load the project's ideas whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setIsLoading(true);
    setError(null);
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        // The list returns ALL entities; `type` is a synthesized discriminator.
        // Filter to open, NON-archived ideas only (archive-in-place, migration
        // 024) — Sprint operates on decomposed tasks, so an idea that is
        // done/decomposed/archived is not a valid planner seed.
        const openIdeas = rows.filter(
          (r) => r.type === 'idea' && !r.isDone && r.archived_at === null,
        );
        setIdeas(openIdeas);
        setSelectedId((prev) => {
          if (prev !== null && openIdeas.some((i) => i.id === prev)) return prev;
          return openIdeas.length > 0 ? openIdeas[0].id : null;
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load ideas');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen, projectId]);

  const reset = (): void => {
    setMode('pick');
    setTitle('');
    setBody('');
    setError(null);
    setSubmitting(false);
    attachmentsCtl.reset();
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  const handlePickExisting = (): void => {
    if (selectedId === null || submitting) return;
    onPicked(selectedId);
    reset();
  };

  const handleCreateNew = async (): Promise<void> => {
    if (title.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tasks.create.mutate({
        projectId,
        type: 'idea',
        title: title.trim(),
        // The free-text prose lands in the injectable `body` column so the
        // planner's `# Selected idea` block carries the user's intent.
        body: body.trim().length > 0 ? body.trim() : null,
        attachments: attachmentsCtl.attachments,
        priority: 'P2',
      });
      onPicked(result.taskId);
      reset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create idea');
      setSubmitting(false);
    }
  };

  const canSubmit = mode === 'pick' ? selectedId !== null : title.trim().length > 0;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>Select an idea for the planner</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {/* Mode toggle */}
          <div className="flex gap-2" role="tablist" aria-label="Idea source">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'pick'}
              onClick={() => {
                setMode('pick');
                setError(null);
              }}
              data-testid="idea-picker-mode-pick"
              className={`flex-1 rounded-button px-3 py-1.5 text-sm font-medium ${
                mode === 'pick'
                  ? 'bg-interactive text-text-on-interactive'
                  : 'border border-border-primary bg-bg-primary text-text-primary hover:bg-bg-hover'
              }`}
            >
              Pick existing
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'new'}
              onClick={() => {
                setMode('new');
                setError(null);
              }}
              data-testid="idea-picker-mode-new"
              className={`flex-1 rounded-button px-3 py-1.5 text-sm font-medium ${
                mode === 'new'
                  ? 'bg-interactive text-text-on-interactive'
                  : 'border border-border-primary bg-bg-primary text-text-primary hover:bg-bg-hover'
              }`}
            >
              New idea
            </button>
          </div>

          {mode === 'pick' && (
            <>
              {isLoading && <p className="text-xs text-text-secondary">Loading ideas…</p>}
              {!isLoading && ideas.length === 0 && (
                <p className="text-xs text-text-secondary">
                  No open ideas in the backlog. Switch to “New idea” to describe one.
                </p>
              )}
              {!isLoading && ideas.length > 0 && (
                <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                  Idea
                  <select
                    value={selectedId ?? ''}
                    onChange={(e) => setSelectedId(e.target.value)}
                    className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                    aria-label="Select idea"
                  >
                    {ideas.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.ref} — {i.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}

          {mode === 'new' && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                Title
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What's the idea?"
                  className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
                  aria-label="Idea title"
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                Body
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onPaste={attachmentsCtl.handlePaste}
                  onDrop={attachmentsCtl.handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  rows={5}
                  placeholder="Describe the idea — the planner refines this into a spec, epics, and tasks. Paste or drop an image to attach it."
                  className="resize-none rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
                  aria-label="Idea body"
                />
              </label>
              <IdeaAttachmentStrip
                previews={attachmentsCtl.previews}
                busy={attachmentsCtl.busy}
                error={attachmentsCtl.error}
                onAddFiles={(files) => void attachmentsCtl.addFiles(files)}
                onRemove={attachmentsCtl.remove}
              />
            </>
          )}

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
          onClick={() => {
            if (mode === 'pick') handlePickExisting();
            else void handleCreateNew();
          }}
          disabled={!canSubmit || submitting}
          data-testid="idea-picker-submit"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating…' : mode === 'pick' ? 'Use idea' : 'Create & use'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
