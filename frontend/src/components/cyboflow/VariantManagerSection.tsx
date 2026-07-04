/**
 * VariantManagerSection — the "Variants" management panel for a workflow
 * (migration 046 / workflow A/B testing), rendered inside
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
}

/** Display label + badge tone per variant status. */
const STATUS_LABEL: Record<WorkflowVariantStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  retired: 'Retired',
};

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

export function VariantManagerSection({ workflowId, projectId }: VariantManagerSectionProps): React.JSX.Element {
  const { variants, loading, error: loadError } = useWorkflowVariants(workflowId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<WorkflowVariantRow | null>(null);
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});
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

  return (
    <div className="flex flex-col gap-2 border-t border-border-primary px-4 py-3" data-testid="variant-manager-section">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-text-primary">Variants</h3>
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          data-testid="variant-manager-create-button"
          className="ml-auto rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-bg-hover"
        >
          Create variant from current
        </button>
      </div>

      {loading && variants.length === 0 && (
        <p className="text-xs text-text-secondary">Loading variants…</p>
      )}
      {loadError !== null && <p className="text-xs text-status-error">{loadError}</p>}
      {actionError !== null && (
        <p role="alert" className="text-xs text-status-error" data-testid="variant-manager-error">
          {actionError}
        </p>
      )}

      {variants.length === 0 && !loading ? (
        <p className="text-xs text-text-tertiary">
          No variants yet — create one from the current definition to start A/B testing this workflow.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-text-tertiary" data-testid="variant-manager-rotation-cost-note">
            Rotation weight controls how often each active variant is picked for a normal launch — every
            rotation run still accrues its own eval/judge cost when auto-grading is on (Settings → Code
            Review Eval).
          </p>
          <div className="flex flex-col gap-1.5">
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
