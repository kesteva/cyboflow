/**
 * ModelSelector — the per-launch Claude model picker for the Session Start
 * Wizard's quick-session Configure step (③). Controlled (value/onChange), a
 * native <select> styled to match {@link SubstrateSelector} so the two configure
 * controls read as one family.
 *
 * The chosen model id (a bare alias like 'opus') is threaded into the quick
 * session launch and persisted on the claude panel; the spawn seam
 * (`modelContext.resolveModelAlias`) pins the alias to the current concrete
 * snapshot (Opus 4.8, Sonnet 5, …), so "Opus" actually runs Opus 4.8 and the
 * "· 1M context" labels are honest.
 *
 * Claude options are shared with the in-composer ModelPill. Codex options come
 * from the bundled runtime's `model/list` response through the shared renderer
 * catalog store, so launch and in-session pickers stay aligned.
 */
import { MODEL_OPTIONS } from './unified/ModelPill';
import { useModelAvailability } from '../../stores/modelAvailabilityStore';
import { useCodexModelCatalog } from '../../stores/codexModelCatalogStore';
import type { AgentProvider, AgentRuntime } from '../../../../shared/types/agentRuntime';

/** The quick-session default model — Opus, per product direction. */
export const DEFAULT_QUICK_MODEL = 'opus';

/**
 * The Ultracode-launch default model — Fable 5, per product direction (ultracode
 * is the "most capable, fan work out" mode, so it defaults to the frontier
 * model). Only seeded when the availability snapshot says Fable is usable; the
 * wizard falls back to {@link DEFAULT_QUICK_MODEL} otherwise. A mid-run
 * availability flip is still safe — the spawn seam's
 * `applyModelAvailabilityFallback` swaps an unavailable Fable to Opus.
 */
export const ULTRACODE_DEFAULT_MODEL = 'fable';

/**
 * The workflow-launch default model — Opus, matching quick sessions (per product
 * direction). Threaded into runs.start.mutate({ model }) from the Configure surface
 * and stamped onto workflow_runs.model (migration 037). A run launched without a
 * picker (legacy / programmatic callers) still pins nothing and falls to the SDK
 * default; this constant only seeds the user-facing pickers.
 */
export const DEFAULT_WORKFLOW_MODEL = 'opus';
export const DEFAULT_CODEX_MODEL = 'auto';

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
  /** Runtime context; model availability is provider/runtime scoped. */
  agentProvider?: AgentProvider;
  agentRuntime?: AgentRuntime;
  /**
   * When set, prepends a `value=''` option (Claude path only) so the caller can
   * offer "follow the app default" instead of pinning a concrete alias. The
   * empty value is never passed to `isAliasUsable`/`unavailableReason`, so it
   * is always enabled.
   */
  allowDefaultOption?: { label: string };
}

export function ModelSelector({
  value,
  onChange,
  id = 'model-select',
  label = 'Model',
  agentProvider = 'claude',
  agentRuntime = 'claude-sdk',
  allowDefaultOption,
}: ModelSelectorProps): React.JSX.Element {
  const isCodexRuntime = agentProvider === 'codex' || agentRuntime.startsWith('codex-');
  const { options: codexOptions } = useCodexModelCatalog(isCodexRuntime);
  const codexActive = codexOptions.find((o) => o.id === value);
  const claudeActive = MODEL_OPTIONS.find((o) => o.id === value);
  const { isAliasUsable, unavailableReason } = useModelAvailability();
  const activeReason = value ? unavailableReason(value) : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label={isCodexRuntime ? 'Select Codex model' : 'Select Claude model'}
      >
        {isCodexRuntime ? (
          codexOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label} — {o.description}
            </option>
          ))
        ) : (
          <>
            {allowDefaultOption && (
              <option value="">{allowDefaultOption.label}</option>
            )}
            {MODEL_OPTIONS.map((o) => {
              const disabled = !isAliasUsable(o.id);
              return (
                <option key={o.id} value={o.id} disabled={disabled}>
                  {o.context ? `${o.label} · ${o.context}` : o.label} — {o.description}
                  {disabled ? ' (unavailable)' : ''}
                </option>
              );
            })}
          </>
        )}
      </select>
      {isCodexRuntime ? (
        <p className="text-xs text-text-tertiary">
          {codexActive?.description ?? 'Choose a Codex model for this runtime.'}
        </p>
      ) : claudeActive !== undefined && (
        <p className="text-xs text-text-tertiary">
          {activeReason
            ? `${claudeActive.label} is currently unavailable — runs will use Opus.`
            : claudeActive.context
              ? `${claudeActive.description} · ${claudeActive.context} context`
              : claudeActive.description}
        </p>
      )}
    </div>
  );
}
