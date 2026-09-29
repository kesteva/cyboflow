/**
 * AddIdeaModal — the landing page's simplified idea capture.
 *
 * Opened by the "Add an idea" affordances on the Human Review Queue (the
 * capture-first-idea card and the empty-backlog well), which only exist while
 * the backlog holds no ideas — so this deliberately asks ONE question ("what do
 * you want to get done?") instead of the full NewTaskDialog form. The single
 * input doubles as the idea's title (first sentence or line) and summary (the
 * rest); priority/category/size all take the create chokepoint's defaults.
 *
 * Two steps:
 *   1. capture — textarea, plus a project picker only when more than one
 *      project exists (one project needs no question);
 *   2. launch  — after a successful create, offer to launch a planner for the
 *      new idea now. "+ Add another idea" loops back to step 1 (keeping the
 *      project); dismissing is the X / overlay click — there is no "not now".
 */
import React from 'react';
import { Check } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { ADD_IDEA_MODAL_DRAFT_KEY, clearDraft, readDraft, writeDraft } from '../../utils/ideaDraftStorage';

/** The persisted shape of an in-progress AddIdeaModal capture. */
interface AddIdeaDraft {
  text: string;
  projectId: number | null;
}

function isAddIdeaDraft(v: unknown): v is AddIdeaDraft {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    (typeof candidate.projectId === 'number' || candidate.projectId === null)
  );
}

/** The slice of a project this modal needs (picker rows + the create call). */
export interface AddIdeaProjectRef {
  id: number;
  name: string;
}

export interface AddIdeaModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: AddIdeaProjectRef[];
  /**
   * Launch a Planner seeded with the idea just created. Awaited so the button
   * can show its in-flight state; the parent owns navigation/notification.
   */
  onLaunchPlanner: (ideaId: string, projectId: number) => Promise<unknown>;
}

/**
 * Split the free-text capture into title + summary: the first sentence (or
 * first line, whichever breaks sooner) becomes the title, the remainder the
 * summary. A single-sentence capture is all title, NULL summary.
 */
export function splitIdeaText(raw: string): { title: string; summary: string | null } {
  const text = raw.trim();
  const lineBreak = text.search(/\n/);
  const sentence = text.match(/^[\s\S]*?[.!?](?=\s)/);
  const sentenceEnd = sentence === null ? -1 : sentence[0].length;
  const cut =
    lineBreak === -1 ? sentenceEnd : sentenceEnd === -1 ? lineBreak : Math.min(lineBreak, sentenceEnd);
  if (cut === -1) return { title: text, summary: null };
  const title = text.slice(0, cut).replace(/[.]$/, '').trim();
  const summary = text.slice(cut).replace(/^[.!?]/, '').trim();
  return { title, summary: summary.length > 0 ? summary : null };
}

/** AddIdeaModal — see {@link AddIdeaModalProps}. */
export function AddIdeaModal({
  isOpen,
  onClose,
  projects,
  onLaunchPlanner,
}: AddIdeaModalProps): React.JSX.Element {
  const [step, setStep] = React.useState<'capture' | 'launch'>('capture');
  const [text, setText] = React.useState('');
  // null = the first project; an explicit pick pins it (and survives the
  // "+ Add another idea" loop, since a run of captures is usually one project).
  const [projectOverride, setProjectOverride] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState<{ id: string; title: string; projectId: number } | null>(
    null,
  );
  // Serialization of the last state the write effect below either wrote to
  // (or found already matching) localStorage. Callers that programmatically
  // reset text/projectOverride to a known target (seeding from a draft,
  // clearing on success, resetAll) prime this ref directly to that target's
  // serialization *before* calling setState, rather than setting a "skip
  // once" flag for the effect to consume — a flag-based approach breaks when
  // the setState calls happen to be no-ops (already-default state), since
  // then the effect never reruns to consume the flag, leaving it stale and
  // silently swallowing the next real write.
  const lastWrittenDraftRef = React.useRef<string | null>(null);

  // Seed from a persisted draft whenever the modal opens (isOpen flips
  // false -> true). A missing/corrupt draft (readDraft -> null) leaves the
  // existing defaults (blank text, no project override) untouched.
  React.useEffect(() => {
    if (!isOpen) return;
    const draft = readDraft(ADD_IDEA_MODAL_DRAFT_KEY, isAddIdeaDraft);
    if (draft !== null) {
      lastWrittenDraftRef.current = JSON.stringify(draft);
      setText(draft.text);
      setProjectOverride(draft.projectId);
    }
  }, [isOpen]);

  const selectedProjectId = projectOverride ?? projects[0]?.id ?? null;

  // Persist the in-progress capture whenever it actually changes, so
  // closing the modal (overlay/Escape/X/Cancel) doesn't lose it. Guarded by
  // a ref of the last-written serialization so unrelated re-renders (busy,
  // error, step) don't churn localStorage.
  React.useEffect(() => {
    const serialized = JSON.stringify({ text, projectId: projectOverride });
    if (lastWrittenDraftRef.current === serialized) return;
    lastWrittenDraftRef.current = serialized;
    writeDraft(ADD_IDEA_MODAL_DRAFT_KEY, { text, projectId: projectOverride });
  }, [text, projectOverride]);

  const resetAll = (): void => {
    // Prime the ref to the reset target so the write effect's next pass (if
    // it even reruns — text/projectOverride may already be at these
    // defaults) doesn't re-persist a stray blank draft. The real draft
    // clear, if any, already happened at the successful-create chokepoint
    // in handleCreate.
    lastWrittenDraftRef.current = JSON.stringify({ text: '', projectId: null });
    setStep('capture');
    setText('');
    setProjectOverride(null);
    setBusy(false);
    setError(null);
    setAdded(null);
  };

  const handleClose = (): void => {
    if (busy) return;
    // Deliberately no resetAll() here — closing (overlay/Escape/X/Cancel)
    // must leave text/projectOverride as-is so the write effect's
    // already-persisted draft still matches on-screen state on reopen.
    onClose();
  };

  const handleCreate = async (): Promise<void> => {
    if (text.trim().length === 0 || busy || selectedProjectId === null) return;
    setBusy(true);
    setError(null);
    try {
      const { title, summary } = splitIdeaText(text);
      const result = await trpc.cyboflow.tasks.create.mutate({
        projectId: selectedProjectId,
        type: 'idea',
        title,
        summary,
      });
      setAdded({ id: result.taskId, title, projectId: selectedProjectId });
      setStep('launch');
      clearDraft(ADD_IDEA_MODAL_DRAFT_KEY);
      // Prime the ref to match the post-clear target so the write effect's
      // next pass (triggered by setText('') below) doesn't immediately
      // re-persist a blank draft over the clear.
      lastWrittenDraftRef.current = JSON.stringify({ text: '', projectId: projectOverride });
      setText('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add the idea');
    } finally {
      setBusy(false);
    }
  };

  const handleLaunch = async (): Promise<void> => {
    if (added === null || busy) return;
    setBusy(true);
    try {
      await onLaunchPlanner(added.id, added.projectId);
    } finally {
      setBusy(false);
      resetAll();
      onClose();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm">
      {step === 'capture' ? (
        <>
          <ModalHeader>
            <span className="eyebrow text-text-tertiary">New idea</span>
          </ModalHeader>
          <ModalBody>
            <div className="flex flex-col gap-3 font-mono">
              <div className="text-base font-bold text-text-primary">
                What do you want to get done?
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                placeholder="Describe it in a sentence or two…"
                className="resize-none rounded-input border border-border-primary bg-input-bg px-3 py-2 text-sm leading-relaxed text-input-text placeholder:text-input-placeholder"
                aria-label="Idea description"
                data-testid="add-idea-input"
                autoFocus
              />
              {projects.length > 1 && (
                <label className="flex flex-col gap-1">
                  <span className="eyebrow text-text-secondary">Project</span>
                  <select
                    value={selectedProjectId ?? ''}
                    onChange={(e) => setProjectOverride(Number(e.target.value))}
                    className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                    aria-label="Idea project"
                    data-testid="add-idea-project"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {error !== null && (
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
              onClick={() => void handleCreate()}
              disabled={text.trim().length === 0 || busy || selectedProjectId === null}
              data-testid="add-idea-submit"
              className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add idea →'}
            </button>
          </ModalFooter>
        </>
      ) : (
        <>
          <ModalHeader>
            <span className="eyebrow text-status-success">Idea added</span>
          </ModalHeader>
          <ModalBody>
            <div className="flex flex-col gap-3 font-mono">
              <div
                className="flex items-start gap-2 border border-border-primary bg-surface-raised px-3 py-2"
                data-testid="add-idea-echo"
              >
                <Check className="mt-0.5 h-3 w-3 shrink-0 text-status-success" strokeWidth={2} />
                <span className="text-[11px] leading-relaxed text-text-secondary">
                  {added?.title}
                </span>
              </div>
              <div className="text-base font-bold text-text-primary">Launch a planner now?</div>
              <p className="text-[11px] leading-relaxed text-text-secondary">
                A planner will spec the idea and break it into tasks ready for a sprint. You can also
                launch one later from the backlog.
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <button
              type="button"
              onClick={() => {
                setStep('capture');
                setError(null);
              }}
              disabled={busy}
              data-testid="add-idea-add-another"
              className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Add another idea
            </button>
            <button
              type="button"
              onClick={() => void handleLaunch()}
              disabled={busy}
              data-testid="add-idea-launch-planner"
              className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Launching…' : '▶ Launch planner'}
            </button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
