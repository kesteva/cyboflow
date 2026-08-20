/**
 * RunTypeOverrideDetail — the per-session-type override screen reached from the
 * "Session type overrides" list (Settings → AI → Session settings).
 *
 * Knob cards, each with an "Override defaults" switch: OFF renders the card
 * dimmed and tagged `from defaults · <value>`; ON renders live controls, tagging
 * each changed field `overridden · default is <value>`.
 *
 * ## Two deliberate scope decisions
 *
 * 1. **Only knob cards backed by a real `RunTypeDefaults` field are rendered**
 *    (see {@link knobCardsFor} for which fields those are and why the list
 *    stops there).
 * 2. **Reasoning effort is Quick-Session-only.** `runs.start` carries no
 *    `reasoningEffort` field, so a flow-type effort override has no sink.
 *
 * ## The runtime-family invariant is enforced on EVERY edit path
 *
 * A saved override must never describe a combination no launch can honour (a
 * Claude model under a Codex runtime, a substrate the runtime contradicts).
 * That holds only because the controls are scoped to the draft's EFFECTIVE
 * runtime AND every setter coerces — see {@link fieldOptions} and `setField`.
 * Coercing on the `agentRuntime` pick alone is not enough: the reverse edit
 * order (runtime first, model second) walked straight back into the pair.
 *
 * ## Why Save writes through `configStore.applyRunTypeDefault` directly
 *
 * It must NOT route through `Settings.tsx`'s shared `handleSubmit`. That form
 * is a merge-a-slice pattern — e.g. `visualVerify: { ..._config?.visualVerify,
 * ... }` (Settings.tsx's `handleSubmit`) — built from `_config`, which is
 * snapshotted once when the modal opens and never refreshed. `runTypeDefaults`
 * is never part of that submit payload at all; routing this screen's writes
 * through it would still be an unguarded read-before-write of the STALE
 * snapshot, clobbering a default saved from a launch screen while this modal
 * sat open. The dedicated per-key IPC op (`applyRunTypeDefault`) is the only
 * write channel that reads and writes the LIVE config.
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import { useConfigStore } from '../../stores/configStore';
import { useCodexModelCatalog } from '../../stores/codexModelCatalogStore';
import { useOmpModelCatalog } from '../../stores/ompModelCatalogStore';
import { useOmpAvailability, type OmpAvailability } from '../../hooks/useOmpAvailability';
import {
  RUN_TYPE_EFFORT_OPTIONS,
  RUN_TYPE_MODEL_OPTIONS,
  RUN_TYPE_FIELD_LABELS,
  agentRuntimePickerOptions,
  runtimeUnavailableReason,
  baselineValueFor,
  coerceDraftForModel,
  coerceDraftForRuntime,
  coerceDraftForSubstrate,
  draftFromStored,
  draftRuntimeProvider,
  isQuickRunTypeKey,
  patchFromDraft,
  runTypeValueLabel,
  type RunTypeBaseline,
  type RunTypeDraft,
  type RunTypeFieldId,
} from './runTypeOverrides';
import { AGENT_PROVIDER_LABELS } from '../../../../shared/types/agentRuntime';
import type { AgentProvider, AgentRuntime } from '../../../../shared/types/agentRuntime';
import type { CodexModelOption, OmpModelOption } from '../../../../shared/types/agentModels';
import type { ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import type { RunTypeDefaults } from '../../../../shared/types/sessionDefaults';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { PermissionMode } from '../../../../shared/types/workflows';
import { PERMISSION_MODE_OPTIONS } from '../cyboflow/AgentPermissionModeSelector';

interface KnobCard {
  id: string;
  title: string;
  description: string;
  fields: readonly RunTypeFieldId[];
}

/**
 * The knob cards for one key. THIS LIST IS DELIBERATELY SHORT — see the module
 * doc's "Two deliberate scope decisions". The original copy also named a
 * "Runtime & orchestration" and a "Quality eval" card; neither has a backing
 * field (`RunTypeDefaults` has no `executionModel` and no eval member), so
 * rendering either would be a control that silently does nothing. Do NOT
 * "restore" them without adding the storage + launch plumbing to match.
 */
function knobCardsFor(runTypeKey: string): KnobCard[] {
  const quick = isQuickRunTypeKey(runTypeKey);
  return [
    {
      id: 'model',
      title: quick ? 'Model & reasoning effort' : 'Model',
      description: quick
        ? 'Which model a new quick session starts on, and how hard it thinks.'
        : 'Which model this flow’s runs start on.',
      // Effort has a sink only on the quick-session launch path.
      fields: quick ? (['model', 'reasoningEffort'] as const) : (['model'] as const),
    },
    {
      id: 'runtime',
      title: 'Runtime',
      description: 'Which CLI substrate and agent runtime the launch uses.',
      fields: ['substrate', 'agentRuntime'] as const,
    },
    {
      id: 'permission',
      title: 'Permission mode',
      description: 'How the agent handles tool use that touches your files.',
      fields: ['permissionMode'] as const,
    },
  ];
}

export interface RunTypeOverrideDetailProps {
  /** `runTypeDefaults` key being edited (`quick` or `workflow:<id>`). */
  runTypeKey: string;
  /** Display name for the breadcrumb + header. */
  title: string;
  /** One-line description under the header; `''` to omit. */
  subtitle: string;
  /** The currently-stored sparse override for this key (undefined = none). */
  stored: RunTypeDefaults | undefined;
  /** The global baseline every unset field falls through to. */
  baseline: RunTypeBaseline;
  /** Return to the list (Cancel, breadcrumb, and after a successful Save/Reset). */
  onClose: () => void;
}

export function RunTypeOverrideDetail({
  runTypeKey,
  title,
  subtitle,
  stored,
  baseline,
  onClose,
}: RunTypeOverrideDetailProps): React.JSX.Element {
  const applyRunTypeDefault = useConfigStore((s) => s.applyRunTypeDefault);
  const [draft, setDraft] = useState<RunTypeDraft>(() => draftFromStored(stored));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Every control is scoped to the runtime this key would ACTUALLY launch on
  // (the draft's own override, else the baseline) — offering another family's
  // options is what let a cross-family pair be assembled in the first place.
  // Codex and OMP models come from the same catalog stores the launch pickers
  // read (`ModelSelector` / `ModelPill`), never from a second hardcoded list.
  const provider = draftRuntimeProvider(draft, baseline);
  const usesCodex = provider === 'codex';
  const { options: codexModelOptions } = useCodexModelCatalog(usesCodex);
  const { options: ompModelOptions } = useOmpModelCatalog(provider === 'omp');

  // Re-seed when the key changes (list → another type without unmounting).
  // `stored` is intentionally not a dependency: a config refetch mid-edit must
  // not silently discard the user's in-progress draft.
  useEffect(() => {
    setDraft(draftFromStored(stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key-scoped reseed only
  }, [runTypeKey]);

  const cards = knobCardsFor(runTypeKey);

  /**
   * EVERY family-bearing field coerces, not just `agentRuntime` — the invariant
   * ("a cross-family combination is never savable") has to hold in every edit
   * order, and coercing only on the runtime pick left the reverse order
   * (runtime first, model/substrate second) able to reassemble the exact pair
   * the runtime pick had just removed.
   */
  const setField = (field: RunTypeFieldId, value: string | null): void => {
    setDraft((prev) => {
      switch (field) {
        case 'model':
          return coerceDraftForModel(prev, value, baseline);
        case 'reasoningEffort':
          return { ...prev, reasoningEffort: value as ReasoningEffort | null };
        case 'substrate':
          return coerceDraftForSubstrate(prev, value as CliSubstrate | null);
        case 'agentRuntime':
          // A concrete pick goes through the SAME runtime-family coercion the
          // launch surfaces apply (WorkflowPicker / SessionStartWizard): it
          // must never leave the draft able to save an unlaunchable
          // model/runtime/substrate combination. Clearing back to "follow
          // defaults" is NOT a no-op either — the draft then falls through to
          // the (always-Claude) baseline runtime, so a Codex model left over
          // from the override has to be coerced with it.
          return value === null
            ? coerceDraftForModel({ ...prev, agentRuntime: null }, prev.model, baseline)
            : coerceDraftForRuntime(prev, value as AgentRuntime, baseline);
        case 'permissionMode':
          return { ...prev, permissionMode: value as PermissionMode | null };
      }
    });
  };

  // Which OMP flavor this install runs (Aria mode) — the runtime picker offers
  // the remote fleet OR the local runtimes, never both. Same source the launch
  // picker reads, so the two surfaces cannot disagree.
  const omp = useOmpAvailability();

  const draftValue = (field: RunTypeFieldId): string | null => draft[field];

  const cardIsOn = (card: KnobCard): boolean => card.fields.some((f) => draftValue(f) !== null);

  /**
   * The value a field starts at when its card is switched ON: normally the
   * baseline, so the control opens showing what the launch would have used.
   *
   * `model` needs a second rung because its baseline is the always-Claude floor
   * (`DEFAULT_RUN_TYPE_MODEL_FLOORS`), which a non-Claude provider legitimately
   * refuses — `coerceModelForRuntime` returns `null` for it under OMP, since
   * absence there means "OMP picks its own default". Seeding that `null` would
   * make the card UNOPENABLE rather than merely unset: `cardIsOn` is DERIVED
   * from "some field is non-null", so the switch flips straight back off and no
   * amount of clicking can ever reveal the control. Falling back to the first
   * option the control will actually offer keeps the seed launchable by
   * construction — it comes from the same `fieldOptions` list that renders.
   *
   * Residual: a provider whose catalog is still loading (or failed) offers
   * nothing, so the card stays closed until it arrives. That is honest — there
   * is no model to pick yet — but it is indistinguishable from the switch being
   * broken, which is why the catalog is fetched eagerly for the draft provider.
   */
  const seedValueFor = (field: RunTypeFieldId): string | null => {
    const fromBaseline = baselineValueFor(field, baseline);
    if (field !== 'model') return fromBaseline;
    const coerced = coerceDraftForModel(draft, fromBaseline, baseline).model;
    if (coerced !== null) return coerced;
    const offered = fieldOptions(field, runTypeKey, provider, codexModelOptions, ompModelOptions, omp, draftValue('agentRuntime'));
    return offered[0]?.id ?? null;
  };

  /**
   * Flipping a card ON seeds each of its fields from {@link seedValueFor} so the
   * control starts at the value the launch would have used; effort has no
   * baseline, so it stays unset ("Follow defaults") until the user picks a
   * level. Flipping OFF clears every field in the card back to "follow
   * defaults".
   */
  const toggleCard = (card: KnobCard, next: boolean): void => {
    for (const field of card.fields) {
      setField(field, next ? seedValueFor(field) : null);
    }
  };

  // Both writers close the screen ONLY on a confirmed `{ ok: true }` — a
  // failed write must keep the draft on screen with the error visible rather
  // than closing as if the save/reset had landed (COR-4-class bug: a
  // discarded result reports a failed write as success).
  const handleSave = async (): Promise<void> => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await applyRunTypeDefault(runTypeKey, {
        kind: 'merge',
        value: patchFromDraft(draft),
      });
      if (result.ok) {
        onClose();
      } else {
        setSaveError(result.error);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await applyRunTypeDefault(runTypeKey, { kind: 'replace', value: null });
      if (result.ok) {
        onClose();
      } else {
        setSaveError(result.error);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const renderControl = (field: RunTypeFieldId): React.JSX.Element => {
    const value = draftValue(field);
    const base = baselineValueFor(field, baseline);
    const changed = value !== null && value !== base;
    const selectId = `run-type-${field}`;
    const options = fieldOptions(field, runTypeKey, provider, codexModelOptions, ompModelOptions, omp, draftValue('agentRuntime'));
    // "Follow defaults" is unavailable for a CODEX model, exactly as on the
    // launch pickers: an omitted model member resolves to the always-Claude
    // floor, so offering it here would BE the cross-family pair rather than an
    // escape from it. It stays available on OMP, whose spawn seam DROPS that
    // Claude floor (`normalizeAgentModelSelection`) and starts on OMP's own
    // default — see `coerceModelForRuntime`, which encodes the same split.
    const allowFollowDefaults = !(field === 'model' && usesCodex);
    // A non-Claude runtime carries no sdk/interactive transport of its own, so
    // there is no substrate to pick — the control states that instead of
    // offering a value the resolved runtime would contradict.
    const notApplicable = field === 'substrate' && provider !== 'claude';
    return (
      <div key={field} className="flex flex-col gap-1" data-testid={`run-type-field-${field}`}>
        <label htmlFor={selectId} className="text-xs font-medium text-text-secondary">
          {RUN_TYPE_FIELD_LABELS[field]}
        </label>
        <select
          id={selectId}
          value={value ?? ''}
          disabled={notApplicable}
          onChange={(e) => setField(field, e.target.value === '' ? null : e.target.value)}
          className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary disabled:opacity-50"
        >
          {allowFollowDefaults && <option value="">Follow defaults</option>}
          {renderFieldOptions(options)}
        </select>
        {notApplicable && (
          <span className="text-xs text-text-tertiary" data-testid={`run-type-na-${field}`}>
            Not applicable · the selected {AGENT_PROVIDER_LABELS[provider]} runtime has no substrate
          </span>
        )}
        {changed && !notApplicable && (
          <span className="text-xs text-text-tertiary" data-testid={`run-type-changed-${field}`}>
            {base === null
              ? 'overridden · no global default'
              : `overridden · default is ${runTypeValueLabel(field, base)}`}
          </span>
        )}
      </div>
    );
  };

  const renderDefaultTag = (field: RunTypeFieldId): React.JSX.Element => {
    const base = baselineValueFor(field, baseline);
    return (
      <div
        key={field}
        className="flex items-center justify-between gap-3 text-xs"
        data-testid={`run-type-field-${field}`}
      >
        <span className="text-text-tertiary">{RUN_TYPE_FIELD_LABELS[field]}</span>
        <span className="text-text-tertiary">
          {base === null ? 'from defaults · not set' : `from defaults · ${runTypeValueLabel(field, base)}`}
        </span>
      </div>
    );
  };

  return (
    <div data-testid="run-type-detail">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
      >
        <ChevronLeft className="w-3 h-3" />
        Session settings / {title}
      </button>

      <div className="mt-3 mb-4">
        <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
        {subtitle !== '' && <p className="text-xs text-text-tertiary mt-1">{subtitle}</p>}
      </div>

      <div className="flex flex-col gap-3">
        {cards.map((card) => {
          const on = cardIsOn(card);
          return (
            <div
              key={card.id}
              data-testid={`knob-card-${card.id}`}
              className={`rounded-button border p-3 transition-colors ${
                on ? 'border-interactive bg-interactive-surface' : 'border-border-secondary bg-surface-secondary'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={`text-sm font-medium ${on ? 'text-text-primary' : 'text-text-secondary'}`}>
                    {card.title}
                  </div>
                  <p className="text-xs text-text-tertiary mt-0.5">{card.description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`Override defaults for ${card.title}`}
                  onClick={() => toggleCard(card, !on)}
                  className={`shrink-0 px-2 py-1 rounded-button border text-xs transition-colors ${
                    on
                      ? 'border-interactive text-text-primary'
                      : 'border-border-secondary text-text-tertiary hover:bg-surface-hover'
                  }`}
                >
                  Override defaults
                </button>
              </div>

              <div className={`mt-3 flex flex-col gap-2 ${on ? '' : 'opacity-60'}`}>
                {card.fields.map((field) => (on ? renderControl(field) : renderDefaultTag(field)))}
              </div>
            </div>
          );
        })}
      </div>

      {saveError !== null && (
        <p
          role="alert"
          data-testid="run-type-save-error"
          className="mt-3 text-xs leading-relaxed text-status-error"
        >
          {saveError}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-secondary pt-3">
        <button
          type="button"
          onClick={() => void handleReset()}
          disabled={isSaving}
          className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50"
        >
          <RotateCcw className="w-3 h-3" />
          Reset {title} to defaults
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="px-3 py-1.5 rounded-button border border-border-secondary text-sm text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="px-3 py-1.5 rounded-button bg-interactive text-text-on-interactive text-sm hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

interface FieldOption {
  id: string;
  label: string;
  /**
   * Offered but not selectable on this machine — the label already names why
   * (e.g. an omp-fleet row with no bridge configured). Distinct from an absent
   * option: the row exists so the setting explains itself.
   */
  disabled?: boolean;
  /**
   * Optional section heading. Only OMP sets it — its catalog fronts many
   * vendors (495 rows across anthropic / openai-codex / openrouter on the
   * author's host), so a flat list is unnavigable. Consecutive options sharing
   * a group render inside one <optgroup>.
   */
  group?: string;
}

/** Options as <option>s, folding any consecutive same-`group` run into an <optgroup>. */
function renderFieldOptions(options: readonly FieldOption[]): React.JSX.Element[] {
  const nodes: React.JSX.Element[] = [];
  let index = 0;
  while (index < options.length) {
    const group = options[index]!.group;
    if (group === undefined) {
      const option = options[index]!;
      nodes.push(
        <option key={option.id} value={option.id} disabled={option.disabled === true}>
          {option.label}
        </option>,
      );
      index += 1;
      continue;
    }
    const run: FieldOption[] = [];
    while (index < options.length && options[index]!.group === group) {
      run.push(options[index]!);
      index += 1;
    }
    nodes.push(
      <optgroup key={group} label={group}>
        {run.map((option) => (
          <option key={option.id} value={option.id} disabled={option.disabled === true}>
            {option.label}
          </option>
        ))}
      </optgroup>,
    );
  }
  return nodes;
}

/** Option ids labelled from the same maps the chips and pickers already use. */
function labelled(field: RunTypeFieldId, ids: readonly string[]): FieldOption[] {
  return ids.map((id) => ({ id, label: runTypeValueLabel(field, id) }));
}

/**
 * The options offered for one field on one key, scoped to the PROVIDER the key
 * would actually launch on.
 *
 * `model` is the load-bearing one: an unconditional Claude list let a Codex or
 * OMP runtime be paired with a Claude alias no matter how carefully the runtime
 * pick coerced. Each non-Claude list is the SAME catalog the launch pickers
 * render (`ModelSelector` / `ModelPill` via `useCodexModelCatalog` /
 * `useOmpModelCatalog`), so Settings cannot offer a model a launch would not.
 *
 * `substrate` collapses to nothing on a non-Claude runtime — neither family has
 * an sdk/interactive transport, so every value would disagree with the runtime.
 */
function fieldOptions(
  field: RunTypeFieldId,
  runTypeKey: string,
  provider: AgentProvider,
  codexModels: readonly CodexModelOption[],
  ompModels: readonly OmpModelOption[],
  omp: OmpAvailability,
  currentRuntime: string | null,
): readonly FieldOption[] {
  switch (field) {
    case 'model':
      if (provider === 'codex') return codexModels.map((o) => ({ id: o.id, label: o.label }));
      if (provider === 'omp') {
        return ompModels.map((o) => ({ id: o.id, label: o.label, group: o.ompProvider }));
      }
      return labelled(field, RUN_TYPE_MODEL_OPTIONS.map((o) => o.id));
    case 'reasoningEffort':
      return labelled(field, RUN_TYPE_EFFORT_OPTIONS);
    case 'substrate':
      return provider === 'claude' ? labelled(field, ['sdk', 'interactive']) : [];
    case 'agentRuntime':
      return agentRuntimePickerOptions(runTypeKey, omp, currentRuntime).map((runtime) => {
        const reason = runtimeUnavailableReason(runtime, omp);
        const base = runTypeValueLabel(field, runtime);
        return reason === null
          ? { id: runtime, label: base }
          : { id: runtime, label: `${base} (${reason})`, disabled: true };
      });
    case 'permissionMode':
      return labelled(field, PERMISSION_MODE_OPTIONS.map((o) => o.id));
  }
}
