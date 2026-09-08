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
import { MODEL_OPTIONS, formatDynamicClaudeLabel } from './unified/ModelPill';
import { useModelAvailability } from '../../stores/modelAvailabilityStore';
import { useCodexModelCatalog } from '../../stores/codexModelCatalogStore';
import { useClaudeModelCatalog } from '../../stores/claudeModelCatalogStore';
import { useOmpModelCatalog } from '../../stores/ompModelCatalogStore';
import { groupOmpOptionsByProvider } from './unified/ompModelGrouping';
import { providerForRuntime } from '../../../../shared/types/agentRuntime';
import type { AgentProvider, AgentRuntime } from '../../../../shared/types/agentRuntime';
/** The quick-session default model — Opus, per product direction. */
export { DEFAULT_QUICK_MODEL } from '../../../../shared/types/sessionDefaults';

/** The workflow-launch default model — Opus, matching quick sessions. */
export { DEFAULT_WORKFLOW_MODEL } from '../../../../shared/types/sessionDefaults';

/**
 * The Ultracode-launch default model — Fable 5.1, per product direction (ultracode
 * is the "most capable, fan work out" mode, so it defaults to the frontier
 * model). Only seeded when the availability snapshot says Fable is usable; the
 * wizard falls back to {@link DEFAULT_QUICK_MODEL} otherwise. A mid-run
 * availability flip is still safe — the spawn seam's
 * `applyModelAvailabilityFallback` swaps an unavailable Fable to Opus.
 */
export const ULTRACODE_DEFAULT_MODEL = 'fable';

/** Re-exported from shared so the launch seams can reach it without importing
 *  a component; this stays the canonical import site for UI code. */
export { DEFAULT_CODEX_MODEL, DEFAULT_AGY_MODEL } from '../../../../shared/types/agentModels';

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
   * When set, prepends a `value=''` option so the caller can offer "follow the
   * app default" instead of pinning a concrete model. The empty value is never
   * passed to `isAliasUsable`/`unavailableReason`, so it is always enabled.
   *
   * Honored on the CLAUDE and OMP paths, NOT on Codex — the split mirrors
   * `coerceModelForRuntime` (settings/runTypeOverrides.ts) and rests on the same
   * fact: an omitted model resolves to the always-Claude floor at launch, which
   * `normalizeAgentModelSelection` then DROPS under the omp provider (leaving
   * OMP on its own default) but KEEPS under codex, where it would be the
   * cross-family pair. Codex advertises an explicit `auto` row for that intent;
   * OMP advertises none, so absence is the only way to express it.
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
  const isCodexRuntime = agentProvider === 'codex' || providerForRuntime(agentRuntime) === 'codex';
  const isOmpRuntime = agentProvider === 'omp' || providerForRuntime(agentRuntime) === 'omp';
  const { options: codexOptions } = useCodexModelCatalog(isCodexRuntime);
  // Dynamic "Other models" the login can select, below the pinned four (Claude only).
  const { options: claudeCatalogOptions } = useClaudeModelCatalog(!isCodexRuntime && !isOmpRuntime);
  const { options: ompOptions, loading: ompLoading, error: ompError } = useOmpModelCatalog(isOmpRuntime);
  const ompGroups = groupOmpOptionsByProvider(ompOptions);
  // The stand-in row for an empty catalog. Suppressed when a "follow defaults"
  // row is offered: that row already gives the <select> a valid value, and a
  // second empty-valued option would collide with it.
  const ompPlaceholderShown = ompGroups.length === 0 && allowDefaultOption === undefined;
  const codexActive = codexOptions.find((o) => o.id === value);
  const claudeActive = MODEL_OPTIONS.find((o) => o.id === value);
  const claudeDynamicActive = claudeCatalogOptions.find((o) => o.id === value);
  const ompActive = ompOptions.find((o) => o.id === value);
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
        aria-label={isOmpRuntime ? 'Select OMP model' : isCodexRuntime ? 'Select Codex model' : 'Select Claude model'}
      >
        {isOmpRuntime ? (
          <>
            {allowDefaultOption && <option value="">{allowDefaultOption.label}</option>}
            {ompGroups.length === 0 ? (
              ompPlaceholderShown && (
                <option value="" disabled>
                  {ompLoading
                    ? 'Loading OMP models…'
                    : ompError
                      ? 'Could not load OMP models'
                      : 'No OMP models available'}
                </option>
              )
            ) : (
              ompGroups.map(([ompProvider, options]) => (
                <optgroup key={ompProvider} label={ompProvider}>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))
            )}
          </>
        ) : isCodexRuntime ? (
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
            {claudeCatalogOptions.length > 0 && (
              <optgroup label="Other models">
                {claudeCatalogOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {formatDynamicClaudeLabel(o)}
                    {o.description ? ` — ${o.description}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </>
        )}
      </select>
      {isOmpRuntime ? (
        // Carries the catalog's loading/error state too: with a "follow
        // defaults" row present the <select> keeps a valid value, so the
        // disabled placeholder above never renders and this is the only place
        // that can say why the list is empty.
        <p className="text-xs text-text-tertiary" data-testid="model-selector-omp-hint">
          {ompActive
            ? `${ompActive.label} (${ompActive.ompProvider})`
            : ompPlaceholderShown
              ? // The placeholder option already states the reason — repeating it
                // here would render the same sentence twice.
                'Choose an OMP model for this runtime.'
              : ompLoading
                ? 'Loading OMP models…'
                : ompError !== null
                  ? `Couldn't load the OMP model list (${ompError}).`
                  : allowDefaultOption && value === ''
                    ? 'OMP starts on its own default model.'
                    : 'Choose an OMP model for this runtime.'}
        </p>
      ) : isCodexRuntime ? (
        <p className="text-xs text-text-tertiary">
          {codexActive?.description ?? 'Choose a Codex model for this runtime.'}
        </p>
      ) : claudeActive !== undefined ? (
        <p className="text-xs text-text-tertiary">
          {activeReason
            ? `${claudeActive.label} is currently unavailable — runs will use Opus.`
            : claudeActive.context
              ? `${claudeActive.description} · ${claudeActive.context} context`
              : claudeActive.description}
        </p>
      ) : claudeDynamicActive !== undefined ? (
        <p className="text-xs text-text-tertiary">
          {claudeDynamicActive.description || formatDynamicClaudeLabel(claudeDynamicActive)}
        </p>
      ) : null}
    </div>
  );
}
