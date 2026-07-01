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
 * Options + descriptions are single-sourced from {@link MODEL_OPTIONS} (shared
 * with the in-composer ModelPill) so the two surfaces never drift.
 */
import { MODEL_OPTIONS } from './unified/ModelPill';
import { useModelAvailability } from '../../stores/modelAvailabilityStore';

/** The quick-session default model — Opus, per product direction. */
export const DEFAULT_QUICK_MODEL = 'opus';

/**
 * The workflow-launch default model — Opus, matching quick sessions (per product
 * direction). Threaded into runs.start.mutate({ model }) from the Configure surface
 * and stamped onto workflow_runs.model (migration 037). A run launched without a
 * picker (legacy / programmatic callers) still pins nothing and falls to the SDK
 * default; this constant only seeds the user-facing pickers.
 */
export const DEFAULT_WORKFLOW_MODEL = 'opus';

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
}

export function ModelSelector({
  value,
  onChange,
  id = 'model-select',
  label = 'Model',
}: ModelSelectorProps): React.JSX.Element {
  const active = MODEL_OPTIONS.find((o) => o.id === value);
  const { isAliasUsable, unavailableReason } = useModelAvailability();
  const activeReason = unavailableReason(value);

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
        aria-label="Select Claude model"
      >
        {MODEL_OPTIONS.map((o) => {
          const disabled = !isAliasUsable(o.id);
          return (
            <option key={o.id} value={o.id} disabled={disabled}>
              {o.context ? `${o.label} · ${o.context}` : o.label} — {o.description}
              {disabled ? ' (unavailable)' : ''}
            </option>
          );
        })}
      </select>
      {active !== undefined && (
        <p className="text-xs text-text-tertiary">
          {activeReason
            ? `${active.label} is currently unavailable — runs will use Opus.`
            : active.context
              ? `${active.description} · ${active.context} context`
              : active.description}
        </p>
      )}
    </div>
  );
}
