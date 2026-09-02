import type { CodexModelOption } from '../../../../../shared/types/agentModels';
import {
  effortLevelsForProvider,
  type ReasoningEffort,
} from '../../../../../shared/types/reasoningEffort';
import { LoadingSpinner } from '../../LoadingSpinner';
import { MODEL_OPTIONS } from '../../cyboflow/unified/ModelPill';

/**
 * Step 3 — the model + reasoning-effort defaults, for whichever provider the
 * tour resolved as the default agent (step 2's answer when that step ran, else
 * the single activated candidate).
 *
 * TWO questions on ONE card, sequenced by `phase`:
 *   'model'  — the model list; picking a row selects it and reveals the effort
 *              list (the gate flips the phase).
 *   'effort' — the chosen model collapses to a single row with a terracotta
 *              CHANGE affordance back to 'model', and the effort list appears.
 * The card is purely presentational/controlled like its neighbours; the gate
 * owns the seeds and persists both answers on Next
 * (`defaultLaunchModel` + `assistantModel`, then the quick run-type default's
 * `reasoningEffort`).
 *
 * The Codex model list is DISCOVERED (`models:get-catalog` → the Codex runtime's
 * own `model/list`), so it has two states the Claude list cannot have: still
 * loading (effort rows render dimmed and inert, the gate disables Next) and
 * unreachable (the well offers a Retry; the gate falls the selection back to
 * `'auto'` so the step stays completable without a catalog).
 */

export interface ModelStepCatalog {
  options: readonly CodexModelOption[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

interface ModelStepProps {
  /** The effective default agent — decides both lists and the intro line. */
  provider: 'claude' | 'codex';
  /** Current model id in the provider's own id space; null until seeded. */
  model: string | null;
  effort: ReasoningEffort | null;
  phase: 'model' | 'effort';
  onModelChange: (model: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  onPhaseChange: (phase: 'model' | 'effort') => void;
  /** Codex discovery state; ignored entirely when provider === 'claude'. */
  catalog: ModelStepCatalog;
}

/** One selectable row, in the shape both providers' lists project into. */
interface ModelRow {
  id: string;
  label: string;
  /** Short right-aligned tagline; empty renders nothing. */
  hint: string;
}

/**
 * Per-provider effort hints. The scales themselves come from
 * `effortLevelsForProvider` (the real vocabularies, incl. Codex's `none` /
 * `minimal`); only the taglines live here, and they genuinely differ — Claude's
 * `medium` is a lighter setting than its recommended `high`, while Codex's
 * `medium` IS the CLI's own default.
 */
const EFFORT_HINTS: Record<'claude' | 'codex', Partial<Record<ReasoningEffort, string>>> = {
  claude: {
    low: 'Fastest',
    medium: 'Lighter reasoning',
    high: 'Recommended default',
    xhigh: 'Deeper reasoning',
    max: 'Hardest problems',
  },
  codex: {
    none: 'No extended reasoning',
    minimal: 'Minimal',
    low: 'Fastest',
    medium: 'CLI default',
    high: 'Deeper reasoning',
    xhigh: 'Hardest problems',
  },
};

/** `xhigh` → "X-high"; every other rung is its own word, sentence-cased. */
function effortLabel(effort: ReasoningEffort): string {
  if (effort === 'xhigh') return 'X-high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function claudeRows(): ModelRow[] {
  return MODEL_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    hint: option.context ? `${option.description} · ${option.context}` : option.description,
  }));
}

function codexRows(options: readonly CodexModelOption[]): ModelRow[] {
  return options.map((option) => ({ id: option.id, label: option.label, hint: option.description }));
}

const ROW_BASE =
  'flex items-center gap-[11px] bg-surface-primary px-3.5 py-2 text-left transition-colors';

function radioCircle(selected: boolean): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-[1.4px] ${
        selected ? 'border-interactive' : 'border-border-primary'
      }`}
    >
      {selected && <span className="h-[8px] w-[8px] rounded-full bg-interactive" />}
    </span>
  );
}

function SectionLabel({ children, first }: { children: string; first?: boolean }): React.JSX.Element {
  return (
    <div
      className={`text-[9px] font-bold tracking-[.14em] text-text-tertiary ${
        first ? 'mb-[5px]' : 'mb-[5px] mt-[13px]'
      }`}
    >
      {children}
    </div>
  );
}

export function ModelStep({
  provider,
  model,
  effort,
  phase,
  onModelChange,
  onEffortChange,
  onPhaseChange,
  catalog,
}: ModelStepProps): React.JSX.Element {
  const isCodex = provider === 'codex';
  const loading = isCodex && catalog.loading;
  const failed = isCodex && !catalog.loading && catalog.error !== null;
  // A blocked catalog has no list to render OR collapse, so the MODEL section
  // shows a well in place of both phases.
  const catalogBlocked = loading || failed;
  const rows = isCodex ? codexRows(catalog.options) : claudeRows();
  const chosen = rows.find((row) => row.id === model) ?? (model === null ? null : { id: model, label: model, hint: '' });
  // Effort is the second question, revealed once a model is settled — or shown
  // straight away when the catalog is blocked, since the model question then has
  // no answer to wait for (loading renders it inert, per the design).
  const showEffort = phase === 'effort' || catalogBlocked;
  const hints = EFFORT_HINTS[provider];

  return (
    <div className="px-6 pb-2 pt-[15px]">
      <div className="mb-2.5 text-[11.5px] leading-[1.55] text-text-primary">
        Defaults for {isCodex ? 'Codex' : 'Claude'} — every launch can still override them.
      </div>

      <SectionLabel first>MODEL</SectionLabel>
      {loading ? (
        <div className="border border-dashed border-border-primary bg-[var(--paper-3)] px-4 py-[26px]">
          <LoadingSpinner text="Loading models from the Codex SDK…" size="small" />
        </div>
      ) : failed ? (
        <div className="flex items-center gap-3 border border-dashed border-border-primary bg-[var(--paper-3)] px-4 py-[18px]">
          <span className="min-w-0 flex-1 text-[10.5px] leading-[1.5] text-text-secondary">
            Couldn&apos;t reach the Codex SDK.
          </span>
          <button
            type="button"
            onClick={catalog.onRetry}
            className="flex-shrink-0 border border-border-primary bg-transparent px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[.12em] text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary"
          >
            Retry
          </button>
        </div>
      ) : phase === 'effort' && chosen !== null ? (
        <div className={`${ROW_BASE} border border-border-emphasized`} role="radio" aria-checked="true">
          {radioCircle(true)}
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] font-bold text-text-primary">
              {chosen.label}
            </span>
            {chosen.hint && (
              <span className="min-w-0 truncate text-[9px] tracking-[.04em] text-text-tertiary">
                {chosen.hint}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => onPhaseChange('model')}
            className="flex-shrink-0 border-none bg-transparent p-0 text-[9px] font-bold tracking-[.1em] text-interactive transition-opacity hover:opacity-80"
          >
            CHANGE
          </button>
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label="Default model"
          className="flex flex-col gap-[5px]"
        >
          {rows.map((row) => {
            const selected = row.id === model;
            return (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onModelChange(row.id)}
                className={`${ROW_BASE} ${
                  selected
                    ? 'border border-border-emphasized'
                    : 'border border-border-primary hover:border-border-emphasized'
                }`}
              >
                {radioCircle(selected)}
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  {/* The id is the identity — it never wraps; the tagline gives way. */}
                  <span className="flex-shrink-0 whitespace-nowrap text-[11.5px] font-bold text-text-primary">
                    {row.label}
                  </span>
                  {row.hint && (
                    <span className="min-w-0 truncate text-[9px] tracking-[.04em] text-text-tertiary">
                      {row.hint}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showEffort && (
        <>
          <SectionLabel>REASONING EFFORT</SectionLabel>
          <div
            role="radiogroup"
            aria-label="Default reasoning effort"
            aria-disabled={loading || undefined}
            className="flex flex-col gap-[5px]"
            style={loading ? { opacity: 0.45 } : undefined}
          >
            {effortLevelsForProvider(provider).map((level) => {
              const selected = level === effort;
              const hint = hints[level];
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={loading}
                  onClick={() => onEffortChange(level)}
                  className={`${ROW_BASE} ${
                    selected
                      ? 'border border-border-emphasized'
                      : 'border border-border-primary hover:border-border-emphasized'
                  } ${loading ? 'cursor-not-allowed' : ''}`}
                >
                  {radioCircle(selected)}
                  <span className="flex-1 text-[11.5px] font-bold text-text-primary">
                    {effortLabel(level)}
                  </span>
                  {hint && (
                    <span className="flex-shrink-0 text-[9px] tracking-[.04em] text-text-tertiary">
                      {hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-2.5 text-[9.5px] leading-[1.5] text-text-tertiary">
        {isCodex
          ? 'Model list comes live from the Codex SDK.'
          : 'This step follows your default agent — with Codex picked it offers Codex models and its effort scale instead.'}
      </div>
    </div>
  );
}
