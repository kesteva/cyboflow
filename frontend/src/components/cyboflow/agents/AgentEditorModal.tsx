/**
 * AgentEditorModal — full-window editor for one agent (builtin, builtin-with-
 * override, or custom). Sibling of WorkflowEditorModal; shares its chrome
 * (ink/paper title bar, full-screen Modal, in-flight latch, dirty-close guard).
 *
 * Modes:
 *   - 'edit'   — seed an existing agent via agents.get; Save persists an override
 *                via agents.upsertOverride (builtins) or a custom update.
 *   - 'create' — seed from agents.get of the source key (the catalogue opens
 *                create on a duplicate target); the name is editable.
 *
 * Header actions:
 *   Duplicate         — name dialog → agents.duplicate → onSaved(newKey).
 *   Cancel            — close (dirty guard).
 *   Save              — agents.upsertOverride; disabled until a field changes.
 *   Reset to default  — shown ONLY for an overridden built-in (isOverridden &&
 *                       !isCustom); agents.resetOverride → re-seed + clear dirty.
 *
 * Agents are MODEL-AGNOSTIC: there is no model picker; the model shows only as a
 * read-only Stats value. The system-prompt textarea has NO {{var}} chips.
 *
 * This modal is NOT wired into WorkflowsView here (that is P4).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from '../../ui/Modal';
import { trpc } from '../../../trpc/client';
import { trackEvent } from '../../../utils/telemetry';
import { FlowNameDialog } from '../FlowNameDialog';
import { AgentEditorForm } from './AgentEditorForm';
import { AgentUsageInspector } from './AgentUsageInspector';
import { useAgentEditorState } from './useAgentEditorState';
import { estimateTokens } from './agentEditorTokens';
import type { AgentEntry } from '../../../../../shared/types/agents';

export interface AgentEditorModalProps {
  isOpen: boolean;
  projectId: number;
  agentKey: string;
  mode: 'edit' | 'create';
  onClose: () => void;
  /** Called after a successful save / reset / duplicate with the affected agent key. */
  onSaved: (agentKey: string) => void;
}

export function AgentEditorModal({
  isOpen,
  projectId,
  agentKey,
  mode,
  onClose,
  onSaved,
}: AgentEditorModalProps): React.JSX.Element {
  // The seeded entry (drives the inspector + source flags); null until loaded.
  const [entry, setEntry] = useState<AgentEntry | null>(null);
  const { state, dispatch, dirty } = useAgentEditorState(entry);

  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  /**
   * Synchronous in-flight latch shared by every mutating action. The `isBusy`
   * STATE guard alone cannot stop a double-submit: two clicks in the same tick
   * both read the pre-update state and both pass, and `disabled` only takes
   * effect after the next render. A ref flips synchronously so the second
   * invocation is rejected. (Copied from WorkflowEditorModal.)
   */
  const actionInFlightRef = useRef(false);

  // ── Seed on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    // CREATE = a brand-new custom agent. There is nothing to fetch and the
    // create-mode agentKey is empty, so calling agents.get would fail the
    // agentKey regex and wedge the modal on "Loading agent…". The reducer's
    // initial state is already a blank draft, so just clear the gate.
    if (mode === 'create') {
      setEntry(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const loaded = await trpc.cyboflow.agents.get.query({ projectId, agentKey });
        if (cancelled) return;
        setEntry(loaded);
        dispatch({ type: 'SEED', entry: loaded });
        setIsLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load agent');
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, projectId, agentKey, dispatch]);

  // ── Derived flags ───────────────────────────────────────────────────────────
  // A brand-new agent (create mode) IS a custom — even before it has an entry —
  // so the name field unlocks and the case note reads correctly.
  const isCustom = mode === 'create' ? true : (entry?.isCustom ?? false);
  const isOverridden = entry?.isOverridden ?? false;
  // "Reset to default" applies ONLY to an overridden BUILT-IN (a custom has no
  // default to revert to — it would use deleteCustom instead).
  const showReset = isOverridden && !isCustom;

  // Description is required and must never name an MCP write tool.
  const descriptionError = useMemo<string | null>(() => {
    const d = state.draft.description.trim();
    if (d.length === 0) return 'A description is required.';
    if (d.includes('cyboflow_')) return 'Description must not reference a cyboflow_ tool.';
    return null;
  }, [state.draft.description]);

  // Create mode mints a NEW custom: the server derives the agentKey from a
  // non-empty name and requires ≥1 tool (toolsSchema.min(1)). Gate Save on both
  // so the create call can't fail the input contract.
  const nameError = useMemo<string | null>(
    () => (mode === 'create' && state.draft.name.trim().length === 0 ? 'A name is required.' : null),
    [mode, state.draft.name],
  );
  const toolsError = useMemo<string | null>(
    () => (mode === 'create' && state.draft.enabledTools.length === 0 ? 'Enable at least one tool.' : null),
    [mode, state.draft.enabledTools.length],
  );

  const liveTokens = estimateTokens(state.draft.systemPrompt);
  const liveToolsEnabled = state.draft.enabledTools.length;

  const canSave =
    dirty &&
    descriptionError === null &&
    nameError === null &&
    toolsError === null &&
    !isBusy &&
    !isLoading;

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!canSave || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      if (mode === 'create') {
        // Mint a NEW custom agent — createCustom derives the kebab agentKey from
        // the name (no agentKey input). Then close, like the duplicate path.
        const created = await trpc.cyboflow.agents.createCustom.mutate({
          projectId,
          name: state.draft.name,
          description: state.draft.description,
          systemPrompt: state.draft.systemPrompt,
          tools: state.draft.enabledTools,
          role: state.draft.role,
        });
        trackEvent('agent_saved', { custom: true });
        onSaved(created.agentKey);
        onClose();
        return;
      }
      const saved = await trpc.cyboflow.agents.upsertOverride.mutate({
        projectId,
        agentKey,
        name: state.draft.name,
        description: state.draft.description,
        systemPrompt: state.draft.systemPrompt,
        tools: state.draft.enabledTools,
        role: state.draft.role,
      });
      trackEvent('agent_saved', { custom: isCustom });
      setEntry(saved);
      dispatch({ type: 'SEED', entry: saved });
      onSaved(saved.agentKey);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [canSave, mode, projectId, agentKey, state.draft, dispatch, onSaved, onClose]);

  const handleReset = useCallback(async () => {
    if (!showReset || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setError(null);
    setIsBusy(true);
    try {
      const reset = await trpc.cyboflow.agents.resetOverride.mutate({ projectId, agentKey });
      setEntry(reset);
      dispatch({ type: 'SEED', entry: reset });
      onSaved(reset.agentKey);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [showReset, projectId, agentKey, dispatch, onSaved]);

  // Opening the duplicate name dialog is non-mutating, so it does NOT take the
  // latch — the latch is acquired only on confirm (handleDuplicateConfirm).
  const handleDuplicate = useCallback(() => {
    if (actionInFlightRef.current) return;
    setError(null);
    setNameDialogOpen(true);
  }, []);

  const handleDuplicateConfirm = useCallback(
    async (newName: string) => {
      setNameDialogOpen(false);
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setError(null);
      setIsBusy(true);
      try {
        const dup = await trpc.cyboflow.agents.duplicate.mutate({ projectId, agentKey, newName });
        onSaved(dup.agentKey);
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not duplicate the agent');
      } finally {
        setIsBusy(false);
        actionInFlightRef.current = false;
      }
    },
    [projectId, agentKey, onSaved, onClose],
  );

  // ── Dirty-close guard ────────────────────────────────────────────────────────
  const requestClose = useCallback(() => {
    if (isBusy) return;
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes to this agent?');
      if (!ok) return;
    }
    onClose();
  }, [isBusy, dirty, onClose]);

  // ── Header title ──────────────────────────────────────────────────────────────
  // Title shows the BARE agent key (not entry.name): the persisted `cyboflow-`
  // prefix is load-bearing for dispatch but redundant in the editor chrome.
  const title = useMemo(
    () => (mode === 'create' ? 'New agent' : `Edit agent · ${agentKey}`),
    [mode, agentKey],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      size="full"
      showCloseButton={false}
      closeOnOverlayClick
      closeOnEscape
    >
      <div className="flex flex-col" style={{ height: '90vh', maxHeight: '90vh' }} data-testid="agent-editor-modal">
        {/* ── Title bar (ink/paper) ─────────────────────────────────────── */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle"
          style={{ background: 'var(--color-surface-secondary)', flexShrink: 0 }}
        >
          <h2 className="text-sm font-semibold text-text-primary" style={{ letterSpacing: '0.04em' }}>
            {title}
          </h2>

          <div className="flex-1" />

          {/* Duplicate needs a saved source agent — meaningless for a brand-new
              one, so it is hidden in create mode. */}
          {mode === 'edit' && (
            <button
              type="button"
              onClick={handleDuplicate}
              disabled={isBusy || isLoading}
              className="rounded-button border border-border-subtle bg-surface-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="agent-editor-duplicate-button"
            >
              Duplicate
            </button>
          )}

          {showReset && (
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={isBusy}
              className="rounded-button border border-border-subtle bg-surface-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="agent-editor-reset-button"
            >
              Reset to default
            </button>
          )}

          <button
            type="button"
            onClick={requestClose}
            disabled={isBusy}
            className="rounded-button border border-border-subtle bg-surface-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="agent-editor-cancel-button"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="rounded-button px-3 py-1.5 text-xs font-medium text-text-on-interactive disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: 'var(--color-interactive-primary)' }}
            data-testid="agent-editor-save-button"
          >
            Save
          </button>
        </div>

        {/* ── Inline error ──────────────────────────────────────────────── */}
        {error !== null && (
          <div
            role="alert"
            className="px-4 py-2 text-xs text-status-error border-b border-border-subtle"
            style={{ background: 'var(--color-surface-secondary)', flexShrink: 0 }}
            data-testid="agent-editor-error"
          >
            {error}
          </div>
        )}

        {/* ── Body — form + inspector ───────────────────────────────────── */}
        {/* CREATE has no entry to fetch, so it renders the blank form straight
            away; only EDIT shows the "Loading agent…" gate while agents.get is
            in flight. The usage inspector needs a real entry (usage/stats), so
            it is shown only once one exists. */}
        <div className="flex flex-row flex-1 overflow-hidden">
          {isLoading || (mode === 'edit' && entry === null) ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-xs text-text-secondary">Loading agent…</p>
            </div>
          ) : (
            <>
              <AgentEditorForm
                draft={state.draft}
                dispatch={dispatch}
                mode={mode}
                isCustom={isCustom}
                descriptionError={descriptionError}
              />
              {entry !== null && (
                <AgentUsageInspector
                  entry={entry}
                  liveTokens={liveTokens}
                  liveToolsEnabled={liveToolsEnabled}
                />
              )}
            </>
          )}
        </div>
      </div>

      <FlowNameDialog
        isOpen={nameDialogOpen}
        title="Name for the duplicated agent"
        defaultValue={`${agentKey}-copy`}
        confirmLabel="Duplicate"
        onConfirm={(name) => void handleDuplicateConfirm(name)}
        onClose={() => setNameDialogOpen(false)}
      />
    </Modal>
  );
}
