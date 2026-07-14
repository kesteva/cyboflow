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
import { ScopeTag } from '../Backlog/markers';
import { useIdeaAttachments } from '../../hooks/useIdeaAttachments';
import { trpc } from '../../trpc/client';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

/** Empty seed for the create-form attachment hook (stable reference). */
const NO_ATTACHMENTS: never[] = [];

/** Multi-select planner batch cap (IDEA-009). */
const MULTI_CAP = 4;

/**
 * Neutral "scope not set" chip for the multi-select checklist. Kept local so the
 * shared ScopeTag's Record<IdeaScope, …> maps stay exhaustive over the real
 * scope values (small | large) — an unset idea is a picker concern, not a scope.
 */
function UnsetScopeTag(): React.JSX.Element {
  return (
    <span
      className="eyebrow rounded-[3px] border border-border-primary bg-bg-tertiary px-1.5 py-px text-text-tertiary"
      title="Scope: not set"
      data-testid="scope-tag-unset"
    >
      ?
    </span>
  );
}

interface IdeaPickerModalProps {
  isOpen: boolean;
  projectId: number;
  onClose: () => void;
  /**
   * Called with the chosen/minted idea id(s). Single-select and "new idea" modes
   * emit a 1-element array with no opts. Multi mode emits the batch selection
   * (max {@link MULTI_CAP}) plus `opts.separateIdeaIds` for ideas the user peeled
   * off via "Plan separately" (empty array when none). A later task threads the
   * arrays through the launch surfaces.
   */
  onPicked: (ideaIds: string[], opts?: { separateIdeaIds: string[] }) => void;
  /**
   * Which tab opens first. Defaults to 'pick'. The onboarding /ship path passes
   * 'new' — a first-run user has no backlog yet, so writing their first idea is
   * the intended action.
   */
  defaultMode?: Mode;
  /**
   * Render the "what's an idea?" explainer callout above the picker. The
   * onboarding path sets this so the first idea a user writes comes with context.
   */
  showIdeaExplainer?: boolean;
  /**
   * Multi-select planner mode: a checkbox list capped at {@link MULTI_CAP} with
   * per-row scope badges and a pick-time "Plan separately" split. Default false =
   * the original single-select UI (unchanged). Ship/AB flows keep single-select.
   */
  multi?: boolean;
  /**
   * Whether the hosting surface honors `opts.separateIdeaIds` by firing one
   * extra single-idea launch per peeled idea. Default true. SessionStartWizard
   * passes false — its launch navigates away on success, so it cannot run the
   * N+1 loop and a peeled idea would be silently dropped; hiding the split
   * keeps the affordance honest there (large ideas can still be unchecked).
   */
  allowPlanSeparately?: boolean;
}

type Mode = 'pick' | 'new';

export function IdeaPickerModal({
  isOpen,
  projectId,
  onClose,
  onPicked,
  defaultMode = 'pick',
  showIdeaExplainer = false,
  multi = false,
  allowPlanSeparately = true,
}: IdeaPickerModalProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [ideas, setIdeas] = useState<BacklogTaskItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Multi mode: the batch selection (capped at MULTI_CAP) and the ids peeled off
  // to their own run via "Plan separately".
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  const [separateIds, setSeparateIds] = useState<string[]>([]);
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
    setMultiSelectedIds([]);
    setSeparateIds([]);
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        // The list returns ALL entities; `type` is a synthesized discriminator.
        // Filter to open, NON-archived, NON-retired ideas only (archive-in-place,
        // migration 024) — Sprint operates on decomposed tasks, so an idea that
        // is done/decomposed/archived is not a valid planner seed. A retired
        // idea keeps its original stage (isDone stays false) and is marked
        // solely by decomposed_at, so it needs its own check.
        const openIdeas = rows.filter(
          (r) =>
            r.type === 'idea' && !r.isDone && r.archived_at === null && r.decomposed_at === null,
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
    setMode(defaultMode);
    setTitle('');
    setBody('');
    setError(null);
    setSubmitting(false);
    setMultiSelectedIds([]);
    setSeparateIds([]);
    attachmentsCtl.reset();
  };

  const toggleMulti = (id: string): void => {
    setMultiSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MULTI_CAP) return prev;
      return [...prev, id];
    });
  };

  const planSeparately = (id: string): void => {
    setMultiSelectedIds((prev) => prev.filter((x) => x !== id));
    setSeparateIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const restoreFromSeparate = (id: string): void => {
    setSeparateIds((prev) => prev.filter((x) => x !== id));
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  const handlePickExisting = (): void => {
    if (submitting) return;
    if (multi) {
      if (multiSelectedIds.length === 0 && separateIds.length === 0) return;
      onPicked(multiSelectedIds, { separateIdeaIds: separateIds });
      reset();
      return;
    }
    if (selectedId === null) return;
    onPicked([selectedId]);
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
      onPicked([result.taskId]);
      reset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create idea');
      setSubmitting(false);
    }
  };

  const atCap = multiSelectedIds.length >= MULTI_CAP;
  // Ideas still selectable in the checklist (parked ones move to the chip row).
  const parkedSet = new Set(separateIds);
  const listIdeas = ideas.filter((i) => !parkedSet.has(i.id));
  const separateIdeas = separateIds
    .map((id) => ideas.find((i) => i.id === id))
    .filter((i): i is BacklogTaskItem => i !== undefined);

  const canSubmit =
    mode === 'new'
      ? title.trim().length > 0
      : multi
        ? multiSelectedIds.length > 0 || separateIds.length > 0
        : selectedId !== null;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>{multi ? 'Select ideas for the planner' : 'Select an idea for the planner'}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {showIdeaExplainer && (
            <div
              className="rounded border-l-2 border-interactive bg-bg-secondary px-3 py-2.5 text-xs leading-relaxed text-text-secondary"
              data-testid="idea-picker-explainer"
            >
              <p className="mb-1 text-[13px] font-semibold text-text-primary">What&rsquo;s an idea?</p>
              <p>
                Ideas are the first step of the build process in Cyboflow. They&rsquo;re meant to be captured the
                moment you have an idea for something you want to do. They can be small (change the color of this
                button) or large (build this new feature). They don&rsquo;t need to be detailed, but you can add as
                much detail in the body as you want. Additional steps will extract more details from you as needed.
              </p>
            </div>
          )}

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
              {!isLoading && ideas.length > 0 && !multi && (
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
              {!isLoading && ideas.length > 0 && multi && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-text-secondary">Ideas</span>
                    <span
                      className="text-xs text-text-secondary"
                      data-testid="idea-picker-meter"
                    >
                      {multiSelectedIds.length} of {MULTI_CAP} selected
                    </span>
                  </div>
                  {atCap && (
                    <div
                      className="rounded border-l-2 border-status-warning bg-status-warning/10 px-3 py-2 text-xs leading-relaxed text-text-secondary"
                      data-testid="idea-picker-cap-banner"
                    >
                      You can plan up to {MULTI_CAP} ideas at once. Launch this batch, then run
                      another batch after.
                    </div>
                  )}
                  <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {listIdeas.map((i) => {
                      const checked = multiSelectedIds.includes(i.id);
                      const disabled = !checked && atCap;
                      const mixedLarge =
                        i.scope === 'large' && checked && multiSelectedIds.length > 1;
                      return (
                        <div key={i.id} className="flex flex-col gap-1">
                          <label
                            className={`flex items-center gap-2 rounded-input border border-border-primary px-2 py-1.5 text-sm ${
                              disabled
                                ? 'cursor-not-allowed bg-bg-primary opacity-50'
                                : 'cursor-pointer bg-bg-primary hover:bg-bg-hover'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleMulti(i.id)}
                              data-testid={`idea-check-${i.id}`}
                              aria-label={`${i.ref} — ${i.title}`}
                            />
                            <span className="flex-1 truncate text-text-primary">
                              {i.ref} — {i.title}
                            </span>
                            {i.scope ? <ScopeTag scope={i.scope} /> : <UnsetScopeTag />}
                          </label>
                          {mixedLarge && allowPlanSeparately && (
                            <div
                              className="flex items-center justify-between gap-2 rounded border-l-2 border-status-warning bg-status-warning/10 px-3 py-1.5 text-xs text-text-secondary"
                              data-testid={`plan-separately-warning-${i.id}`}
                            >
                              <span>
                                This idea is large — planning it in its own run keeps the batch
                                focused.
                              </span>
                              <button
                                type="button"
                                onClick={() => planSeparately(i.id)}
                                data-testid={`plan-separately-${i.id}`}
                                className="shrink-0 rounded-button border border-status-warning/40 bg-bg-primary px-2 py-1 font-medium text-status-warning hover:bg-status-warning/10"
                              >
                                Plan separately
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {separateIdeas.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-text-secondary">
                        Queued as separate runs
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {separateIdeas.map((i) => (
                          <span
                            key={i.id}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border-primary bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary"
                            data-testid={`separate-chip-${i.id}`}
                          >
                            <span className="truncate">{i.ref} · separate run</span>
                            <button
                              type="button"
                              onClick={() => restoreFromSeparate(i.id)}
                              data-testid={`separate-undo-${i.id}`}
                              aria-label={`Undo separate run for ${i.ref}`}
                              className="text-text-tertiary hover:text-text-primary"
                            >
                              Undo
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
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
          {submitting ? 'Creating…' : mode === 'new' ? 'Create & use' : multi ? 'Use ideas' : 'Use idea'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
