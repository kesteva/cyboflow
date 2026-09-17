/**
 * WorkflowEditorModal — full-screen editor for a workflow, in TWO PAGES
 * (plan `docs/plans/workflow-tuning-levels.md` D3 / §4):
 *
 *   - `view: 'simple'`   — {@link WorkflowTuningPage}: the four-slot tuning dial
 *     (Efficient / Standard / Thorough / Custom) over a strip of what that level
 *     runs. The DEFAULT page for a BUILT-IN flow. A non-built-in ("save as new")
 *     flow has no built-in baseline to transform, so it has no dial and opens
 *     straight to advanced — zero change for those flows.
 *   - `view: 'advanced'` — the blueprint editor proper (canvas, inspector,
 *     agents, variants, A/B), unchanged, seeded from the CURRENTLY SELECTED
 *     level's effective definition so "start from Efficient and tweak" works.
 *
 * Level selection is one cheap `setTuningLevel` write that never touches
 * `spec_json` — `spec_json` is the CUSTOM slot, written only by the Advanced
 * page's "Overwrite this flow" save (which stamps `'custom'` server-side) and by
 * MCP `cyboflow_update_workflow`.
 *
 * Two modes:
 *   - 'edit'   — seed from `trpc.cyboflow.workflows.getDefinition.query({ workflowId })`.
 *   - 'create' — start from a minimal hardcoded custom skeleton (the
 *                built-in 'soloflow' template was removed in the 2-flow rework).
 *
 * Header actions:
 *   Cancel              — close without saving.
 *   Reset to default    — built-in flows only; `resetSpec` then close + onSaved.
 *   Save                — edit mode: opens the {@link SaveScopeDialog}, the
 *                         save-TARGET prompt — "Overwrite this flow"
 *                         (`updateSpec`, the default; server stamps
 *                         `tuning_level='custom'`), "Create a project-specific
 *                         copy" (`createCustom`, migration 030), "Save as new
 *                         flow", or "Save as new variant of this flow"
 *                         (`variants.create` carrying the edited graph, draft
 *                         status, base flow untouched). Disabled when not dirty,
 *                         so the prompt only appears for a real edit.
 *   Save as new flow    — ask for a name + (edit mode) a scope (FlowNameDialog,
 *                         TASK-220 — defaults to the source flow's own scope);
 *                         `createCustom` then `onSaved(newId, scopeNote)` so
 *                         the host can surface where the copy landed.
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
import { useConfigStore } from '../../stores/configStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { trackEvent } from '../../utils/telemetry';
import { hasCustomSpecSlot, isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import {
  resolveRunTypeLaunchDefaults,
  workflowRunTypeKey,
} from '../../../../shared/types/sessionDefaults';
import type { WorkflowDefinition, PermissionMode } from '../../../../shared/types/workflows';
import {
  DEFAULT_TUNING_LEVEL,
  resolveEffectiveDefinition,
  TUNING_LEVELS,
  type TuningLevel,
} from '../../../../shared/tuning/workflowTuning';
import {
  DEFAULT_RUNTIME_MIX,
  VERIFICATION_AGENT_KEYS,
  resolveEffectiveDefinitionWithMix,
  type RuntimeMix,
} from '../../../../shared/tuning/runtimeMix';
import type { AgentEntry, AgentRunTarget } from '../../../../shared/types/agents';
import { useWorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { WorkflowEditorCanvas } from './WorkflowEditorCanvas';
import { WorkflowStepInspector } from './WorkflowStepInspector';
import { FlowNameDialog } from './FlowNameDialog';
import { SaveScopeDialog, type SaveScopeProject, type SaveScopeChoice } from './SaveScopeDialog';
import { PHASE_COLORS } from './workflowEditorOptions';
import { VariantManagerSection } from './VariantManagerSection';
import { WorkflowTuningPage } from './WorkflowTuningPage';
import { ConfirmDialog } from '../ConfirmDialog';
import { useVariantsStore } from '../../stores/variantsStore';

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
  /**
   * Called after a successful save / reset / create with the affected workflow
   * id. The second argument, present ONLY for a "save as new flow" landing
   * (TASK-220), names where the new row landed ("Global" or a project name) —
   * hosts should surface it (toast/notice) so a project-scoped result is
   * never silent.
   */
  onSaved?: (workflowId: string, savedAsNewScopeNote?: string) => void;
  /**
   * Called after a persisted change that keeps the editor OPEN — a tuning-dial
   * stamp or a custom-slot delete. Hosts close the modal in `onSaved`, and a
   * dial click must not throw the user out of the editor, so these writes get
   * their own refresh-only channel.
   */
  onMutated?: (workflowId: string) => void;
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
  onMutated,
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
  /**
   * Non-error confirmation line (currently: "saved as draft variant '<label>'").
   * A separate slot from `error` so a success message never renders in the alert
   * role, and so neither clobbers the other.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  /** Which page is showing. Resolved on seed; see the module doc comment. */
  const [view, setView] = useState<'simple' | 'advanced'>('advanced');
  /** The workflow's stamped tuning level (edit mode); the dial's selection. */
  const [level, setLevel] = useState<TuningLevel>(DEFAULT_TUNING_LEVEL);
  /** The workflow's stamped runtime mix (edit mode); the second dial's selection. */
  const [runtimeMix, setRuntimeMix] = useState<RuntimeMix>(DEFAULT_RUNTIME_MIX);
  /**
   * The source row's `spec_json` — the CUSTOM slot. Kept so level switching can
   * re-derive the effective definition client-side (the same shared transform
   * the server resolves through) without a refetch per switch, and so
   * `hasCustomSpecSlot` can gate the CUSTOM segment.
   */
  const [sourceSpecJson, setSourceSpecJson] = useState<string | null>(null);
  /**
   * The source row's NAME, captured on seed. Distinct from `state.name`, which
   * the header input lets the user retype for a "save as new": the level
   * transforms are keyed by the BUILT-IN flow name, so resolving them off a
   * half-typed rename would silently fall back to the custom-flow path.
   */
  const [sourceName, setSourceName] = useState('');
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
   * The FULL effective agent catalogue (builtins + overrides + customs) for the
   * editor's `projectId`. Fetched independently of the definition seed; a fetch
   * failure just yields an empty list — never a broken editor. Two derived views
   * feed the editor: the CUSTOM agent keys surfaced in the step picker, and the
   * per-agent run targets (`agentRunTargets`) the canvas + inspector read to show
   * what each agent inherits. Scoped to `projectId` so a chosen custom key always
   * has a matching `cyboflow-<key>.md` overlay at runtime.
   */
  const [agentEntries, setAgentEntries] = useState<AgentEntry[]>([]);
  const customAgentKeys = useMemo(
    () => agentEntries.filter((e) => e.isCustom).map((e) => e.agentKey),
    [agentEntries],
  );
  // The canvas step cards fold runtime + model + providerModel into ONE run-target
  // label, so they need all three — a model-alias-only map rendered a non-Claude
  // pinned agent as "run model".
  const agentRunTargets = useMemo<Record<string, AgentRunTarget>>(
    () =>
      Object.fromEntries(
        agentEntries.map((e) => [
          e.agentKey,
          { runtime: e.runtime, model: e.model, providerModel: e.providerModel },
        ]),
      ),
    [agentEntries],
  );

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

  /** "Delete custom definition" confirmation (simple page). */
  const [deleteCustomOpen, setDeleteCustomOpen] = useState(false);

  const isBuiltIn = isCyboflowWorkflowName(state.name);
  /**
   * Does THIS row have a tuning dial? Keyed off the row's own name (not the
   * editable header field) and edit mode only — create mode has no row to stamp.
   */
  const hasTuningDial = mode === 'edit' && isCyboflowWorkflowName(sourceName);
  const hasCustomDefinition = hasCustomSpecSlot(sourceSpecJson);
  /**
   * Grey the runtime-mix dial's two cross-provider segments — the flow's
   * verification class (`VERIFICATION_AGENT_KEYS`) is empty, so
   * `claude-primary`/`codex-primary` would route nothing.
   */
  const mixedRuntimeDisabled = isCyboflowWorkflowName(sourceName)
    ? VERIFICATION_AGENT_KEYS[sourceName].size === 0
    : false;

  /**
   * Per-level token estimates for the simple page's dial (plan D8), fetched
   * once per (open, workflowId) while the workflow has a tuning dial. A fetch
   * failure or a flow with no dial just leaves this empty — the static
   * multiplier tags in {@link TuningLevelSelector} already render regardless
   * (fail-soft: no labels, never a broken editor).
   */
  const [estimateLabels, setEstimateLabels] = useState<Partial<Record<TuningLevel, string>>>({});
  useEffect(() => {
    if (!isOpen || !hasTuningDial) {
      setEstimateLabels({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const estimates = await trpc.cyboflow.insights.tuningLevelUsage.query({ workflowId });
        if (cancelled) return;
        const labels: Partial<Record<TuningLevel, string>> = {};
        // MEASURED medians only: the pooled-multiplier and static fallbacks are
        // invented numbers, and showing them read as real data. A level's line
        // appears once ≥3 completed runs at that level back it.
        for (const tuningLevel of TUNING_LEVELS) {
          if (estimates[tuningLevel].source === 'measured') {
            labels[tuningLevel] = estimates[tuningLevel].label;
          }
        }
        setEstimateLabels(labels);
      } catch {
        if (!cancelled) setEstimateLabels({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, hasTuningDial, workflowId]);

  // ── Seed on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setNotice(null);
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
        setSourceName(row.name);
        setSourceSpecJson(row.spec_json);
        setLevel(row.tuning_level);
        setRuntimeMix(row.runtime_mix);
        // A built-in opens on the dial; a custom flow has no dial and lands on
        // the blueprint editor exactly as it always has.
        setView(isCyboflowWorkflowName(row.name) ? 'simple' : 'advanced');
        // `getDefinition` already returns the STAMPED level's effective graph,
        // so the canvas baseline agrees with the dial without a second resolve.
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
      // No row ⇒ no custom slot and no level stamp; create mode has no dial.
      setSourceName('');
      setSourceSpecJson(null);
      setLevel(DEFAULT_TUNING_LEVEL);
      setRuntimeMix(DEFAULT_RUNTIME_MIX);
      setView('advanced');
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
        setAgentEntries(entries);
      } catch {
        // A picker without custom options is acceptable; never block the editor.
        if (!cancelled) setAgentEntries([]);
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

  // Target scope for the name-dialog's CREATE-MODE paths (migration 030):
  // "Save as new flow" (the flow doesn't exist yet) and "Run with
  // modifications" both honor the scope already chosen in GalleryNew
  // (`createScopeProjectId`; null ⇒ global). Edit mode's "Save as new flow"
  // no longer reads this — it collects its OWN scope via the name dialog's
  // selector (TASK-220), defaulting to the source flow's own scope
  // (`sourceProjectId`); see `handleNameConfirm`.
  const saveAsNewTargetProjectId: number | null = createScopeProjectId;

  // Projects the project-copy path (SaveScopeDialog) AND the edit-mode
  // "Save as new flow" scope selector (name dialog, TASK-220) can target.
  // Falls back to the single launch `projectId` when no explicit list is
  // supplied so the copy path always has a target (non-gallery callers like
  // the wizard pass no list). Declared here (ahead of `handleNameConfirm`,
  // which reads it to label where a save-as-new landed) rather than down by
  // the SaveScopeDialog JSX where it used to live.
  const saveScopeProjects: SaveScopeProject[] = useMemo(
    () =>
      projects && projects.length > 0
        ? projects
        : [{ id: projectId, name: 'This project' }],
    [projects, projectId],
  );

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

  // ── Tuning levels (the simple page) ─────────────────────────────────────────

  /**
   * The SELECTED level's effective definition, ROUTED through the selected
   * runtime mix — what the phase strip renders. Derived through the SHARED
   * transform, never hand-maintained: a preset level resolves
   * `applyTuningPreset(builtin, …)`, `'custom'` resolves the slot, then the mix
   * overlays its provider routing (mix-free when `runtimeMix === 'claude'`).
   * Null only for an unresolvable custom flow, which the strip states plainly.
   * This memo feeds ONLY the simple page's phase strip — `baselineDefinition`
   * and `reseedFromLevel` stay mix-free by design (plan D1).
   */
  const effectiveDefinition = useMemo(
    () => resolveEffectiveDefinitionWithMix(sourceName, sourceSpecJson, level, runtimeMix),
    [sourceName, sourceSpecJson, level, runtimeMix],
  );

  /**
   * The Standard (as-authored) definition of the SAME flow — the baseline the
   * phase strip diffs against, so a preset's removed steps render struck-through
   * instead of vanishing. Level-independent by construction: it is what the flow
   * runs when the dial has never been moved.
   */
  const baselineDefinition = useMemo(
    () => resolveEffectiveDefinition(sourceName, sourceSpecJson, 'standard'),
    [sourceName, sourceSpecJson],
  );

  /**
   * Re-seed the Advanced canvas from a level's effective definition, so opening
   * Advanced after switching the dial starts from THAT level's graph ("start
   * from Efficient and tweak"). Derived client-side from the same shared
   * transform the server resolves through, because the dial can move without a
   * refetch. Also resets the baseline: dirty means "differs from the level I
   * started from", not "differs from the level that was stamped when I opened".
   */
  const reseedFromLevel = useCallback(
    (next: TuningLevel) => {
      const definition = resolveEffectiveDefinition(sourceName, sourceSpecJson, next);
      if (definition === null) return;
      dispatch({ type: 'SET_DEFINITION', definition, name: state.name });
      setBaseline({ definition, name: state.name });
      setIsDirty(false);
    },
    [sourceName, sourceSpecJson, state.name, dispatch],
  );

  /** Stamp a new level (one cheap write; `spec_json` is never touched). */
  const handleSelectLevel = useCallback(
    async (next: TuningLevel) => {
      if (next === level || actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setNotice(null);
      setIsBusy(true);
      try {
        await trpc.cyboflow.workflows.setTuningLevel.mutate({ workflowId, level: next });
        setLevel(next);
        reseedFromLevel(next);
        // onMutated, not onSaved: hosts close the modal in onSaved, and a dial
        // click must leave the user on the page they are dialing.
        onMutated?.(workflowId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not change the tuning level');
      } finally {
        setIsBusy(false);
        actionInFlightRef.current = false;
      }
    },
    [level, workflowId, reseedFromLevel, onMutated],
  );

  /**
   * Stamp a new runtime mix (one cheap write). Deliberately does NOT call
   * `reseedFromLevel` — the mix must never touch the Advanced canvas: every
   * persisted-read seam (including the Advanced editor's own seed) stays
   * mix-free by design, so a mix flip changes only the stamp and the simple
   * page's preview strip (plan `docs/plans/workflow-runtime-mix.md` D1).
   */
  const handleSelectRuntimeMix = useCallback(
    async (next: RuntimeMix) => {
      if (next === runtimeMix || actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setNotice(null);
      setIsBusy(true);
      try {
        await trpc.cyboflow.workflows.setRuntimeMix.mutate({ workflowId, mix: next });
        setRuntimeMix(next);
        onMutated?.(workflowId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not change the runtime mix');
      } finally {
        setIsBusy(false);
        actionInFlightRef.current = false;
      }
    },
    [runtimeMix, workflowId, onMutated],
  );

  /**
   * "Delete custom definition" — `resetSpec` clears the slot AND flips a
   * `'custom'` stamp back to `'standard'` in the same transaction (an empty slot
   * has nothing for Custom to select), so the local state mirrors both halves.
   * Unlike the header's "Reset to default" this stays on the page: the user is
   * managing the flow's levels, not leaving.
   */
  const handleDeleteCustom = useCallback(async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setNotice(null);
    setIsBusy(true);
    try {
      await trpc.cyboflow.workflows.resetSpec.mutate({ workflowId });
      setSourceSpecJson(null);
      const nextLevel: TuningLevel = level === 'custom' ? 'standard' : level;
      setLevel(nextLevel);
      reseedFromLevel(nextLevel);
      // onMutated, not onSaved — this action deliberately stays on the page.
      onMutated?.(workflowId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the custom definition');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [workflowId, level, reseedFromLevel, onMutated]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  /**
   * Pre-save guard: the zod write path (workflowDefinitionSchema) rejects a
   * workflow-copy agent whose `custom.systemPrompt` is empty, but the editor lets
   * the user blank it — so Save would otherwise surface a raw TRPCClientError zod
   * blob. Scan `agentConfigs` for the first offending copy and, if found, surface a
   * human message naming the agent + return true so the caller aborts the save.
   */
  const blockOnEmptyWorkflowPrompt = useCallback((): boolean => {
    const configs = state.definition.agentConfigs;
    if (configs === undefined) return false;
    for (const [agentKey, config] of Object.entries(configs)) {
      if (config.custom !== undefined && config.custom.systemPrompt.trim().length === 0) {
        setError(
          `Workflow copy of agent "${agentKey}" has an empty system prompt — fill it in or revert to predefined.`,
        );
        return true;
      }
    }
    return false;
  }, [state.definition]);

  // Save presents the save-TARGET choice: overwrite this flow / project copy /
  // new flow / new draft variant. The dialog opening is non-mutating, so it does
  // NOT take the in-flight latch — the latch is acquired only on the dialog's
  // confirm (handleSaveScopeConfirm). `canSave` gates on `isDirty`, so an
  // unchanged graph never raises the prompt.
  const handleSave = useCallback(() => {
    if (!canSave || actionInFlightRef.current) return;
    if (blockOnEmptyWorkflowPrompt()) return;
    setError(null);
    setNotice(null);
    setSaveScopeOpen(true);
  }, [canSave, blockOnEmptyWorkflowPrompt]);

  /**
   * Resolve of the save-target dialog. Each path owns the in-flight latch + busy
   * lifecycle:
   *   'global'      — write the edited graph into the flow's CUSTOM slot
   *                   (`updateSpec`, which stamps `tuning_level='custom'`), then
   *                   return to the simple page with CUSTOM selected.
   *   'project'     — fork into a new project-scoped copy via createCustom,
   *                   leaving the source row intact (migration 030).
   *   'new-flow'    — hand off to the name dialog + the existing createCustom
   *                   "save as new" path, unchanged.
   *   'new-variant' — freeze the edited graph as a DRAFT variant; the base flow
   *                   and its level stamp are untouched, so the editor stays
   *                   dirty (nothing was saved TO the flow) and stays put.
   */
  const handleSaveScopeConfirm = useCallback(
    async (choice: SaveScopeChoice) => {
      setSaveScopeOpen(false);
      if (choice.scope === 'new-flow') {
        // Same downstream path as the header's "Save as new flow": collect a
        // name, then createCustom. The latch is taken on the name confirm.
        setPendingAction('save-as-new');
        setNameDialogOpen(true);
        return;
      }
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setIsBusy(true);
      try {
        if (choice.scope === 'new-variant') {
          await trpc.cyboflow.variants.create.mutate({
            workflowId,
            label: choice.label,
            definition: state.definition,
          });
          useVariantsStore.getState().invalidate(workflowId);
          setNotice(
            `Saved as draft variant “${choice.label}” — opt it into rotation from the variant manager.`,
          );
        } else if (choice.scope === 'global') {
          const savedId = await saveEdit();
          trackEvent('workflow_saved', { scope: 'global' });
          // The row was edited in place — refresh the baseline so it is no longer
          // dirty and a re-save reopens the dialog cleanly.
          setBaseline({ definition: state.definition, name: state.name });
          setIsDirty(false);
          // The slot now holds this graph and the server stamped 'custom'.
          setSourceSpecJson(JSON.stringify(state.definition));
          if (hasTuningDial) {
            setLevel('custom');
            setView('simple');
          }
          onSaved?.(savedId);
        } else {
          // Fork into a project-scoped copy. The fork ALWAYS takes a `-copy` name
          // (matching Duplicate / "Save as new"): the source is global, so reusing its
          // name would hit the reserved-built-in guard ('planner'…) or the
          // global-name-collision guard in createCustom. A residual collision (an
          // existing `<name>-copy` in that project) still surfaces the server CONFLICT.
          const newId = await saveCustom(`${state.name}-copy`, choice.projectId);
          trackEvent('workflow_saved', { scope: 'project' });
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
    [saveEdit, saveCustom, state.definition, state.name, workflowId, hasTuningDial, onSaved, onClose],
  );

  // Opening the name dialog is non-mutating, so it does NOT take the in-flight
  // latch — the latch is acquired only once the user confirms a name (in the
  // dialog's onConfirm), and released in finally there. This keeps a cancelled
  // dialog from permanently blocking future actions.
  const handleSaveAsNew = useCallback(() => {
    if (actionInFlightRef.current) return;
    if (blockOnEmptyWorkflowPrompt()) return;
    setError(null);
    setPendingAction('save-as-new');
    setNameDialogOpen(true);
  }, [blockOnEmptyWorkflowPrompt]);

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
      // "Run with modifications" re-runs the ACTIVE run's edited workflow in place,
      // so it REUSES the active session (no forceNew) — it is the "iterate on the
      // run I'm viewing" path, not an explicit new-session launch.
      const sessionId = await ensureSessionForLaunch(projectId);
      // Resolved AFTER persist(), since a brand-new custom flow's id isn't known
      // until persist() mints it. Routed through THE canonical launch-defaults
      // chokepoint (stored `workflow:<id>` → the user's GLOBAL launch model →
      // DEFAULT_WORKFLOW_MODEL) exactly like every other launch seam — reading
      // runTypeDefaults by hand skipped the global rung, so a user with
      // `defaultLaunchModel` set silently got Opus from this button alone. A
      // miss (fresh id absent from runTypeDefaults) still falls through the same
      // ladder — no attempt to chase down a "parent" workflow's stored default.
      // `defaultLaunchModel` is trimmed/blank ⇒ unset, matching main's
      // configManager.getDefaultLaunchModel and useLaunchWorkflow.
      const config = useConfigStore.getState().config;
      const { model } = resolveRunTypeLaunchDefaults(
        workflowRunTypeKey(targetWorkflowId),
        config?.runTypeDefaults,
        { model: config?.defaultLaunchModel?.trim() || undefined },
      );
      const result = await trpc.cyboflow.runs.start.mutate({
        workflowId: targetWorkflowId,
        projectId,
        sessionId,
        model,
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
    if (blockOnEmptyWorkflowPrompt()) return;
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
  }, [mode, isDirty, workflowId, saveEdit, persistAndRun, blockOnEmptyWorkflowPrompt]);

  /**
   * Resolve of the FlowNameDialog: run the same downstream logic the
   * window.prompt() blocks used to, keyed by which action opened the dialog.
   * Each branch owns its own latch/busy lifecycle (save-as-new inline here;
   * run-with-modifications via persistAndRun).
   */
  const handleNameConfirm = useCallback(async (name: string, scopeProjectId: number | null) => {
    const action = pendingAction;

    if (action === 'save-as-new') {
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setIsBusy(true);
      try {
        // Edit mode: the name dialog's own scope selector decides the target
        // (default = the source flow's own scope). Create mode: the scope was
        // already chosen in GalleryNew (createScopeProjectId), so the dialog
        // shows no selector and `scopeProjectId` is always null — fall back to
        // `saveAsNewTargetProjectId` (TASK-220).
        const targetProjectId = mode === 'edit' ? scopeProjectId : saveAsNewTargetProjectId;
        const newId = await saveCustom(name, targetProjectId);
        trackEvent('workflow_saved', { scope: targetProjectId !== null ? 'project' : 'global' });
        const scopeLabel =
          targetProjectId === null
            ? 'Global'
            : (saveScopeProjects.find((p) => p.id === targetProjectId)?.name ?? `project ${targetProjectId}`);
        // Only close the dialog / clear the pending action on SUCCESS — a
        // failed save-as-new (reserved-name guard, name collision, network
        // blip) must leave the dialog open with the user's typed name and
        // chosen scope intact so they can correct and resubmit without
        // retyping from scratch.
        setNameDialogOpen(false);
        setPendingAction(null);
        onSaved?.(newId, `Saved “${name}” as a new flow (${scopeLabel}).`);
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not create the workflow');
      } finally {
        setIsBusy(false);
        actionInFlightRef.current = false;
      }
    } else if (action === 'run-with-modifications') {
      setNameDialogOpen(false);
      setPendingAction(null);
      await persistAndRun(async () => await saveCustom(name, saveAsNewTargetProjectId));
    }
  }, [pendingAction, saveCustom, saveAsNewTargetProjectId, mode, saveScopeProjects, onSaved, onClose, persistAndRun]);

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
          {/* Back nav to the dial — only where there IS a dial to go back to. */}
          {hasTuningDial && view === 'advanced' && (
            <button
              type="button"
              onClick={() => setView('simple')}
              className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-hover"
              data-testid="editor-back-to-tuning"
            >
              ← Tuning level
            </button>
          )}

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

          {/* Which rung of the dial this flow currently runs at — visible from
              the Advanced page too, where the dial itself is off screen. */}
          {hasTuningDial && (
            <span
              className="px-2 py-0.5 text-[9px] font-bold uppercase"
              style={{
                letterSpacing: '0.14em',
                border: `1px solid ${level === 'custom' ? 'var(--color-status-info)' : 'var(--color-text-primary)'}`,
                color: level === 'custom' ? 'var(--color-status-info)' : 'var(--color-text-primary)',
                background: 'var(--color-surface-primary)',
              }}
              data-testid="tuning-level-badge"
            >
              Level: {level}
            </span>
          )}

          <div className="flex-1" />

          {/* Graph-editing actions belong to the Advanced page. The simple page
              cannot make an edit, and carries its own "Delete custom definition"
              in place of the generic reset. */}
          {isBuiltIn && mode === 'edit' && view === 'advanced' && (
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

          {view === 'advanced' && (
            <button
              type="button"
              onClick={handleSaveAsNew}
              disabled={isBusy || isLoading}
              className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="editor-save-as-new-button"
            >
              Save as new flow
            </button>
          )}

          {mode === 'edit' && view === 'advanced' && (
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

        {/* ── Inline confirmation (non-error) ─────────────────────────────── */}
        {notice !== null && (
          <div
            role="status"
            className="px-4 py-2 text-xs text-text-secondary border-b border-border-primary"
            style={{ background: 'var(--color-bg-secondary)', flexShrink: 0 }}
            data-testid="editor-notice"
          >
            {notice}
          </div>
        )}

        {/* ── Body — the tuning dial, or the blueprint editor ─────────────── */}
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-xs text-text-secondary">Loading workflow…</p>
          </div>
        ) : view === 'simple' ? (
          <WorkflowTuningPage
            level={level}
            hasCustomDefinition={hasCustomDefinition}
            definition={effectiveDefinition}
            baselineDefinition={baselineDefinition}
            agentRunTargets={agentRunTargets}
            runtimeMix={runtimeMix}
            mixedRuntimeDisabled={mixedRuntimeDisabled}
            busy={isBusy}
            onSelectLevel={(next) => void handleSelectLevel(next)}
            onOpenAdvanced={() => setView('advanced')}
            onDeleteCustom={() => setDeleteCustomOpen(true)}
            onSelectRuntimeMix={(next) => void handleSelectRuntimeMix(next)}
            estimateLabels={estimateLabels}
          />
        ) : (
          <>
            <div className="flex flex-row flex-1 overflow-hidden">
              <WorkflowEditorCanvas
                definition={state.definition}
                selectedStepId={state.selectedStepId}
                selectedFanOutInner={state.selectedFanOutInner}
                dispatch={dispatch}
                agentRunTargets={agentRunTargets}
              />
              <WorkflowStepInspector
                definition={state.definition}
                selectedStepId={state.selectedStepId}
                selectedFanOutInner={state.selectedFanOutInner}
                dispatch={dispatch}
                customAgentKeys={customAgentKeys}
                agentEntries={agentEntries}
              />
            </div>

            {/* Variant management (migration 048 / workflow A/B testing) — a variant
                always snapshots an EXISTING workflow row, so this is edit-mode only. */}
            {mode === 'edit' && (
              <VariantManagerSection
                workflowId={workflowId}
                projectId={projectId}
                // Variants are level-scoped (migration 126): the panel manages
                // the page the dial is on. A flow without a dial has no levels,
                // and its whole variant set lives in the one NULL-level pool.
                tuningLevel={hasTuningDial ? level : null}
                editorDirty={isDirty}
              />
            )}
          </>
        )}
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
        // Edit-mode "Save as new flow" offers a Global/project scope choice
        // (TASK-220), defaulting to the SOURCE flow's own scope — a global
        // built-in forks to a global copy by default, matching Duplicate.
        // Create mode's name prompt ("Run with modifications") needs no
        // selector: its scope was already chosen in GalleryNew.
        scopeProjects={mode === 'edit' ? saveScopeProjects : undefined}
        defaultScopeProjectId={sourceProjectId}
        onConfirm={(name, scopeProjectId) => void handleNameConfirm(name, scopeProjectId)}
        onClose={handleNameDialogClose}
      />

      {/* Save-target choice (edit mode): overwrite / project copy / new flow /
          new draft variant. */}
      <SaveScopeDialog
        isOpen={saveScopeOpen}
        projects={saveScopeProjects}
        defaultProjectId={saveScopeDefaultProjectId}
        hasCustomDefinition={hasCustomDefinition}
        onConfirm={(choice) => void handleSaveScopeConfirm(choice)}
        onClose={() => setSaveScopeOpen(false)}
      />

      {deleteCustomOpen && (
        <div data-testid="tuning-delete-custom-confirm">
          <ConfirmDialog
            isOpen
            onClose={() => setDeleteCustomOpen(false)}
            onConfirm={() => void handleDeleteCustom()}
            title="Delete custom definition?"
            message={
              'This clears the flow’s Custom slot and selects Standard. ' +
              'Preset levels are unaffected, and past runs keep the spec they froze.'
            }
            confirmText="Delete"
            cancelText="Cancel"
          />
        </div>
      )}
    </Modal>
  );
}
