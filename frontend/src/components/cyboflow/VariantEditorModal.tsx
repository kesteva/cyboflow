/**
 * VariantEditorModal — edits ONE workflow variant's frozen spec + per-agent
 * deltas + model/execution-model defaults (migration 048).
 *
 * Deliberately pragmatic (per the architect ruling: "do not over-build"): it
 * reuses the SAME graph-editing plumbing as {@link WorkflowEditorModal}
 * (`useWorkflowEditorState` + `WorkflowEditorCanvas` + `WorkflowStepInspector`)
 * seeded from `variant.spec_json` instead of the workflow row's live spec, but
 * skips WorkflowEditorModal's save-scope / save-as-new / run-with-modifications
 * machinery — a variant is always saved IN PLACE via `variants.update`
 * (re-snapshot; past runs already froze their own spec_hash, so this never
 * rewrites history).
 *
 * Adds the two things a variant needs beyond the graph: a per-variant
 * model / execution-model default (native selects, "Inherit" = null clears the
 * pin) and a simple per-agent delta editor (optional systemPrompt + model
 * override per agent key, `WorkflowVariantAgentOverrides`).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { useVariantsStore, type WorkflowVariantRow } from '../../stores/variantsStore';
import { useWorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { WorkflowEditorCanvas } from './WorkflowEditorCanvas';
import { WorkflowStepInspector } from './WorkflowStepInspector';
import { MODEL_OPTIONS } from './unified/ModelPill';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import type { WorkflowVariantAgentOverrides } from '../../../../shared/types/experiments';

export interface VariantEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string;
  projectId: number;
  variant: WorkflowVariantRow;
  onSaved?: () => void;
}

/** Fallback skeleton when a variant's frozen spec_json somehow fails to parse. */
const EMPTY_DEFINITION: WorkflowDefinition = { id: 'variant', phases: [] };

function parseVariantDefinition(specJson: string): WorkflowDefinition {
  try {
    const parsed: unknown = JSON.parse(specJson);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as WorkflowDefinition).phases)) {
      return parsed as WorkflowDefinition;
    }
    return EMPTY_DEFINITION;
  } catch {
    return EMPTY_DEFINITION;
  }
}

function parseAgentOverrides(json: string | null): WorkflowVariantAgentOverrides {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as WorkflowVariantAgentOverrides) : {};
  } catch {
    return {};
  }
}

/** Sentinel for the "Inherit" (null) option of the model / execution-model selects. */
const INHERIT = '';

export function VariantEditorModal({
  isOpen,
  onClose,
  workflowId,
  projectId,
  variant,
  onSaved,
}: VariantEditorModalProps): React.JSX.Element {
  const { state, dispatch } = useWorkflowEditorState(EMPTY_DEFINITION, variant.label);

  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(variant.model ?? INHERIT);
  const [executionModel, setExecutionModel] = useState<string>(variant.execution_model ?? INHERIT);
  const [agentKeys, setAgentKeys] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<WorkflowVariantAgentOverrides>(() =>
    parseAgentOverrides(variant.agent_overrides_json),
  );

  const actionInFlightRef = useRef(false);

  // Re-seed every time the modal opens (or targets a different variant).
  useEffect(() => {
    if (!isOpen) return;
    dispatch({ type: 'SET_DEFINITION', definition: parseVariantDefinition(variant.spec_json), name: variant.label });
    setModel(variant.model ?? INHERIT);
    setExecutionModel(variant.execution_model ?? INHERIT);
    setOverrides(parseAgentOverrides(variant.agent_overrides_json));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, variant.id]);

  // Agent keys available for a per-agent delta (built-in + custom — either can
  // carry a variant-level prompt/model override at the overlay seam).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await trpc.cyboflow.agents.list.query({ projectId });
        if (!cancelled) setAgentKeys(entries.map((e) => e.agentKey));
      } catch {
        if (!cancelled) setAgentKeys([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

  const setDelta = useCallback(
    (agentKey: string, patch: Partial<{ systemPrompt: string; model: string }>): void => {
      setOverrides((prev) => {
        const next = { ...prev };
        const existing = next[agentKey] ?? {};
        const merged = { ...existing, ...patch };
        // Drop empty-string fields so an untouched/cleared field never persists
        // as a delta of ''.
        const systemPrompt = merged.systemPrompt?.trim() ? merged.systemPrompt : undefined;
        const modelOverride = merged.model?.trim() ? merged.model : undefined;
        if (systemPrompt === undefined && modelOverride === undefined) {
          delete next[agentKey];
        } else {
          next[agentKey] = { ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(modelOverride !== undefined ? { model: modelOverride } : {}) };
        }
        return next;
      });
    },
    [],
  );

  const overrideCount = useMemo(() => Object.keys(overrides).length, [overrides]);

  const handleSave = useCallback(async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setIsBusy(true);
    setError(null);
    try {
      await trpc.cyboflow.variants.update.mutate({
        variantId: variant.id,
        definition: state.definition,
        agentOverrides: overrideCount > 0 ? overrides : null,
        model: model === INHERIT ? null : model,
        executionModel:
          executionModel === INHERIT ? null : (executionModel as 'orchestrated' | 'programmatic'),
      });
      await useVariantsStore.getState().invalidate(workflowId);
      onSaved?.();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save variant');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [variant.id, state.definition, overrides, overrideCount, model, executionModel, workflowId, onSaved, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" showCloseButton={false}>
      <div
        className="flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        data-testid="variant-editor-modal"
      >
        <div
          className="flex items-center gap-3 px-4 py-3 border-b border-border-primary"
          style={{ background: 'var(--color-bg-secondary)', flexShrink: 0 }}
        >
          <h2 className="text-sm font-semibold text-text-primary" style={{ letterSpacing: '0.04em' }}>
            Edit variant · {variant.label}
          </h2>
          {variant.status === 'draft' && (
            <span
              className="rounded-badge border border-border-primary bg-bg-primary px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-text-tertiary"
              data-testid="variant-editor-draft-chip"
            >
              Draft
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isBusy}
            data-testid="variant-editor-save-button"
            className="rounded-button bg-interactive px-3 py-1.5 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save variant
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            data-testid="variant-editor-cancel-button"
            className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        {error !== null && (
          <div
            role="alert"
            className="px-4 py-2 text-xs text-status-error border-b border-border-primary"
            style={{ background: 'var(--color-bg-secondary)', flexShrink: 0 }}
            data-testid="variant-editor-error"
          >
            {error}
          </div>
        )}

        {/* Variant-level model / execution-model defaults. */}
        <div
          className="flex items-center gap-4 px-4 py-2 border-b border-border-primary"
          style={{ flexShrink: 0 }}
        >
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Model default
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary"
              data-testid="variant-editor-model-select"
            >
              <option value={INHERIT}>Inherit (no pin)</option>
              {MODEL_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Execution model
            <select
              value={executionModel}
              onChange={(e) => setExecutionModel(e.target.value)}
              className="rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary"
              data-testid="variant-editor-execution-model-select"
            >
              <option value={INHERIT}>Inherit</option>
              <option value="orchestrated">Orchestrated</option>
              <option value="programmatic">Programmatic</option>
            </select>
          </label>
        </div>

        <div className="flex flex-row flex-1 overflow-hidden">
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
        </div>

        {/* Per-agent delta editor. */}
        <div
          className="flex flex-col gap-2 border-t border-border-primary px-4 py-3 overflow-y-auto"
          style={{ flexShrink: 0, maxHeight: '30vh' }}
          data-testid="variant-editor-agent-deltas"
        >
          <h3 className="text-xs font-semibold text-text-primary">Agent overrides</h3>
          {agentKeys.length === 0 && (
            <p className="text-xs text-text-tertiary">No agents available for this project.</p>
          )}
          {agentKeys.map((agentKey) => {
            const delta = overrides[agentKey];
            return (
              <div
                key={agentKey}
                className="flex flex-col gap-1.5 rounded-input border border-border-secondary px-2 py-1.5"
                data-testid={`variant-editor-agent-delta-${agentKey}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary">{agentKey}</span>
                  <select
                    value={delta?.model ?? INHERIT}
                    onChange={(e) => setDelta(agentKey, { model: e.target.value })}
                    className="ml-auto rounded-input border border-border-primary bg-bg-primary px-2 py-0.5 text-[11px] text-text-primary"
                    aria-label={`${agentKey} model override`}
                  >
                    <option value={INHERIT}>No model override</option>
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={delta?.systemPrompt ?? ''}
                  onChange={(e) => setDelta(agentKey, { systemPrompt: e.target.value })}
                  placeholder="System prompt override (leave blank to keep this agent's default)"
                  rows={2}
                  className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-[11px] text-text-primary"
                  aria-label={`${agentKey} system prompt override`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
