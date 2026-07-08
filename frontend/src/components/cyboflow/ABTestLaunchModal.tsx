/**
 * ABTestLaunchModal — thin side-by-side A/B experiment launcher (Slice B).
 *
 * Collects variant A + variant B for each arm. Each arm is either one of the
 * workflow's pickable variants (the SAME active+draft set VariantSelector offers,
 * reusing {@link pickableVariants} from variantSelectorLogic) OR the "Current
 * workflow (baseline)" sentinel ({@link BASELINE_VARIANT_SENTINEL}) — so a
 * workflow with a SINGLE variant can be tested head-to-head against the live
 * workflow (the primary use case; one variant seeds A=baseline, B=variant).
 * A !== B is enforced with a disabled submit button + an inline hint (both arms
 * cannot be the baseline).
 *
 * SEED, by workflow kind:
 *   - The task-driven `sprint` workflow REQUIRES seed tasks: an inline multi-select
 *     task checklist (SAME data source + eligibility filter as TaskBatchPickerModal
 *     — approved + Ready-for-dev-or-later, non-terminal, not archived; experiment-
 *     tagged rows are already hidden server-side) submits `seedTaskIds`. Each arm
 *     clones the selection so the normal sprint machinery runs in the sandbox. At
 *     least one task is required (a task-less sprint arm is meaningless).
 *   - Every OTHER workflow keeps the OPTIONAL seed idea (via the shared
 *     {@link IdeaPickerModal}), submitting `seedIdeaId`.
 *
 * On success: navigates straight to arm A's session/run (mirrors
 * SessionStartWizard's launch → setActiveRun → setActiveProjectId → goToSession
 * path) after bootstrapping arm A's renderer panels via
 * {@link bootstrapArmSessionPanels} — the arm session was created server-side
 * WITHOUT panels, unlike `sessions:create-quick`. Arm B stays headless; slice
 * C's compare view is where it surfaces.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { useWorkflowVariants } from '../../stores/variantsStore';
import { pickableVariants } from './variantSelectorLogic';
import { BASELINE_VARIANT_SENTINEL } from '../../../../shared/types/experiments';
import { SPRINT_BATCH_MAX_TASKS } from '../../../../shared/types/sprintBatch';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import { IdeaPickerModal } from './IdeaPickerModal';
import { bootstrapArmSessionPanels } from '../../utils/bootstrapArmSessionPanels';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

export interface ABTestLaunchModalProps {
  isOpen: boolean;
  /**
   * The default launch project. For a GLOBAL flow (e.g. the built-in `sprint`)
   * the caller can only guess a project, so the modal renders a project picker
   * (when {@link projects} has >1 entry) letting the user pick the project whose
   * backlog the seed tasks/ideas come from. The picked project is threaded into
   * both the seed query and the experiment submit.
   */
  projectId: number;
  /**
   * All selectable projects (id + name). When more than one is supplied the
   * modal shows a project picker seeded to {@link projectId}; with 0–1 it stays
   * hidden and the modal uses {@link projectId} directly.
   */
  projects?: { id: number; name: string }[];
  workflowId: string;
  /**
   * The workflow's built-in name. `sprint` is the only task-driven flow (v1): it
   * swaps the seed-idea picker for the required seed-task multi-select.
   */
  workflowName: string;
  onClose: () => void;
}

/**
 * The A/B seed-task cap. The experiment defaults to the 'sdk' substrate (the
 * modal has no substrate picker), and startExperiment enforces the same cap
 * server-side; the picker disables checkboxes past it (defense in depth).
 */
const SEED_TASK_CAP = SPRINT_BATCH_MAX_TASKS.sdk;

export function ABTestLaunchModal({
  isOpen,
  projectId,
  projects,
  workflowId,
  workflowName,
  onClose,
}: ABTestLaunchModalProps): React.JSX.Element {
  const isSprint = workflowName === 'sprint';
  // The project whose backlog seeds this experiment. Defaults to the caller's
  // `projectId` (for a GLOBAL flow, a guess); a >1-project picker lets the user
  // correct it. The modal unmounts on close, so this re-initialises per open.
  const [selectedProjectId, setSelectedProjectId] = useState<number>(projectId);
  const showProjectPicker = (projects?.length ?? 0) > 1;
  const { variants, loaded } = useWorkflowVariants(workflowId);
  const options = pickableVariants(variants);

  const [variantAId, setVariantAId] = useState<string>('');
  const [variantBId, setVariantBId] = useState<string>('');
  const [seedIdeaId, setSeedIdeaId] = useState<string | null>(null);
  const [seedIdeaLabel, setSeedIdeaLabel] = useState<string | null>(null);
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  // Sprint seed-task multi-select (mirrors TaskBatchPickerModal's data + filter).
  const [seedTasks, setSeedTasks] = useState<BacklogTaskItem[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [tasksLoading, setTasksLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startInFlightRef = useRef(false);

  // One-shot default seeding per workflow: once the variant list resolves, seed a
  // valid arm pair (mirrors VariantSelector's seeding effect) so an untouched modal
  // is ready to submit. With EXACTLY one pickable variant — the primary use case —
  // seed arm A = the current workflow (baseline) and arm B = that variant, so a
  // one-variant workflow can be tested head-to-head against the live workflow. With
  // >=2 variants, seed the first two distinct variants. Guarded per-workflowId so it
  // re-seeds for a newly targeted workflow without ever overwriting a later choice.
  const seededForWorkflowId = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !loaded) return;
    if (seededForWorkflowId.current === workflowId) return;
    seededForWorkflowId.current = workflowId;
    if (options.length === 1) {
      setVariantAId(BASELINE_VARIANT_SENTINEL);
      setVariantBId(options[0].id);
    } else {
      setVariantAId(options[0]?.id ?? '');
      setVariantBId(options[1]?.id ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, loaded, workflowId]);

  // Sprint seed-task load (only for the task-driven sprint workflow). Loads the
  // project's tasks + boards and keeps ONLY the sprint-eligible ones, EXACTLY as
  // TaskBatchPickerModal + the runs.start pre-check do: type==='task', approved
  // (approved_at !== null), NOT archived, at a ready-or-later NON-terminal stage
  // (stage_position >= 6 && the stage is not terminal). Experiment-tagged clones
  // are already excluded server-side by the backlog list.
  useEffect(() => {
    if (!isOpen || !isSprint) return;
    let cancelled = false;
    setTasksLoading(true);
    setError(null);
    Promise.all([
      trpc.cyboflow.tasks.list.query({ projectId: selectedProjectId }),
      trpc.cyboflow.tasks.boardsForProject.query({ projectId: selectedProjectId }),
    ])
      .then(([rows, boards]) => {
        if (cancelled) return;
        const terminalStageIds = new Set<string>(
          boards.flatMap((b: Board) => b.stages.filter((s) => s.is_terminal).map((s) => s.id)),
        );
        // Tasks with a parent epic are nested under the epic's `children`; flatten
        // epics first so epic-owned tasks are seedable too.
        const flattened = rows.flatMap((r) => (r.type === 'epic' ? (r.children ?? []) : [r]));
        const eligible = flattened.filter(
          (r) =>
            r.type === 'task' &&
            r.approved_at !== null &&
            r.archived_at === null &&
            r.stage_position >= 6 &&
            !terminalStageIds.has(r.stage_id),
        );
        setSeedTasks(eligible);
        // Prune any prior selection to what's still eligible + not in-flight.
        const eligibleSet = new Set(eligible.filter((t) => t.inFlow.length === 0).map((t) => t.id));
        setSelectedTaskIds((prev) => new Set(Array.from(prev).filter((id) => eligibleSet.has(id))));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load tasks');
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isSprint, selectedProjectId]);

  const reset = (): void => {
    setSeedIdeaId(null);
    setSeedIdeaLabel(null);
    setSelectedTaskIds(new Set());
    setError(null);
    setIsStarting(false);
    seededForWorkflowId.current = null;
  };

  // Eligible (selectable) seed tasks: not already in-flight in another run.
  const selectableTasks = useMemo(() => seedTasks.filter((t) => t.inFlow.length === 0), [seedTasks]);
  const atTaskCap = selectedTaskIds.size >= SEED_TASK_CAP;

  const toggleTask = (taskId: string): void => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else if (next.size < SEED_TASK_CAP) next.add(taskId);
      return next;
    });
  };

  const selectAllTasks = (): void => {
    setSelectedTaskIds(new Set(selectableTasks.slice(0, SEED_TASK_CAP).map((t) => t.id)));
  };

  const handleClose = (): void => {
    if (isStarting) return;
    reset();
    onClose();
  };

  // Switching the project invalidates any prior seed selection (task ids + seed
  // idea belong to the previous project's backlog); the seed-task effect reloads
  // for the new project on the next tick.
  const handleProjectChange = (nextProjectId: number): void => {
    if (nextProjectId === selectedProjectId) return;
    setSelectedProjectId(nextProjectId);
    setSelectedTaskIds(new Set());
    setSeedTasks([]);
    setSeedIdeaId(null);
    setSeedIdeaLabel(null);
  };

  const handleIdeaPicked = (ideaId: string): void => {
    setIdeaPickerOpen(false);
    setSeedIdeaId(ideaId);
    setSeedIdeaLabel(ideaId);
    // Best-effort friendly label — falls back to the raw id if the lookup fails.
    void trpc.cyboflow.tasks.get
      .query({ taskId: ideaId })
      .then((row) => {
        if (row) setSeedIdeaLabel(`${row.ref} — ${row.title}`);
      })
      .catch(() => {});
  };

  // A sprint experiment additionally REQUIRES >=1 seed task (a task-less sprint arm
  // has nothing to run); every other workflow's seed idea stays optional.
  const canSubmit =
    variantAId !== '' &&
    variantBId !== '' &&
    variantAId !== variantBId &&
    !isStarting &&
    (!isSprint || selectedTaskIds.size > 0);

  const handleStart = async (): Promise<void> => {
    if (!canSubmit || startInFlightRef.current) return;
    startInFlightRef.current = true;
    setIsStarting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.experiments.startSideBySide.mutate({
        projectId: selectedProjectId,
        workflowId,
        variantAId,
        variantBId,
        ...(isSprint
          ? { seedTaskIds: Array.from(selectedTaskIds) }
          : seedIdeaId !== null
            ? { seedIdeaId }
            : {}),
      });

      // Bootstrap arm A's panels (server created the session headless), then
      // navigate straight to it.
      await bootstrapArmSessionPanels(result.armA.sessionId);
      useCyboflowStore.getState().setActiveRun(result.armA.runId, result.armA.sessionId);
      useNavigationStore.getState().setActiveProjectId(selectedProjectId);
      useNavigationStore.getState().goToSession();

      reset();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start the A/B experiment');
    } finally {
      setIsStarting(false);
      startInFlightRef.current = false;
    }
  };

  const insufficientVariants = loaded && options.length < 1;
  const sameVariantChosen = variantAId !== '' && variantAId === variantBId;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>Run an A/B test</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {showProjectPicker && (
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              Project
              <select
                value={selectedProjectId}
                onChange={(e) => handleProjectChange(Number(e.target.value))}
                className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                aria-label="Select project"
                data-testid="ab-test-project"
              >
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!loaded && <p className="text-xs text-text-secondary">Loading variants…</p>}

          {insufficientVariants && (
            <p className="text-xs text-text-secondary" data-testid="ab-test-insufficient-variants">
              This workflow needs at least one variant (draft or active) before you
              can run a side-by-side test — an arm can be the current workflow
              (baseline), but the other must be a variant. Create a variant from the
              Workflows editor first.
            </p>
          )}

          {loaded && options.length >= 1 && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                Variant A
                <select
                  value={variantAId}
                  onChange={(e) => setVariantAId(e.target.value)}
                  className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                  aria-label="Select variant A"
                  data-testid="ab-test-variant-a"
                >
                  <option value={BASELINE_VARIANT_SENTINEL}>Current workflow (baseline)</option>
                  {options.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.status === 'draft' ? `${v.label} (draft)` : v.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                Variant B
                <select
                  value={variantBId}
                  onChange={(e) => setVariantBId(e.target.value)}
                  className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                  aria-label="Select variant B"
                  data-testid="ab-test-variant-b"
                >
                  <option value={BASELINE_VARIANT_SENTINEL}>Current workflow (baseline)</option>
                  {options.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.status === 'draft' ? `${v.label} (draft)` : v.label}
                    </option>
                  ))}
                </select>
              </label>
              {sameVariantChosen && (
                <p
                  className="text-xs text-status-error"
                  role="alert"
                  data-testid="ab-test-same-variant-hint"
                >
                  Pick two different variants to compare.
                </p>
              )}

              {isSprint ? (
                <div
                  className="flex flex-col gap-1.5 border-t border-dashed border-border-primary pt-3"
                  data-testid="ab-test-seed-tasks"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text-secondary">
                      Seed tasks (required) · selected{' '}
                      <span className="font-semibold text-text-primary">{selectedTaskIds.size}</span>/{SEED_TASK_CAP}
                    </span>
                    <button
                      type="button"
                      onClick={selectAllTasks}
                      disabled={selectableTasks.length === 0}
                      data-testid="ab-test-select-all-tasks"
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Select all eligible
                    </button>
                  </div>
                  <p className="text-xs text-text-tertiary">
                    Each arm runs a private copy of the selected tasks; the winner's
                    outcome folds back onto your originals.
                  </p>
                  {tasksLoading && <p className="text-xs text-text-secondary">Loading tasks…</p>}
                  {!tasksLoading && seedTasks.length === 0 && (
                    <p className="text-xs text-text-secondary" data-testid="ab-test-no-seed-tasks">
                      No sprint-eligible tasks. Each task must be approved and at "Ready for
                      development" or later (not archived, done, or won't-do).
                    </p>
                  )}
                  {!tasksLoading && seedTasks.length > 0 && (
                    <ul className="flex max-h-52 flex-col gap-1 overflow-y-auto" data-testid="ab-test-seed-task-list">
                      {seedTasks.map((t) => {
                        const inFlight = t.inFlow.length > 0;
                        const checked = selectedTaskIds.has(t.id);
                        const disabled = inFlight || (!checked && atTaskCap);
                        return (
                          <li key={t.id}>
                            <label
                              data-testid={`ab-test-seed-task-item-${t.id}`}
                              className={`flex items-start gap-2 rounded-button border px-2 py-1.5 text-sm ${
                                disabled
                                  ? 'cursor-not-allowed border-border-primary bg-bg-secondary opacity-60'
                                  : 'cursor-pointer border-border-primary bg-bg-primary hover:bg-bg-hover'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggleTask(t.id)}
                                aria-label={`Select ${t.ref}`}
                                className="mt-0.5"
                              />
                              <span className="flex flex-1 items-center gap-2">
                                <span className="font-medium text-text-primary">{t.ref}</span>
                                <span className="truncate text-text-secondary">{t.title}</span>
                                {inFlight && (
                                  <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
                                    in flight
                                  </span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {!tasksLoading && seedTasks.length > 0 && selectedTaskIds.size === 0 && (
                    <p className="text-xs text-status-error" role="alert" data-testid="ab-test-seed-task-required-hint">
                      Select at least one task to compare.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5 border-t border-dashed border-border-primary pt-3">
                  <span className="text-xs font-medium text-text-secondary">Seed idea (optional)</span>
                  {seedIdeaId === null ? (
                    <button
                      type="button"
                      onClick={() => setIdeaPickerOpen(true)}
                      data-testid="ab-test-add-seed-idea"
                      className="self-start rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover"
                    >
                      Add a seed idea
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-text-secondary">
                      <span className="truncate" data-testid="ab-test-seed-idea-label">
                        {seedIdeaLabel}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSeedIdeaId(null);
                          setSeedIdeaLabel(null);
                        }}
                        data-testid="ab-test-clear-seed-idea"
                        className="text-text-tertiary underline hover:text-text-primary"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )}
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
          disabled={isStarting}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={!canSubmit}
          data-testid="ab-test-submit"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isStarting ? 'Starting…' : 'Start A/B test'}
        </button>
      </ModalFooter>

      {ideaPickerOpen && (
        <IdeaPickerModal
          isOpen
          projectId={selectedProjectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
        />
      )}
    </Modal>
  );
}
