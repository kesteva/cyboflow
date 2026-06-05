/**
 * TaskBatchPickerModal — the pre-launch multi-task selector for a PARALLEL
 * sprint batch (feat/parallel-sprint, P6). Modeled on IdeaPickerModal, but with
 * checkbox multi-select instead of a single <select>.
 *
 * A "sprint batch" executes up to N selected tasks in parallel over one shared
 * integration branch with a single human review at the end (see
 * docs/parallel-sprint-design.md). This modal is the entry point: the user
 * multi-selects the tasks, the chosen substrate drives the selection cap N
 * (15 for sdk, 10 for interactive — SPRINT_BATCH_MAX_TASKS), and onPicked hands
 * the task ids back to WorkflowPicker which calls runs.startBatch.
 *
 * Eligibility (rendered + selectable):
 *   - type==='task' && !isDone && inFlow.length===0
 *   - readyToWork===false tasks are STILL selectable (the dependency analyzer +
 *     DAG order them) but carry a 'blocked' indicator + their blockedBy refs.
 * In-flight tasks (inFlow.length>0) are rendered DISABLED — a task already
 * executing in another run cannot also join a batch.
 *
 * The cap is enforced client-side here (the launch button disables past N, and
 * over-cap checkboxes disable) AND server-side in runs.startBatch (defense in
 * depth). The effective substrate is read via substrates.resolveEffective so the
 * cap matches exactly what the launch path would stamp.
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import { SPRINT_BATCH_CAP, SPRINT_BATCH_MAX_TASKS } from '../../../../shared/types/sprintBatch';
import type { CliSubstrate } from '../../../../shared/types/substrate';

interface TaskBatchPickerModalProps {
  isOpen: boolean;
  projectId: number;
  /**
   * The substrate the user chose in WorkflowPicker. The effective substrate is
   * re-resolved through the same resolver ladder the launch path uses so the cap
   * N matches what runs.startBatch would stamp; this is the requested level.
   */
  substrate: CliSubstrate;
  onClose: () => void;
  /** Called with the multi-selected task ids when the user launches the batch. */
  onPicked: (taskIds: string[]) => void;
}

export function TaskBatchPickerModal({
  isOpen,
  projectId,
  substrate,
  onClose,
  onPicked,
}: TaskBatchPickerModalProps): React.JSX.Element {
  const [tasks, setTasks] = useState<BacklogTaskItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The effective substrate the launch path would resolve given the requested
   * substrate — the cap N keys off THIS value (not the raw request) so it matches
   * what WorkflowRegistry.createRun stamps. Defaults to the requested value until
   * the resolver query returns.
   */
  const [effectiveSubstrate, setEffectiveSubstrate] = useState<CliSubstrate>(substrate);

  // Load the project's tasks whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setIsLoading(true);
    setError(null);
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        // The list returns ALL entities; keep only NON-done tasks. In-flight
        // tasks are kept (rendered disabled) so the user sees why they can't be
        // batched; done tasks / ideas / epics are dropped entirely.
        const batchable = rows.filter((r) => r.type === 'task' && !r.isDone);
        setTasks(batchable);
        // Prune any prior selection that is no longer eligible.
        setSelectedIds((prev) => {
          const stillEligible = new Set(
            batchable.filter((t) => t.inFlow.length === 0).map((t) => t.id),
          );
          const next = new Set<string>();
          for (const id of prev) if (stillEligible.has(id)) next.add(id);
          return next;
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen, projectId]);

  // Re-resolve the effective substrate (drives the cap) whenever the requested
  // substrate or the open state changes.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    trpc.cyboflow.substrates.resolveEffective
      .query({ requestedSubstrate: substrate })
      .then((res) => {
        if (!cancelled) setEffectiveSubstrate(res.substrate);
      })
      .catch(() => {
        // Fall back to the requested substrate — a failed preview must not block
        // the picker. The server-side cap in runs.startBatch is the real guard.
        if (!cancelled) setEffectiveSubstrate(substrate);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, substrate]);

  const cap = SPRINT_BATCH_MAX_TASKS[effectiveSubstrate];

  // Eligible tasks (selectable): not in-flight. In-flight tasks are still
  // rendered (disabled) for context.
  const eligible = useMemo(() => tasks.filter((t) => t.inFlow.length === 0), [tasks]);

  const atCap = selectedIds.size >= cap;

  const reset = (): void => {
    setSelectedIds(new Set());
    setError(null);
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  const toggle = (taskId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        // Enforce the cap: ignore a check past N (the checkbox is also disabled).
        if (next.size >= cap) return prev;
        next.add(taskId);
      }
      return next;
    });
  };

  const selectAllEligible = (): void => {
    // Take up to `cap` eligible tasks (the cap may be smaller than the list).
    setSelectedIds(new Set(eligible.slice(0, cap).map((t) => t.id)));
  };

  const handleLaunch = (): void => {
    if (selectedIds.size === 0) return;
    onPicked(Array.from(selectedIds));
    reset();
  };

  const canLaunch = selectedIds.size > 0 && selectedIds.size <= cap;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg">
      <ModalHeader>Select tasks for a parallel sprint</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {/* Cap + concurrency note */}
          <div
            className="flex items-center justify-between gap-2"
            data-testid="task-batch-picker-cap"
          >
            <p className="text-xs text-text-secondary">
              Up to <span className="font-semibold text-text-primary">{cap}</span> tasks
              ({effectiveSubstrate}) · selected{' '}
              <span className="font-semibold text-text-primary">{selectedIds.size}</span>/{cap}
            </p>
            <button
              type="button"
              onClick={selectAllEligible}
              disabled={eligible.length === 0}
              data-testid="task-batch-picker-select-all"
              className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Select all eligible
            </button>
          </div>
          <p className="text-xs text-text-tertiary">
            At most {SPRINT_BATCH_CAP} run in parallel; the rest queue and run as slots free up.
            Dependencies are analyzed automatically so blocked tasks run after their prerequisites.
          </p>

          {isLoading && <p className="text-xs text-text-secondary">Loading tasks…</p>}

          {!isLoading && tasks.length === 0 && (
            <p className="text-xs text-text-secondary">
              No eligible tasks in the backlog. Decompose an idea into tasks first.
            </p>
          )}

          {!isLoading && tasks.length > 0 && (
            <ul className="flex flex-col gap-1" data-testid="task-batch-picker-list">
              {tasks.map((t) => {
                const inFlight = t.inFlow.length > 0;
                const checked = selectedIds.has(t.id);
                const blocked = t.readyToWork === false;
                // Disabled if in-flight OR (not yet checked AND already at cap).
                const disabled = inFlight || (!checked && atCap);
                const blockedRefs = (t.blockedBy ?? []).map((d) => d.ref).join(', ');
                return (
                  <li key={t.id}>
                    <label
                      data-testid={`task-batch-picker-item-${t.id}`}
                      data-blocked={blocked ? 'true' : undefined}
                      data-inflight={inFlight ? 'true' : undefined}
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
                        onChange={() => toggle(t.id)}
                        aria-label={`Select ${t.ref}`}
                        className="mt-0.5"
                      />
                      <span className="flex flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-text-primary">{t.ref}</span>
                          <span className="truncate text-text-secondary">{t.title}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {inFlight && (
                            <span
                              data-testid={`task-batch-picker-inflight-${t.id}`}
                              className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary"
                            >
                              in flight
                            </span>
                          )}
                          {blocked && (
                            <span
                              data-testid={`task-batch-picker-blocked-${t.id}`}
                              className="rounded-full bg-status-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warning"
                            >
                              blocked{blockedRefs ? ` by ${blockedRefs}` : ''}
                            </span>
                          )}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
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
          onClick={handleLaunch}
          disabled={!canLaunch}
          data-testid="task-batch-picker-launch"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Launch sprint ({selectedIds.size})
        </button>
      </ModalFooter>
    </Modal>
  );
}
