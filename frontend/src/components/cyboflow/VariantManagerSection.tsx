/**
 * VariantManagerSection — the "Variants" management panel for a workflow
 * (migration 048 / workflow A/B testing), rendered inside
 * {@link WorkflowEditorModal} (edit mode only — a variant always snapshots an
 * EXISTING workflow row, so there is nothing to manage in create mode).
 *
 * Lists the workflow's variants (label, status pill, weight) and offers:
 *   - "Create variant from current" — snapshots the resolved definition
 *     (`variants.create`), seeded status='draft'.
 *   - Edit — opens {@link VariantEditorModal} (graph + agent-delta editor).
 *   - Add to rotation / Pause — `variants.setStatus('active' | 'paused')`.
 *   - Retire — `variants.setStatus('retired')` (hidden from pickers + rotation,
 *     kept for stats).
 *   - Delete — `variants.delete`; a CONFLICT (run history) surfaces the
 *     registry's own message, which already suggests retiring instead.
 *   - A weight numeric input — `variants.update({ weight })`.
 *
 * Every mutation calls `useVariantsStore.getState().invalidate(workflowId)` so
 * the list (and any open VariantSelector) stays live.
 */
import { useState, useCallback, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { useWorkflowVariants, useVariantsStore, type WorkflowVariantRow } from '../../stores/variantsStore';
import { FlowNameDialog } from './FlowNameDialog';
import { VariantEditorModal } from './VariantEditorModal';
import type { WorkflowVariantStatus } from '../../../../shared/types/experiments';

export interface VariantManagerSectionProps {
  workflowId: string;
  projectId: number;
  /**
   * The host editor's unsaved-graph state (WorkflowEditorModal.isDirty). Variants
   * snapshot the workflow's LAST SAVED spec_json from the DB — NOT the live graph
   * — so with unsaved edits "Create variant from current" would silently ignore
   * what the user sees. When true the create button is disabled with an inline
   * "save first" hint. Optional (defaults false) so non-editor callers are
   * unaffected. Variant Edit/updateVariant re-snapshot from the DB row and are NOT
   * gated by this.
   */
  editorDirty?: boolean;
}

/** Synthetic busy-set key for the baseline row (it has no variant id). */
const BASELINE_BUSY_KEY = '__baseline__';

/** Display label + badge tone per variant status. */
const STATUS_LABEL: Record<WorkflowVariantStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  retired: 'Retired',
};

/** Rotation badge for the baseline row (in rotation vs off), styled like {@link StatusPill}. */
function BaselinePill({ inRotation }: { inRotation: boolean }): React.JSX.Element {
  const tone = inRotation
    ? 'border-status-success text-status-success'
    : 'border-border-primary text-text-tertiary';
  return (
    <span
      className={`rounded-badge border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] ${tone}`}
      data-testid="baseline-status-pill"
    >
      {inRotation ? 'In rotation' : 'Baseline'}
    </span>
  );
}

function StatusPill({ status }: { status: WorkflowVariantStatus }): React.JSX.Element {
  const tone =
    status === 'active'
      ? 'border-status-success text-status-success'
      : status === 'draft'
        ? 'border-border-primary text-text-tertiary'
        : status === 'paused'
          ? 'border-status-warning text-status-warning'
          : 'border-border-secondary text-text-disabled';
  return (
    <span
      className={`rounded-badge border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] ${tone}`}
      data-testid="variant-status-pill"
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function VariantManagerSection({
  workflowId,
  projectId,
  editorDirty = false,
}: VariantManagerSectionProps): React.JSX.Element {
  const { variants, baseline, loading, error: loadError } = useWorkflowVariants(workflowId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<WorkflowVariantRow | null>(null);
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});
  const [baselineWeightDraft, setBaselineWeightDraft] = useState<string | null>(null);
  const busySetRef = useRef<Set<string>>(new Set());
  const [, forceRerender] = useState(0);

  const invalidate = useCallback(async () => {
    await useVariantsStore.getState().invalidate(workflowId);
  }, [workflowId]);

  const withBusy = useCallback(async (variantId: string, fn: () => Promise<void>) => {
    if (busySetRef.current.has(variantId)) return;
    busySetRef.current.add(variantId);
    forceRerender((n) => n + 1);
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Variant action failed');
    } finally {
      busySetRef.current.delete(variantId);
      forceRerender((n) => n + 1);
    }
  }, []);

  const handleCreate = useCallback(
    async (label: string) => {
      setCreateDialogOpen(false);
      setActionError(null);
      try {
        await trpc.cyboflow.variants.create.mutate({ workflowId, label });
        await invalidate();
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : 'Failed to create variant');
      }
    },
    [workflowId, invalidate],
  );

  const handleSetStatus = useCallback(
    (variantId: string, status: WorkflowVariantStatus) =>
      withBusy(variantId, async () => {
        await trpc.cyboflow.variants.setStatus.mutate({ variantId, status });
        await invalidate();
      }),
    [withBusy, invalidate],
  );

  const handleDelete = useCallback(
    (variantId: string) =>
      withBusy(variantId, async () => {
        await trpc.cyboflow.variants.delete.mutate({ variantId });
        await invalidate();
      }),
    [withBusy, invalidate],
  );

  const commitWeight = useCallback(
    (variantId: string, raw: string) =>
      withBusy(variantId, async () => {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) return;
        await trpc.cyboflow.variants.update.mutate({ variantId, weight: parsed });
        await invalidate();
      }),
    [withBusy, invalidate],
  );

  // The baseline (the workflow's live definition) is a rotation participant too
  // (migration 054) — tracked on `workflows`, not `workflow_variants`, so it uses a
  // synthetic '__baseline__' busy key and the variants.setBaselineRotation mutation.
  const commitBaselineWeight = useCallback(
    (raw: string) =>
      withBusy(BASELINE_BUSY_KEY, async () => {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) return;
        await trpc.cyboflow.variants.setBaselineRotation.mutate({ workflowId, weight: parsed });
        await invalidate();
      }),
    [withBusy, invalidate, workflowId],
  );

  const handleSetBaselineInRotation = useCallback(
    (inRotation: boolean) =>
      withBusy(BASELINE_BUSY_KEY, async () => {
        await trpc.cyboflow.variants.setBaselineRotation.mutate({ workflowId, inRotation });
        await invalidate();
      }),
    [withBusy, invalidate, workflowId],
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border-primary px-4 py-3" data-testid="variant-manager-section">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-text-primary">Variants</h3>
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          disabled={editorDirty}
          title={
            editorDirty
              ? 'Save the workflow first — variants snapshot the last saved definition.'
              : undefined
          }
          data-testid="variant-manager-create-button"
          className="ml-auto rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create variant from current
        </button>
      </div>

      {editorDirty && (
        <p className="text-[11px] text-text-tertiary" data-testid="variant-manager-dirty-hint">
          Save the workflow first — variants snapshot the last saved definition.
        </p>
      )}

      {loading && variants.length === 0 && (
        <p className="text-xs text-text-secondary">Loading variants…</p>
      )}
      {loadError !== null && <p className="text-xs text-status-error">{loadError}</p>}
      {actionError !== null && (
        <p role="alert" className="text-xs text-status-error" data-testid="variant-manager-error">
          {actionError}
        </p>
      )}

      {(!loading || variants.length > 0 || baseline !== null) && (
        <>
          <p className="text-[11px] text-text-tertiary" data-testid="variant-manager-rotation-cost-note">
            Rotation weight controls how often each participant — the baseline and every active variant —
            is picked for a normal launch; every rotation run still accrues its own eval/judge cost when
            auto-grading is on (Settings → Code Review Eval).
          </p>
          <div className="flex flex-col gap-1.5">
          {/* Baseline row — the workflow's live definition as a first-class rotation participant
              (migration 054). Off by default; "Add to rotation" opts it in with a weight so it can
              A/B against a variant. Always shown so the baseline's share is visible + controllable. */}
          {baseline !== null && (() => {
            const isBusy = busySetRef.current.has(BASELINE_BUSY_KEY);
            const weightValue = baselineWeightDraft ?? String(baseline.weight);
            return (
              <div
                className="flex items-center gap-2 rounded-input border border-border-secondary bg-surface-secondary/20 px-2 py-1.5"
                data-testid="variant-row-baseline"
              >
                <span className="text-xs font-medium text-text-primary truncate">
                  Baseline <span className="font-normal text-text-tertiary">(current workflow)</span>
                </span>
                <BaselinePill inRotation={baseline.inRotation} />
                <label className="ml-2 flex items-center gap-1 text-[10px] text-text-tertiary">
                  Weight
                  <input
                    type="number"
                    min={0}
                    value={weightValue}
                    disabled={isBusy}
                    onChange={(e) => setBaselineWeightDraft(e.target.value)}
                    onBlur={(e) => void commitBaselineWeight(e.target.value)}
                    className="w-14 rounded-input border border-border-primary bg-bg-primary px-1.5 py-0.5 text-[11px] text-text-primary"
                    aria-label="Baseline rotation weight"
                    data-testid="baseline-weight-input"
                  />
                </label>
                <div className="ml-auto flex items-center gap-1.5">
                  {baseline.inRotation ? (
                    <button
                      type="button"
                      onClick={() => void handleSetBaselineInRotation(false)}
                      disabled={isBusy}
                      data-testid="baseline-pause-button"
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Remove from rotation
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSetBaselineInRotation(true)}
                      disabled={isBusy}
                      data-testid="baseline-activate-button"
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Add to rotation
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          {variants.map((variant) => {
            const isBusy = busySetRef.current.has(variant.id);
            const weightValue = weightDrafts[variant.id] ?? String(variant.weight);
            return (
              <div
                key={variant.id}
                className="flex items-center gap-2 rounded-input border border-border-secondary px-2 py-1.5"
                data-testid={`variant-row-${variant.id}`}
              >
                <span className="text-xs font-medium text-text-primary truncate">{variant.label}</span>
                <StatusPill status={variant.status} />
                <label className="ml-2 flex items-center gap-1 text-[10px] text-text-tertiary">
                  Weight
                  <input
                    type="number"
                    min={0}
                    value={weightValue}
                    disabled={isBusy}
                    onChange={(e) =>
                      setWeightDrafts((prev) => ({ ...prev, [variant.id]: e.target.value }))
                    }
                    onBlur={(e) => void commitWeight(variant.id, e.target.value)}
                    className="w-14 rounded-input border border-border-primary bg-bg-primary px-1.5 py-0.5 text-[11px] text-text-primary"
                    aria-label={`${variant.label} rotation weight`}
                    data-testid={`variant-weight-input-${variant.id}`}
                  />
                </label>
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditingVariant(variant)}
                    disabled={isBusy}
                    data-testid={`variant-edit-button-${variant.id}`}
                    className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Edit
                  </button>
                  {variant.status !== 'active' && variant.status !== 'retired' && (
                    <button
                      type="button"
                      onClick={() => void handleSetStatus(variant.id, 'active')}
                      disabled={isBusy}
                      data-testid={`variant-activate-button-${variant.id}`}
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Add to rotation
                    </button>
                  )}
                  {variant.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => void handleSetStatus(variant.id, 'paused')}
                      disabled={isBusy}
                      data-testid={`variant-pause-button-${variant.id}`}
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Pause
                    </button>
                  )}
                  {variant.status !== 'retired' && (
                    <button
                      type="button"
                      onClick={() => void handleSetStatus(variant.id, 'retired')}
                      disabled={isBusy}
                      data-testid={`variant-retire-button-${variant.id}`}
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Retire
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDelete(variant.id)}
                    disabled={isBusy}
                    data-testid={`variant-delete-button-${variant.id}`}
                    className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-status-error hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {variants.length === 0 && !loading && (
            <p className="text-[11px] text-text-tertiary" data-testid="variant-manager-empty-hint">
              No variants yet — create one from the current definition to A/B test it against the baseline.
            </p>
          )}
          </div>
        </>
      )}

      <FlowNameDialog
        isOpen={createDialogOpen}
        title="Name for the new variant"
        defaultValue=""
        confirmLabel="Create"
        onConfirm={(name) => void handleCreate(name)}
        onClose={() => setCreateDialogOpen(false)}
      />

      {editingVariant !== null && (
        <VariantEditorModal
          isOpen
          workflowId={workflowId}
          projectId={projectId}
          variant={editingVariant}
          onClose={() => setEditingVariant(null)}
          onSaved={() => setEditingVariant(null)}
        />
      )}
    </div>
  );
}
