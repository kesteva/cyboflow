/**
 * NewTaskDialog — the "+ New" affordance. Creates an IDEA via
 * `cyboflow.tasks.create`, which routes through the applyChange chokepoint
 * (actor:'user') in the main process. Everything hand-created is an idea by
 * design — epics and tasks are minted by the planner's decomposition, so the
 * dialog carries no Type picker. The created idea lands at the `idea` stage
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
import { useEffect, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { IdeaAttachmentStrip } from '../cyboflow/IdeaAttachmentStrip';
import { useIdeaAttachments } from '../../hooks/useIdeaAttachments';
import { trpc } from '../../trpc/client';
import { useBacklogStore } from '../../stores/backlogStore';
import { CATEGORY_LABEL } from './markers';
import {
  readDraft,
  writeDraft,
  clearDraft,
  isIdeaAttachmentArray,
  NEW_TASK_DIALOG_DRAFT_KEY,
} from '../../utils/ideaDraftStorage';
import type { EntityCategory, IdeaAttachment, IdeaScope, Priority } from '../../../../shared/types/tasks';

/** Empty seed for the attachment hook (stable reference). */
const NO_ATTACHMENTS: IdeaAttachment[] = [];

/** Persisted draft shape (localStorage) — only the fields that survive a close. */
interface NewTaskDialogDraft {
  title: string;
  body: string;
  pendingKey: string;
  attachments: IdeaAttachment[];
}

function isNewTaskDialogDraft(v: unknown): v is NewTaskDialogDraft {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Record<string, unknown>;
  return (
    typeof candidate.title === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.pendingKey === 'string' &&
    isIdeaAttachmentArray(candidate.attachments)
  );
}

function mintPendingKey(): string {
  return `pending_${Math.random().toString(36).slice(2)}`;
}

function serializeDraft(title: string, body: string, pendingKey: string, attachments: IdeaAttachment[]): string {
  return JSON.stringify({ title, body, pendingKey, attachments });
}

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

const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const CATEGORIES: EntityCategory[] = ['feature', 'bug', 'chore'];

export function NewTaskDialog({ isOpen, projectId, onClose, onCreated }: NewTaskDialogProps): React.JSX.Element {
  const projects = useBacklogStore((s) => s.projects);
  const filterProjectId = useBacklogStore((s) => s.filterProjectId);

  // Restored once on mount — a persisted draft from an earlier accidental close.
  // Corrupt/stale/shape-invalid data degrades to `null` (readDraft's contract).
  const [initialDraft] = useState<NewTaskDialogDraft | null>(() =>
    readDraft(NEW_TASK_DIALOG_DRAFT_KEY, isNewTaskDialogDraft),
  );

  const [title, setTitle] = useState(() => initialDraft?.title ?? '');
  const [summary, setSummary] = useState(() => initialDraft?.body ?? '');
  const [priority, setPriority] = useState<Priority>('P2');
  const [category, setCategory] = useState<EntityCategory>('feature');
  // Idea size hint (IDEA-009) — '' = unset, the planner's triage judges it.
  // A pre-stamped value feeds the picker's S/L badges + plan-separately split
  // and the planner's "trust existing scope" path. Ideas only. Not part of the
  // persisted draft shape — always defaults fresh, even on restore.
  const [scope, setScope] = useState<'' | IdeaScope>('');
  // null = "track the default" — the board's project filter, then the pane's
  // projectId prop, then the first known project. An explicit user pick pins
  // the override; reset() drops back to tracking. Not part of the persisted
  // draft shape.
  const [projectOverride, setProjectOverride] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Attachments (ideas only, migration 028). The item has no id yet, so files
  // save under a stable pending key; their paths ride the create mutation. A
  // restored draft reuses its pendingKey (so useIdeaAttachments re-hydrates the
  // SAME on-disk files) and seeds `initial` with the restored metadata.
  const [pendingKey, setPendingKey] = useState(() => initialDraft?.pendingKey ?? mintPendingKey());
  const attachmentsCtl = useIdeaAttachments(pendingKey, initialDraft?.attachments ?? NO_ATTACHMENTS);

  // Last-written serialized draft — guards the write effect below so it only
  // calls writeDraft on an actual content change, not on every render (the
  // attachments array is a fresh reference each render even when unchanged).
  // Seeded from THIS render's initial state so mounting on an unchanged
  // (or absent) draft doesn't immediately re-write it.
  const lastWrittenDraftRef = useRef<string>(
    serializeDraft(title, summary, pendingKey, attachmentsCtl.attachments),
  );

  useEffect(() => {
    const serialized = serializeDraft(title, summary, pendingKey, attachmentsCtl.attachments);
    if (serialized === lastWrittenDraftRef.current) return;
    lastWrittenDraftRef.current = serialized;
    writeDraft(NEW_TASK_DIALOG_DRAFT_KEY, {
      title,
      body: summary,
      pendingKey,
      attachments: attachmentsCtl.attachments,
    });
  }, [title, summary, pendingKey, attachmentsCtl.attachments]);

  const defaultProjectId = filterProjectId ?? projectId ?? projects[0]?.id ?? null;
  const selectedProjectId = projectOverride ?? defaultProjectId;

  // Clears in-memory fields for the next open and mints a fresh pendingKey (so
  // a later draft never reuses a just-submitted idea's attachment directory).
  // Returns the new pendingKey so the caller can pre-seed the write-effect ref.
  const reset = (): string => {
    const newPendingKey = mintPendingKey();
    setTitle('');
    setSummary('');
    setPriority('P2');
    setCategory('feature');
    setScope('');
    setProjectOverride(null);
    setError(null);
    attachmentsCtl.reset();
    setPendingKey(newPendingKey);
    return newPendingKey;
  };

  // Closing (overlay/Escape/X/Cancel) leaves field state as-is — it becomes the
  // persisted draft via the write effect above, so an accidental close no
  // longer wipes a typed-but-unsaved idea.
  const handleClose = (): void => {
    onClose();
  };

  const handleSubmit = async (): Promise<void> => {
    if (title.trim().length === 0 || submitting || selectedProjectId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tasks.create.mutate({
        projectId: selectedProjectId,
        type: 'idea',
        title: title.trim(),
        summary: summary.trim().length > 0 ? summary.trim() : null,
        attachments: attachmentsCtl.attachments,
        // Unset ('') size is omitted so the column stays NULL and the planner's
        // triage judges it.
        ...(scope !== '' ? { scope } : {}),
        priority,
        category,
      });
      onCreated?.(result.taskId);
      const newPendingKey = reset();
      clearDraft(NEW_TASK_DIALOG_DRAFT_KEY);
      // Pre-seed the ref to the post-reset (empty) state so the write effect's
      // next run — reacting to the reset() state updates above — sees no
      // change and doesn't immediately re-persist a blank draft.
      lastWrittenDraftRef.current = serializeDraft('', '', newPendingKey, []);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>New idea</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
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
              onPaste={attachmentsCtl.handlePaste}
              onDrop={attachmentsCtl.handleDrop}
              onDragOver={(e) => e.preventDefault()}
              rows={3}
              placeholder="Optional — a sentence or two of context. Paste or drop a file to attach it."
              className="resize-none rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Task summary"
            />
          </label>

          <IdeaAttachmentStrip
            previews={attachmentsCtl.previews}
            busy={attachmentsCtl.busy}
            error={attachmentsCtl.error}
            onAddFiles={(files) => void attachmentsCtl.addFiles(files)}
            onRemove={attachmentsCtl.remove}
          />

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

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as EntityCategory)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Task category"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </label>

          {/* Size hint (IDEA-009). Pre-stamping saves the planner's triage a
              judgment call and drives the multi-select picker's S/L badges +
              plan-separately split. */}
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Size
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as '' | IdeaScope)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Idea size"
              data-testid="new-task-scope"
            >
              <option value="">Let the planner judge</option>
              <option value="small">Small — fits a batch</option>
              <option value="large">Large — plan on its own</option>
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
