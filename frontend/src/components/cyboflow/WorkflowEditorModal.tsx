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
 *   Save                — edit mode: opens the {@link SaveScopeDialog} (migration
 *                         030) — "Save globally" (`updateSpec` on the shared row,
 *                         the default) vs "Create a project-specific copy"
 *                         (`createCustom` with a chosen project, forking the
 *                         global flow). Disabled when not dirty.
 *   Save as new flow    — ask for a name (FlowNameDialog); `createCustom` then onSaved(newId).
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
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { WorkflowDefinition, PermissionMode } from '../../../../shared/types/workflows';
import { useWorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { WorkflowEditorCanvas } from './WorkflowEditorCanvas';
import { WorkflowStepInspector } from './WorkflowStepInspector';
import { FlowNameDialog } from './FlowNameDialog';
import { SaveScopeDialog, type SaveScopeProject, type SaveScopeChoice } from './SaveScopeDialog';
import { PHASE_COLORS } from './workflowEditorOptions';

export interface WorkflowEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workflow row to edit (edit mode). Ignored when mode === 'create'. */
  workflowId: string;
  /**
   * The project the run launches into ("Run with modifications") and the
   * fallback target for a project-scoped save. With globals (migration 030) this
   * is no longer the saved row's scope — a global flow's row carries
   * `project_id === null`; the Save-scope dialog (edit mode) decides where an
   * edit lands. Always non-null (the caller resolves a launch project).
   */
  projectId: number;
  /**
   * The gallery's active project filter (null = "All projects"). Drives the
   * Save-scope dialog's project-copy default: when a project is filtered the copy
   * targets it; in All-projects the dialog shows a project picker. Optional so
   * non-gallery callers (the wizard) default to no filter.
   */
  activeProjectFilter?: number | null;
  /**
   * Projects available as a fork target for "Create a project-specific copy"
   * (Save-scope dialog). Optional; defaults to the single `projectId` so the
   * project-copy path always has at least one target. Migration 030.
   */
  projects?: SaveScopeProject[];
  mode?: 'edit' | 'create';
  /** Called after a successful save / reset / create with the affected workflow id. */
  onSaved?: (workflowId: string) => void;
  /**
   * Optional seed for create mode — pre-populates the editor with this
   * definition instead of the blank skeleton (e.g. forking an existing flow).
   * Ignored in edit mode (the persisted row definition always wins).
   */
  initialDefinition?: WorkflowDefinition;
  /** Optional permission_mode seed for create mode (defaults to 'default'). */
  initialPermissionMode?: PermissionMode;
  /** Optional name seed for create mode; suffixed with '-copy' when present. */
  initialName?: string;
  /**
   * Scope for a brand-new flow (create mode, migration 030): `null` ⇒ GLOBAL
   * (`wf-global-custom-*`, the product default), an integer ⇒ a project-scoped
   * custom flow. Chosen in GalleryNew and threaded here. Defaults to `null`
   * (global) so a new flow is global unless the user scopes it; ignored in edit
   * mode (the Save-scope dialog owns the edit-mode scope decision).
   */
  createScopeProjectId?: number | null;
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
          agent: 'implement',
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
  activeProjectFilter = null,
  projects,
  mode = 'edit',
  onSaved,
  initialDefinition,
  initialPermissionMode,
  initialName,
  createScopeProjectId = null,
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
   * Scope of the SOURCE row (migration 030): null ⇒ a GLOBAL flow, an integer ⇒
   * project-scoped. Captured on seed (edit mode). Surfaced in the header so the
   * user knows whether a "Save globally" edit fans out to all projects, and used
   * to label the dialog. Defaults to null (no source row in create mode).
   */
  const [sourceProjectId, setSourceProjectId] = useState<number | null>(null);

  /**
   * The project's CUSTOM agent keys (bare, e.g. `my-helper`), surfaced in the
   * step inspector's agent picker so a custom-flow step can bind one without
   * free-typing its key. Fetched independently of the definition seed; a fetch
   * failure (or no customs) just yields an empty list — never a broken editor.
   * Scoped to the editor's `projectId` so a chosen key always has a matching
   * `cyboflow-<key>.md` overlay at runtime (a foreign-project key would
   * dispatch-fail). Built-ins ignore step bindings (they dispatch via prose), so
   * the list only takes effect in custom flows.
   */
  const [customAgentKeys, setCustomAgentKeys] = useState<string[]>([]);

  /**
   * Save-scope dialog (edit mode): chooses "Save globally" (updateSpec on the
   * row) vs "Create a project-specific copy" (createCustom with a target
   * project). Opened by handleSave instead of saving immediately.
   */
  const [saveScopeOpen, setSaveScopeOpen] = useState(false);

  /**
   * Synchronous in-flight latch shared by every mutating action (save / save-as-new
   * / reset / run). The `isBusy` STATE guard alone cannot stop a double-submit: two
   * clicks fired in the same tick both read the pre-update state and both pass, and
   * the `disabled` attribute only takes effect after the next render. A ref flips
   * synchronously, so the second invocation is rejected before it can fire a second
   * runs.start / createCustom. (Prevents the duplicate-run bug.)
   */
  const actionInFlightRef = useRef(false);

  /**
   * In-app name-entry dialog state. Replaces window.prompt() (unsupported in
   * Electron's renderer). `pendingAction` records which flow opened the dialog
   * so its onConfirm runs the matching downstream logic with the entered name.
   */
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'save-as-new' | 'run-with-modifications' | null>(null);

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
        setSourceProjectId(row.project_id);
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
      setSourcePermissionMode(initialPermissionMode ?? 'default');
      // A brand-new flow has no source row; its scope is decided by GalleryNew.
      setSourceProjectId(null);
      seed(initialDefinition ?? SKELETON_DEFINITION, initialName ? initialName + '-copy' : '');
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
  }, [isOpen, mode, workflowId, projectId, dispatch, initialDefinition, initialPermissionMode, initialName]);

  // ── Custom agent keys for the step picker ───────────────────────────────────
  // Independent of the definition seed: the picker can show custom options as
  // soon as agents.list resolves, regardless of which seed path ran.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await trpc.cyboflow.agents.list.query({ projectId });
        if (cancelled) return;
        setCustomAgentKeys(entries.filter((e) => e.isCustom).map((e) => e.agentKey));
      } catch {
        // A picker without custom options is acceptable; never block the editor.
        if (!cancelled) setCustomAgentKeys([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

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

  // Target scope for the name-dialog create paths (migration 030). Create mode
  // honors the GalleryNew scope (`createScopeProjectId`; null ⇒ global); edit
  // mode's "Save as new flow" keeps forking into the launch `projectId` (the
  // edit-mode global/project choice lives in the SaveScopeDialog instead).
  const saveAsNewTargetProjectId: number | null =
    mode === 'create' ? createScopeProjectId : projectId;

  // ── Persistence helpers ─────────────────────────────────────────────────────

  /** Save the working definition onto the existing workflow row (edit mode). */
  const saveEdit = useCallback(async (): Promise<string> => {
    await trpc.cyboflow.workflows.updateSpec.mutate({
      workflowId,
      definition: state.definition,
    });
    return workflowId;
  }, [workflowId, state.definition]);

  /**
   * Create a brand-new custom flow from the working definition. `targetProjectId`
   * picks the scope (migration 030): `null` ⇒ a GLOBAL custom flow
   * (`wf-global-custom-*`), an integer ⇒ a project-scoped copy
   * (`wf-<projectId>-custom-*`). Defaults to the `projectId` prop (the
   * "Save as new flow" / create-mode path keeps the launch project's scope).
   */
  const saveCustom = useCallback(
    async (name: string, targetProjectId: number | null = projectId): Promise<string> => {
      const row = await trpc.cyboflow.workflows.createCustom.mutate({
        projectId: targetProjectId,
        name,
        definition: state.definition,
        permissionMode: sourcePermissionMode,
      });
      return row.id;
    },
    [projectId, state.definition, sourcePermissionMode],
  );

  // ── Handlers ────────────────────────────────────────────────────────────────

  // Save presents the scope choice (migration 030): "Save globally" updates the
  // (global) row; "Create a project-specific copy" forks via createCustom. The
  // dialog opening is non-mutating, so it does NOT take the in-flight latch — the
  // latch is acquired only on the dialog's confirm (handleSaveScopeConfirm).
  const handleSave = useCallback(() => {
    if (!canSave || actionInFlightRef.current) return;
    setError(null);
    setSaveScopeOpen(true);
  }, [canSave]);

  /**
   * Resolve of the Save-scope dialog. 'global' updates the existing row in place
   * (the edit fans out to every project); 'project' forks the working definition
   * into a new project-scoped copy via createCustom, leaving the global row
   * intact. Each path owns the in-flight latch + busy lifecycle.
   */
  const handleSaveScopeConfirm = useCallback(
    async (choice: SaveScopeChoice) => {
      setSaveScopeOpen(false);
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setIsBusy(true);
      try {
        if (choice.scope === 'global') {
          const savedId = await saveEdit();
          // The row was edited in place — refresh the baseline so it is no longer
          // dirty and a re-save reopens the dialog cleanly.
          setBaseline({ definition: state.definition, name: state.name });
          setIsDirty(false);
          onSaved?.(savedId);
        } else {
          // Fork into a project-scoped copy. The fork ALWAYS takes a `-copy` name
          // (matching Duplicate / "Save as new"): the source is global, so reusing its
          // name would hit the reserved-built-in guard ('planner'…) or the
          // global-name-collision guard in createCustom. A residual collision (an
          // existing `<name>-copy` in that project) still surfaces the server CONFLICT.
          const newId = await saveCustom(`${state.name}-copy`, choice.projectId);
          onSaved?.(newId);
          onClose();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Save failed');
      } finally {
        setIsBusy(false);
        actionInFlightRef.current = false;
      }
    },
    [saveEdit, saveCustom, state.definition, state.name, onSaved, onClose],
  );

  // Opening the name dialog is non-mutating, so it does NOT take the in-flight
  // latch — the latch is acquired only once the user confirms a name (in the
  // dialog's onConfirm), and released in finally there. This keeps a cancelled
  // dialog from permanently blocking future actions.
  const handleSaveAsNew = useCallback(() => {
    if (actionInFlightRef.current) return;
    setError(null);
    setPendingAction('save-as-new');
    setNameDialogOpen(true);
  }, []);

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

  /**
   * Persist (via `persist`, which resolves the target workflow id) then start a
   * run against it. Acquires the in-flight latch synchronously and releases it
   * in finally, so both the edit-mode inline path and the create-mode dialog
   * confirm share one latch lifecycle.
   */
  const persistAndRun = useCallback(async (persist: () => Promise<string>) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      const targetWorkflowId = await persist();
      // Ensure the run executes INSIDE a session. forceNew: launching from the
      // blueprint editor is an explicit NEW run, not an "add a workflow to the
      // session I'm viewing", so it always gets a fresh session — never absorbs the
      // selected quick session (only in-session useLaunchWorkflow reuses).
      const sessionId = await ensureSessionForLaunch(projectId, { forceNew: true });
      const result = await trpc.cyboflow.runs.start.mutate({
        workflowId: targetWorkflowId,
        projectId,
        sessionId,
      });
      useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
      onSaved?.(targetWorkflowId);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not run with modifications');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [projectId, onSaved, onClose]);

  const handleRunWithModifications = useCallback(() => {
    if (actionInFlightRef.current) return;
    // Persist first. Edit mode updates the existing row ONLY when the graph was
    // actually modified — running an untouched built-in must not pin its
    // spec_json (which would freeze it from future WORKFLOW_DEFINITIONS updates).
    // Create mode requires a name, gathered via the in-app FlowNameDialog (the
    // latch is taken only on confirm, in persistAndRun).
    if (mode === 'edit') {
      void persistAndRun(async () => (isDirty ? await saveEdit() : workflowId));
    } else {
      setError(null);
      setPendingAction('run-with-modifications');
      setNameDialogOpen(true);
    }
  }, [mode, isDirty, workflowId, saveEdit, persistAndRun]);

  /**
   * Resolve of the FlowNameDialog: run the same downstream logic the
   * window.prompt() blocks used to, keyed by which action opened the dialog.
   * Each branch owns its own latch/busy lifecycle (save-as-new inline here;
   * run-with-modifications via persistAndRun).
   */
  const handleNameConfirm = useCallback(async (name: string) => {
    setNameDialogOpen(false);
    const action = pendingAction;
    setPendingAction(null);

    if (action === 'save-as-new') {
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setIsBusy(true);
      try {
        const newId = await saveCustom(name, saveAsNewTargetProjectId);
        onSaved?.(newId);
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not create the workflow');
      } finally {
        setIsBusy(false);
        actionInFlightRef.current = false;
      }
    } else if (action === 'run-with-modifications') {
      await persistAndRun(async () => await saveCustom(name, saveAsNewTargetProjectId));
    }
  }, [pendingAction, saveCustom, saveAsNewTargetProjectId, onSaved, onClose, persistAndRun]);

  // Cancelling the dialog must leave NO latch held and NO pending action, so the
  // next action can open cleanly. (The latch is never taken on open.)
  const handleNameDialogClose = useCallback(() => {
    setNameDialogOpen(false);
    setPendingAction(null);
  }, []);

  // ── Header title ─────────────────────────────────────────────────────────────
  const title = useMemo(() => {
    if (mode === 'create') return 'New workflow';
    return `Edit workflow · ${state.name || workflowId}`;
  }, [mode, state.name, workflowId]);

  // ── Save-scope dialog inputs (migration 030) ─────────────────────────────────
  // Projects the project-copy path can target. Falls back to the single launch
  // `projectId` when no explicit list is supplied so the copy path always has a
  // target (non-gallery callers like the wizard pass no list).
  const saveScopeProjects: SaveScopeProject[] = useMemo(
    () =>
      projects && projects.length > 0
        ? projects
        : [{ id: projectId, name: 'This project' }],
    [projects, projectId],
  );
  // Default copy target: the active gallery filter if set; else the lone
  // enumerated project; else null (All-projects with >1 project → force a pick).
  const saveScopeDefaultProjectId: number | null = useMemo(() => {
    if (activeProjectFilter !== null) return activeProjectFilter;
    if (saveScopeProjects.length === 1) return saveScopeProjects[0].id;
    return null;
  }, [activeProjectFilter, saveScopeProjects]);

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

          {/* Scope chip (edit mode, migration 030): a GLOBAL flow's edit fans out
              to every project, so flag it so "Save globally" is unsurprising. */}
          {mode === 'edit' && sourceProjectId === null && (
            <span
              className="rounded-badge border border-border-primary bg-bg-primary px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-text-tertiary"
              data-testid="editor-scope-chip"
            >
              Global
            </span>
          )}

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
            onClick={handleSaveAsNew}
            disabled={isBusy || isLoading}
            className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="editor-save-as-new-button"
          >
            Save as new flow
          </button>

          {mode === 'edit' && (
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="rounded-button bg-interactive px-3 py-1.5 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="editor-save-button"
            >
              Save
            </button>
          )}

          <button
            type="button"
            onClick={handleRunWithModifications}
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
                customAgentKeys={customAgentKeys}
              />
            </>
          )}
        </div>
      </div>

      <FlowNameDialog
        isOpen={nameDialogOpen}
        title="Name for the new workflow"
        // Create mode: the flow doesn't exist yet, so the name the user already
        // typed IS the name — no spurious `-copy`. Edit mode: "Save as new flow"
        // FORKS the current flow, so `-copy` avoids colliding with the original.
        // (A template-seeded create already carries its `-copy` from loadCreate.)
        defaultValue={mode === 'create' ? state.name : state.name ? `${state.name}-copy` : ''}
        confirmLabel={pendingAction === 'run-with-modifications' ? 'Run' : 'Create'}
        onConfirm={(name) => void handleNameConfirm(name)}
        onClose={handleNameDialogClose}
      />

      {/* Save-scope choice (edit mode, migration 030): Save globally vs project copy. */}
      <SaveScopeDialog
        isOpen={saveScopeOpen}
        projects={saveScopeProjects}
        defaultProjectId={saveScopeDefaultProjectId}
        onConfirm={(choice) => void handleSaveScopeConfirm(choice)}
        onClose={() => setSaveScopeOpen(false)}
      />
    </Modal>
  );
}
