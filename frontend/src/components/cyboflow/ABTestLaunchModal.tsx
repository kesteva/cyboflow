/**
 * ABTestLaunchModal — thin side-by-side A/B experiment launcher (Slice B).
 *
 * Collects variant A + variant B from the workflow's pickable variants (the
 * SAME active+draft set VariantSelector offers, reusing {@link pickableVariants}
 * from variantSelectorLogic), an OPTIONAL seed idea (via the shared
 * {@link IdeaPickerModal} — already excludes decomposed ideas, migration 017),
 * and submits `experiments.startSideBySide`. A !== B is enforced with a disabled
 * submit button + an inline hint.
 *
 * On success: navigates straight to arm A's session/run (mirrors
 * SessionStartWizard's launch → setActiveRun → setActiveProjectId → goToSession
 * path) after bootstrapping arm A's renderer panels via
 * {@link bootstrapArmSessionPanels} — the arm session was created server-side
 * WITHOUT panels, unlike `sessions:create-quick`. Arm B stays headless; slice
 * C's compare view is where it surfaces.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { useWorkflowVariants } from '../../stores/variantsStore';
import { pickableVariants } from './variantSelectorLogic';
import { IdeaPickerModal } from './IdeaPickerModal';
import { bootstrapArmSessionPanels } from '../../utils/bootstrapArmSessionPanels';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

export interface ABTestLaunchModalProps {
  isOpen: boolean;
  projectId: number;
  workflowId: string;
  onClose: () => void;
}

export function ABTestLaunchModal({
  isOpen,
  projectId,
  workflowId,
  onClose,
}: ABTestLaunchModalProps): React.JSX.Element {
  const { variants, loaded } = useWorkflowVariants(workflowId);
  const options = pickableVariants(variants);

  const [variantAId, setVariantAId] = useState<string>('');
  const [variantBId, setVariantBId] = useState<string>('');
  const [seedIdeaId, setSeedIdeaId] = useState<string | null>(null);
  const [seedIdeaLabel, setSeedIdeaLabel] = useState<string | null>(null);
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startInFlightRef = useRef(false);

  // One-shot default seeding per workflow: once the variant list resolves, pick
  // the first two distinct pickable variants (mirrors VariantSelector's seeding
  // effect) so an untouched modal already shows a valid pair when >=2 exist.
  // Guarded per-workflowId so it re-seeds for a newly targeted workflow without
  // ever overwriting the user's own later choice.
  const seededForWorkflowId = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !loaded) return;
    if (seededForWorkflowId.current === workflowId) return;
    seededForWorkflowId.current = workflowId;
    setVariantAId(options[0]?.id ?? '');
    setVariantBId(options[1]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, loaded, workflowId]);

  const reset = (): void => {
    setSeedIdeaId(null);
    setSeedIdeaLabel(null);
    setError(null);
    setIsStarting(false);
    seededForWorkflowId.current = null;
  };

  const handleClose = (): void => {
    if (isStarting) return;
    reset();
    onClose();
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

  const canSubmit =
    variantAId !== '' && variantBId !== '' && variantAId !== variantBId && !isStarting;

  const handleStart = async (): Promise<void> => {
    if (!canSubmit || startInFlightRef.current) return;
    startInFlightRef.current = true;
    setIsStarting(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.experiments.startSideBySide.mutate({
        projectId,
        workflowId,
        variantAId,
        variantBId,
        ...(seedIdeaId !== null ? { seedIdeaId } : {}),
      });

      // Bootstrap arm A's panels (server created the session headless), then
      // navigate straight to it.
      await bootstrapArmSessionPanels(result.armA.sessionId);
      useCyboflowStore.getState().setActiveRun(result.armA.runId, result.armA.sessionId);
      useNavigationStore.getState().setActiveProjectId(projectId);
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

  const insufficientVariants = loaded && options.length < 2;
  const sameVariantChosen = variantAId !== '' && variantAId === variantBId;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>Run an A/B test</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {!loaded && <p className="text-xs text-text-secondary">Loading variants…</p>}

          {insufficientVariants && (
            <p className="text-xs text-text-secondary" data-testid="ab-test-insufficient-variants">
              This workflow needs at least two variants (draft or active) before you
              can run a side-by-side test. Create a second variant from the
              Workflows editor first.
            </p>
          )}

          {loaded && options.length >= 2 && (
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
          projectId={projectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
        />
      )}
    </Modal>
  );
}
