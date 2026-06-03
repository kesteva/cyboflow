/**
 * WorkflowEditorModal — full-screen blueprint editor for a workflow's
 * phase/step graph.
 *
 * Two modes:
 *   - 'edit'   — seed from `trpc.cyboflow.workflows.getDefinition.query({ workflowId })`.
 *   - 'create' — start from a minimal hardcoded custom skeleton (the
 *                built-in 'soloflow' template was removed in the 2-flow rework).
 *
 * Header actions:
 *   Cancel              — close without saving.
 *   Reset to default    — built-in flows only; `resetSpec` then close + onSaved.
 *   Save                — edit mode: `updateSpec`; disabled when not dirty.
 *   Save as new flow    — prompt for a name; `createCustom` then onSaved(newId).
 *   Run with modifications — persist (updateSpec OR createCustom) then
 *                            `runs.start`, set the active run, close.
 *
 * Server-side zod validation (workflowDefinitionSchema) is authoritative; its
 * TRPCError messages are surfaced inline (no console.error swallow).
 *
 * FEATURE: user-editable workflow blueprint editor.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { WorkflowDefinition, PermissionMode } from '../../../../shared/types/workflows';
import { useWorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { WorkflowEditorCanvas } from './WorkflowEditorCanvas';
import { WorkflowStepInspector } from './WorkflowStepInspector';
import { PHASE_COLORS } from './workflowEditorOptions';

export interface WorkflowEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workflow row to edit (edit mode). Ignored when mode === 'create'. */
  workflowId: string;
  projectId: number;
  mode?: 'edit' | 'create';
  /** Called after a successful save / reset / create with the affected workflow id. */
  onSaved?: (workflowId: string) => void;
}

/** Minimal skeleton seeded for a brand-new custom flow (create mode). */
const SKELETON_DEFINITION: WorkflowDefinition = {
  id: 'custom',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: PHASE_COLORS[0],
      steps: [
        {
          id: 'step-1',
          name: 'New step',
          agent: 'executor',
          mcps: [],
          retries: 0,
        },
      ],
    },
  ],
};

export function WorkflowEditorModal({
  isOpen,
  onClose,
  workflowId,
  projectId,
  mode = 'edit',
  onSaved,
}: WorkflowEditorModalProps) {
  // Editor reducer — seeded with the skeleton, re-seeded once the fetch resolves.
  const { state, dispatch } = useWorkflowEditorState(SKELETON_DEFINITION, '');

  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  /** Snapshot of the loaded definition+name, to compute dirty state + reset. */
  const [baseline, setBaseline] = useState<{ definition: WorkflowDefinition; name: string } | null>(null);
  /**
   * permission_mode of the SOURCE row, forwarded to createCustom so a forked
   * flow inherits its parent's approval policy instead of silently resetting to
   * 'default'. Set during seed; defaults to 'default' when no source row exists.
   */
  const [sourcePermissionMode, setSourcePermissionMode] = useState<PermissionMode>('default');

  /**
   * Synchronous in-flight latch shared by every mutating action (save / save-as-new
   * / reset / run). The `isBusy` STATE guard alone cannot stop a double-submit: two
   * clicks fired in the same tick both read the pre-update state and both pass, and
   * the `disabled` attribute only takes effect after the next render. A ref flips
   * synchronously, so the second invocation is rejected before it can fire a second
   * runs.start / createCustom. (Prevents the duplicate-run bug.)
   */
  const actionInFlightRef = useRef(false);

  const isBuiltIn = isCyboflowWorkflowName(state.name);

  // ── Seed on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setIsDirty(false);

    const seed = (definition: WorkflowDefinition, name: string) => {
      if (cancelled) return;
      dispatch({ type: 'SET_DEFINITION', definition, name });
      setBaseline({ definition, name });
      setIsLoading(false);
    };

    const loadEdit = async () => {
      try {
        const [definition, row] = await Promise.all([
          trpc.cyboflow.workflows.getDefinition.query({ workflowId }),
          trpc.cyboflow.workflows.get.query({ workflowId }),
        ]);
        if (cancelled) return;
        setSourcePermissionMode(row.permission_mode);
        seed(definition, row.name);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load workflow definition');
        setIsLoading(false);
      }
    };

    const loadCreate = () => {
      // A brand-new custom flow starts from a minimal hardcoded skeleton. The
      // built-in 'soloflow' template that create mode used to clone was removed
      // in the 2-flow rework; users build their custom graph from scratch (or
      // edit a built-in via 'edit' mode). A forked flow inherits no source row,
      // so the permission mode defaults to 'default'.
      setSourcePermissionMode('default');
      seed(SKELETON_DEFINITION, '');
    };

    if (mode === 'create') {
      loadCreate();
    } else {
      void loadEdit();
    }

    return () => {
      cancelled = true;
    };
    // Re-seed whenever the modal opens or its target changes.
  }, [isOpen, mode, workflowId, projectId, dispatch]);

  // ── Dirty tracking ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (baseline === null) return;
    const dirty =
      state.name !== baseline.name ||
      JSON.stringify(state.definition) !== JSON.stringify(baseline.definition);
    setIsDirty(dirty);
  }, [state.definition, state.name, baseline]);

  // In create mode, Save (updateSpec on an existing row) is meaningless — there
  // is no row yet. Saving a brand-new flow always goes through "Save as new".
  const canSave = mode === 'edit' && isDirty && !isBusy && !isLoading;

  // ── Persistence helpers ─────────────────────────────────────────────────────

  /** Save the working definition onto the existing workflow row (edit mode). */
  const saveEdit = useCallback(async (): Promise<string> => {
    await trpc.cyboflow.workflows.updateSpec.mutate({
      workflowId,
      definition: state.definition,
    });
    return workflowId;
  }, [workflowId, state.definition]);

  /** Create a brand-new custom flow from the working definition. */
  const saveCustom = useCallback(async (name: string): Promise<string> => {
    const row = await trpc.cyboflow.workflows.createCustom.mutate({
      projectId,
      name,
      definition: state.definition,
      permissionMode: sourcePermissionMode,
    });
    return row.id;
  }, [projectId, state.definition, sourcePermissionMode]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!canSave || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      const savedId = await saveEdit();
      setBaseline({ definition: state.definition, name: state.name });
      setIsDirty(false);
      onSaved?.(savedId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [canSave, saveEdit, state.definition, state.name, onSaved]);

  const handleSaveAsNew = useCallback(async () => {
    const name = window.prompt('Name for the new workflow:', state.name ? `${state.name}-copy` : '');
    if (name === null) return; // cancelled
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('A workflow name is required.');
      return;
    }
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      const newId = await saveCustom(trimmed);
      onSaved?.(newId);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the workflow');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [state.name, saveCustom, onSaved, onClose]);

  const handleReset = useCallback(async () => {
    if (!isBuiltIn || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      await trpc.cyboflow.workflows.resetSpec.mutate({ workflowId });
      onSaved?.(workflowId);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [isBuiltIn, workflowId, onSaved, onClose]);

  const handleRunWithModifications = useCallback(async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      // Persist first. Edit mode updates the existing row ONLY when the graph was
      // actually modified — running an untouched built-in must not pin its
      // spec_json (which would freeze it from future WORKFLOW_DEFINITIONS updates).
      // Create mode requires a name via "save as new".
      let targetWorkflowId: string;
      if (mode === 'edit') {
        targetWorkflowId = isDirty ? await saveEdit() : workflowId;
      } else {
        const name = window.prompt('Name for the new workflow:', state.name ? `${state.name}-copy` : '');
        if (name === null) {
          setIsBusy(false);
          return;
        }
        const trimmed = name.trim();
        if (trimmed.length === 0) {
          setError('A workflow name is required.');
          setIsBusy(false);
          return;
        }
        targetWorkflowId = await saveCustom(trimmed);
      }

      const result = await trpc.cyboflow.runs.start.mutate({
        workflowId: targetWorkflowId,
        projectId,
      });
      useCyboflowStore.getState().setActiveRun(result.runId);
      onSaved?.(targetWorkflowId);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not run with modifications');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [mode, isDirty, workflowId, saveEdit, saveCustom, state.name, projectId, onSaved, onClose]);

  // ── Header title ─────────────────────────────────────────────────────────────
  const title = useMemo(() => {
    if (mode === 'create') return 'New workflow';
    return `Edit workflow · ${state.name || workflowId}`;
  }, [mode, state.name, workflowId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" showCloseButton={false}>
      <div
        className="flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        data-testid="workflow-editor-modal"
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b border-border-primary"
          style={{ background: 'var(--color-bg-secondary)', flexShrink: 0 }}
        >
          <h2 className="text-sm font-semibold text-text-primary" style={{ letterSpacing: '0.04em' }}>
            {title}
          </h2>

          {/* Name editor (always editable — drives "save as new" + custom-flow rename intent) */}
          <input
            type="text"
            value={state.name}
            onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
            placeholder="flow name"
            aria-label="Workflow name"
            className="rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary"
            style={{ width: 180 }}
            data-testid="editor-name-input"
          />

          <div className="flex-1" />

          {isBuiltIn && mode === 'edit' && (
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={isBusy}
              className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="editor-reset-button"
            >
              Reset to default
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleSaveAsNew()}
            disabled={isBusy || isLoading}
            className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="editor-save-as-new-button"
          >
            Save as new flow
          </button>

          {mode === 'edit' && (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="rounded-button bg-interactive px-3 py-1.5 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="editor-save-button"
            >
              Save
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleRunWithModifications()}
            disabled={isBusy || isLoading}
            className="rounded-button bg-interactive px-3 py-1.5 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="editor-run-button"
          >
            Run with modifications
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="editor-cancel-button"
          >
            Cancel
          </button>
        </div>

        {/* ── Inline error ────────────────────────────────────────────────── */}
        {error !== null && (
          <div
            role="alert"
            className="px-4 py-2 text-xs text-status-error border-b border-border-primary"
            style={{ background: 'var(--color-bg-secondary)', flexShrink: 0 }}
            data-testid="editor-error"
          >
            {error}
          </div>
        )}

        {/* ── Body — canvas + inspector ───────────────────────────────────── */}
        <div className="flex flex-row flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-xs text-text-secondary">Loading workflow…</p>
            </div>
          ) : (
            <>
              <WorkflowEditorCanvas
                definition={state.definition}
                selectedStepId={state.selectedStepId}
                dispatch={dispatch}
              />
              <WorkflowStepInspector
                definition={state.definition}
                selectedStepId={state.selectedStepId}
                dispatch={dispatch}
              />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
