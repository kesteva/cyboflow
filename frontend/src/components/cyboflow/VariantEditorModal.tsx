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
import { Pencil } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { useVariantsStore, type WorkflowVariantRow } from '../../stores/variantsStore';
import { useWorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { WorkflowEditorCanvas } from './WorkflowEditorCanvas';
import { WorkflowStepInspector } from './WorkflowStepInspector';
import { MODEL_OPTIONS } from './unified/ModelPill';
import { providerForRuntime, type LaunchAgentRuntime } from './agentRuntimeUi';
import { useCodexModelCatalog } from '../../stores/codexModelCatalogStore';
import { useOmpModelCatalog } from '../../stores/ompModelCatalogStore';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import type { WorkflowVariantAgentOverrides } from '../../../../shared/types/experiments';
import type { AgentEntry, AgentRunTarget } from '../../../../shared/types/agents';
import type { AgentProvider, WorkflowAgentRuntime } from '../../../../shared/types/agentRuntime';
import {
  AGENT_PROVIDER_LABELS,
  AGENT_RUNTIME_LABELS,
  isRuntimeProviderEnabled,
  WORKFLOW_LAUNCHABLE_RUNTIMES,
} from '../../../../shared/types/agentRuntime';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';

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

/**
 * Runtime-pin labels for the variant picker. Projected from the shared
 * {@link AGENT_RUNTIME_LABELS} — every workflow-launchable runtime is also a
 * session runtime, so this is a narrowing, not a second wording to keep in sync.
 */
const VARIANT_RUNTIME_LABELS: Record<WorkflowAgentRuntime, string> = {
  'claude-sdk': AGENT_RUNTIME_LABELS['claude-sdk'],
  'claude-interactive': AGENT_RUNTIME_LABELS['claude-interactive'],
  'codex-sdk': AGENT_RUNTIME_LABELS['codex-sdk'],
  'omp-sdk': AGENT_RUNTIME_LABELS['omp-sdk'],
  'pi-sdk': AGENT_RUNTIME_LABELS['pi-sdk'],
};

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
  // Local display copy of the label: the parent's `variant` prop object is a
  // snapshot taken when the modal opened, so after an in-modal rename it would
  // keep showing the stale label until the modal is re-opened.
  const [displayLabel, setDisplayLabel] = useState<string>(variant.label);
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState<string>(variant.label);
  const [model, setModel] = useState<string>(variant.model ?? INHERIT);
  const [executionModel, setExecutionModel] = useState<string>(variant.execution_model ?? INHERIT);
  // The per-variant agent runtime (migration 066). INHERIT ('') = no pin (fall
  // through to the launch default). Provider is derived from the runtime — the
  // pair is stored on the variant but a single runtime choice determines both.
  const [agentRuntime, setAgentRuntime] = useState<string>(variant.agent_runtime ?? INHERIT);
  const [agentEntries, setAgentEntries] = useState<AgentEntry[]>([]);
  const [overrides, setOverrides] = useState<WorkflowVariantAgentOverrides>(() =>
    parseAgentOverrides(variant.agent_overrides_json),
  );

  // Derived views of the effective agent catalogue (mirrors WorkflowEditorModal):
  // the per-agent override rows need the keys, the embedded step inspector needs
  // the FULL entries (to render the AGENT-tab model pin) + the custom keys.
  const agentKeys = useMemo(() => agentEntries.map((e) => e.agentKey), [agentEntries]);
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

  // The variant's effective agent provider, derived from its runtime pin. When
  // unpinned (INHERIT) the launch default (Claude) drives the pickers. A
  // NON-CLAUDE variant swaps the Claude model list for that provider's
  // runtime-discovered catalog and hides the per-agent overrides (those runs are
  // single-model — there is no agent overlay on a non-Claude spawn).
  const variantProvider: AgentProvider =
    agentRuntime === INHERIT ? 'claude' : providerForRuntime(agentRuntime as LaunchAgentRuntime);
  const isNonClaudeVariant = variantProvider !== 'claude';
  // Both catalogue hooks are called unconditionally (Rules of Hooks); each
  // `enabled` flag defers its own fetch until that provider is the pinned one.
  const { options: codexModelOptions } = useCodexModelCatalog(variantProvider === 'codex');
  const { options: ompModelOptions } = useOmpModelCatalog(variantProvider === 'omp');
  const providerModelOptions =
    variantProvider === 'codex'
      ? codexModelOptions
      : variantProvider === 'omp'
        ? ompModelOptions
        : MODEL_OPTIONS;
  // Provider access (Settings → Integrations): a variant may not pin a runtime
  // whose provider is switched off — createRun rejects such a pin at launch, so
  // offering it here would only mint an unlaunchable variant. An already-saved
  // pin stays listed so the select renders its own value until the user repins.
  const providerAccess = useAgentProviderAccess();
  const runtimePinOptions = WORKFLOW_LAUNCHABLE_RUNTIMES.filter(
    (r) => isRuntimeProviderEnabled(providerAccess, r) || r === agentRuntime,
  );

  // Drop a run-level model pin another provider's family claims (a Claude alias
  // under Codex, an OMP `provider/model` under Claude) — mirrors WorkflowPicker,
  // resetting to INHERIT (the variant's no-pin) rather than a provider default.
  // Keyed on `normalizeAgentModelSelection`, the same shared family predicates
  // createRun normalizes with, so the picker and the launch agree on what
  // "belongs to this provider" for EVERY provider rather than for Codex alone.
  useEffect(() => {
    if (model === INHERIT) return;
    if (normalizeAgentModelSelection(variantProvider, model) === undefined) setModel(INHERIT);
  }, [variantProvider, model]);

  const actionInFlightRef = useRef(false);

  // Re-seed every time the modal opens (or targets a different variant).
  useEffect(() => {
    if (!isOpen) return;
    dispatch({ type: 'SET_DEFINITION', definition: parseVariantDefinition(variant.spec_json), name: variant.label });
    setDisplayLabel(variant.label);
    setLabelDraft(variant.label);
    setRenaming(false);
    setModel(variant.model ?? INHERIT);
    setExecutionModel(variant.execution_model ?? INHERIT);
    setAgentRuntime(variant.agent_runtime ?? INHERIT);
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
        if (!cancelled) setAgentEntries(entries);
      } catch {
        if (!cancelled) setAgentEntries([]);
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
        agentProvider: agentRuntime === INHERIT ? null : variantProvider,
        agentRuntime: agentRuntime === INHERIT ? null : (agentRuntime as WorkflowAgentRuntime),
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
  }, [variant.id, state.definition, overrides, overrideCount, model, executionModel, agentRuntime, variantProvider, workflowId, onSaved, onClose]);

  // Inline header rename (IDEA-018 follow-up): label-only variants.update.
  // The UNIQUE(workflow_id, label) CONFLICT from the registry surfaces in the
  // modal's existing error bar; frozen snapshots (experiment_arms.label,
  // workflow_runs.variant_label) are intentionally untouched by a rename.
  const handleRename = useCallback(async () => {
    const next = labelDraft.trim();
    if (next === '' || next === displayLabel) {
      setRenaming(false);
      setLabelDraft(displayLabel);
      return;
    }
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setIsBusy(true);
    setError(null);
    try {
      await trpc.cyboflow.variants.update.mutate({ variantId: variant.id, label: next });
      await useVariantsStore.getState().invalidate(workflowId);
      setDisplayLabel(next);
      setRenaming(false);
      onSaved?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rename variant');
    } finally {
      setIsBusy(false);
      actionInFlightRef.current = false;
    }
  }, [labelDraft, displayLabel, variant.id, workflowId, onSaved]);

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
          <h2
            className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"
            style={{ letterSpacing: '0.04em' }}
          >
            <span>Edit variant ·</span>
            {renaming ? (
              <input
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRename();
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    setLabelDraft(displayLabel);
                  }
                }}
                disabled={isBusy}
                autoFocus
                aria-label="Variant name"
                data-testid="variant-editor-rename-input"
                className="rounded-button border border-border-primary bg-bg-primary px-1.5 py-0.5 text-sm font-semibold text-text-primary"
              />
            ) : (
              <>
                <span>{displayLabel}</span>
                <button
                  type="button"
                  onClick={() => {
                    setLabelDraft(displayLabel);
                    setRenaming(true);
                  }}
                  disabled={isBusy}
                  title="Rename variant"
                  aria-label="Rename variant"
                  data-testid="variant-editor-rename-button"
                  className="text-text-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Pencil size={13} />
                </button>
              </>
            )}
          </h2>
          {variant.status === 'draft' && (
            <span
              className="rounded-badge border border-border-primary bg-bg-primary px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-text-tertiary"
              data-testid="variant-editor-draft-chip"
            >
              {/* status='draft' means "never added to rotation", NOT "unsaved" —
                  saving here never changes the status. Worded to match
                  VariantManagerSection's STATUS_LABEL. */}
              Not in rotation
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

        {/* Variant-level runtime / model / execution-model defaults. */}
        <div
          className="flex items-center gap-4 px-4 py-2 border-b border-border-primary"
          style={{ flexShrink: 0 }}
        >
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Runtime
            <select
              value={agentRuntime}
              onChange={(e) => setAgentRuntime(e.target.value)}
              className="rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary"
              data-testid="variant-editor-runtime-select"
            >
              <option value={INHERIT}>Inherit</option>
              {runtimePinOptions.map((runtime) => (
                <option key={runtime} value={runtime}>
                  {VARIANT_RUNTIME_LABELS[runtime]}
                  {isRuntimeProviderEnabled(providerAccess, runtime) ? '' : ' — provider off'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Model default
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary"
              data-testid="variant-editor-model-select"
            >
              <option value={INHERIT}>Inherit (no pin)</option>
              {providerModelOptions.map((o) => (
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
            agentProvider={variantProvider}
          />
        </div>

        {/* Per-agent delta editor. */}
        <div
          className="flex flex-col gap-2 border-t border-border-primary px-4 py-3 overflow-y-auto"
          style={{ flexShrink: 0, maxHeight: '30vh' }}
          data-testid="variant-editor-agent-deltas"
        >
          <h3 className="text-xs font-semibold text-text-primary">Agent overrides</h3>
          {isNonClaudeVariant && (
            <p className="text-xs text-text-tertiary" data-testid="variant-editor-agent-deltas-codex-note">
              {AGENT_PROVIDER_LABELS[variantProvider]} runs use a single model per run and don&apos;t
              apply per-agent model or system-prompt overrides — set the run model above.
            </p>
          )}
          {!isNonClaudeVariant && agentKeys.length === 0 && (
            <p className="text-xs text-text-tertiary">No agents available for this project.</p>
          )}
          {!isNonClaudeVariant && agentKeys.map((agentKey) => {
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
