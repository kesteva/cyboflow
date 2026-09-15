/**
 * TuningLevelSelector — the launch wizard's per-run tuning-level control
 * (docs/plans/workflow-tuning-levels.md D4 + §4 "SessionStartWizard").
 *
 * Four segments — Efficient / Standard / Thorough / Custom. The component is a
 * plain controlled radiogroup: `value` is whatever the caller currently wants
 * shown as selected (the parent's per-run override when one is active, else
 * the workflow's stamped level), and `onChange` reports the segment the user
 * picked — the caller decides whether that pick diverges from the stamp (and
 * offers the shared "Save as default" CTA to persist it) or matches it back.
 * See SessionStartWizard's `tuningLevelOverride` state for that logic.
 *
 * Custom is disabled-with-hint while the workflow's `spec_json` slot is empty
 * (`customSlotAvailable` — {@link hasCustomSpecSlot}); once selectable it gets
 * a distinct accent (status-info) from the other three preset/identity
 * segments (interactive/terracotta), so a stored definition always reads as a
 * different KIND of choice from a calibrated preset.
 *
 * There is no whole-control disabled state: variants are scoped to a tuning
 * level (migration 126), so a pinned variant no longer contradicts a level pick
 * — the level chooses the POOL and the variant picker chooses inside it.
 *
 * `estimateLabels` (plan §5 phase 7, `shared/tuning/workflowTuningEstimates`)
 * renders a small secondary line under whichever segment(s) supply one. Those
 * figures are EXECUTION tokens only (eval-jury usage is unmetered — D8's
 * "Scope caveat"), so whenever any label is supplied this also renders a
 * one-line "excl. eval" caption below the segments, once per surface.
 */
import { cn } from '../../../utils/cn';
import {
  TUNING_LEVELS,
  TUNING_LEVEL_LABELS,
  type TuningLevel,
} from '../../../../../shared/tuning/workflowTuning';

/** One-line helper under the segments, per selected level — kept in step with
 *  the flow editor's TuningLevelDial card copy so the two surfaces describe a
 *  level the same way. */
const TUNING_LEVEL_DESCRIPTIONS: Record<TuningLevel, string> = {
  efficient:
    'Fewest steps, cheaper models, review once per sprint — drafts, chores, low-risk changes.',
  standard: 'The aligned defaults — balanced models on every step, every check on.',
  thorough: 'Every check on, strongest models — ship-critical or gnarly work.',
  custom: 'Your saved custom definition for this flow.',
};

export interface TuningLevelSelectorProps {
  /** The level currently shown as selected — the active override, else the stamped level. */
  value: TuningLevel;
  /** Whether the workflow's `spec_json` slot holds a real custom definition. */
  customSlotAvailable: boolean;
  onChange: (level: TuningLevel) => void;
  /** Optional per-level token-estimate seam (plan §5 phase 7) — no query wired yet. */
  estimateLabels?: Partial<Record<TuningLevel, string>>;
  id?: string;
  /**
   * One-line note shown when `value` is defaulting from the project's
   * solution-thoroughness stamp rather than an explicit per-run override or
   * the workflow's own stamped level (Tier 2, item 13c), e.g. "Defaulted from
   * project thoroughness: v1 → standard". Omit when the stamp isn't in
   * effect (no thoroughness stamp, or an override/workflow stamp already
   * explains the displayed value).
   */
  stampHint?: string;
}

export function TuningLevelSelector({
  value,
  customSlotAvailable,
  onChange,
  estimateLabels,
  id = 'wizard-tuning-level',
  stampHint,
}: TuningLevelSelectorProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid="wizard-tuning-level">
      <span className="text-xs font-medium text-text-secondary">Workflow configuration</span>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Workflow configuration" id={id}>
        {TUNING_LEVELS.map((level) => {
          const isCustom = level === 'custom';
          const segmentDisabled = isCustom && !customSlotAvailable;
          const selected = value === level;
          const estimate = estimateLabels?.[level];
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={segmentDisabled}
              onClick={() => onChange(level)}
              data-testid={`wizard-tuning-level-${level}`}
              title={
                segmentDisabled ? 'No custom definition yet — create one in the flow editor' : undefined
              }
              className={cn(
                // Matched to AgentPermissionModeSelector's row styling so the
                // Configure step's button controls read as one family.
                'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-button border px-3 py-2 text-sm font-medium transition-colors',
                segmentDisabled
                  ? 'cursor-not-allowed border-border-secondary bg-surface-secondary text-text-tertiary opacity-50'
                  : selected
                    ? isCustom
                      ? 'border-status-info bg-status-info/10 text-status-info'
                      : 'border-interactive bg-interactive-surface text-text-primary'
                    : 'border-border-secondary bg-surface-secondary text-text-primary hover:bg-surface-hover',
              )}
            >
              <span>{TUNING_LEVEL_LABELS[level]}</span>
              {estimate !== undefined && (
                <span className="text-[10px] text-text-tertiary">{estimate}</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-text-tertiary" data-testid="wizard-tuning-level-desc">
        {TUNING_LEVEL_DESCRIPTIONS[value]}
      </p>

      {stampHint !== undefined && (
        <p className="text-xs italic text-text-tertiary" data-testid="wizard-tuning-level-stamp-hint">
          {stampHint}
        </p>
      )}

      {estimateLabels !== undefined && Object.keys(estimateLabels).length > 0 && (
        <p className="text-xs text-text-tertiary" data-testid="wizard-tuning-estimate-caption">
          Estimated execution tokens (excl. eval)
        </p>
      )}
    </div>
  );
}
