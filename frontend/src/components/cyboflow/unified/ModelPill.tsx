import { useState } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';
import { useModelAvailability } from '../../../stores/modelAvailabilityStore';
import { useCodexModelCatalog } from '../../../stores/codexModelCatalogStore';
import { useClaudeModelCatalog } from '../../../stores/claudeModelCatalogStore';
import { useOmpModelCatalog } from '../../../stores/ompModelCatalogStore';
import { groupOmpOptionsByProvider } from './ompModelGrouping';
import {
  AGENT_PROVIDER_LABELS,
  type AgentProvider,
} from '../../../../../shared/types/agentRuntime';
import type { ClaudeModelOption } from '../../../../../shared/types/agentModels';

/**
 * ModelPill — interactive model selector for a quick SDK session's composer.
 *
 * Replaces the read-only "Sonnet 🔒" pill. Persists the choice via the existing
 * `claude-panels:set-model` IPC (panel settings), which takes effect on the NEXT
 * turn — each quick-SDK turn re-spawns the SDK process and reads the model — so
 * no respawn is needed here. Uses the shared pill pattern (Dropdown + Pill
 * + onChange callback so the host updates its local model state immediately).
 *
 * Only mounted for non-running quick SDK sessions (see QuickSessionComposer); a
 * running turn shows the read-only pill instead, since a model change would be
 * discarded by the in-flight turn's already-chosen model.
 */
export interface ModelOption {
  /** Persisted id / alias (resolved to a concrete snapshot at the spawn seam). */
  id: string;
  /** Version label, e.g. "Opus 4.8". */
  label: string;
  /** Context-window label, e.g. "1M" / "250K" / "200K"; null for auto. */
  context: string | null;
  /** Short capability tagline. */
  description: string;
}

// Fable 5.1 is Anthropic's frontier model (1M-native, like Sonnet 5) and leads the
// list. Opus has a single honest 1M row; the spawn seam (modelContext.ts) maps
// `fable`→claude-fable-5-1, `opus`→claude-opus-5-5[1m] (the suffix is what actually
// unlocks 1M on the Claude Code login plane). The legacy `opus-250k` alias stays
// resolvable (→ Opus 4.8) for back-compat but is not offered here.
// Sonnet 5 is 1M-native (no context-1m beta, no 250K mode), so it has a single
// honest 1M row; the `sonnet-250k` alias stays resolvable (→ Sonnet 5) for
// back-compat but is not offered here. Fable can be pulled from availability (it
// has been before) — the picker greys it out when the availability guard reports
// it unavailable (see useModelAvailabilityStore / isModelOptionDisabled).
export const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  { id: 'fable', label: 'Fable 5.1', context: '1M', description: 'Frontier — most capable' },
  { id: 'opus', label: 'Opus 5.5', context: '1M', description: 'More capable' },
  { id: 'sonnet', label: 'Sonnet 5', context: '1M', description: 'Balanced' },
  { id: 'haiku', label: 'Haiku 4.5', context: '200K', description: 'Fastest' },
  { id: 'auto', label: 'Auto', context: null, description: 'Let Claude pick the model' },
];

const OPTION_BY_ID = new Map(MODEL_OPTIONS.map((o) => [o.id, o] as const));

/** Compact "version · context" display for a model id (falls back to the raw id). */
export function modelDisplayLabel(
  id: string | null | undefined,
  agentProvider: AgentProvider = 'claude',
): string {
  const active = id ?? 'auto';
  if (agentProvider === 'codex') return active === 'auto' ? 'Auto/default' : active;
  // OMP has no 'auto' value of its own — the absence of a selection already
  // means "use OMP's default" everywhere in this module, so 'Default' is the
  // honest label rather than borrowing Codex's synthesized 'Auto/default'.
  if (agentProvider === 'omp') return active === 'auto' ? 'Default' : active;
  const o = OPTION_BY_ID.get(active);
  if (!o) return active;
  return o.context ? `${o.label} · ${o.context}` : o.label;
}

/** Whether a picker model id is an Opus variant — fast mode is Opus-only. */
export function isOpusModel(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.toLowerCase().includes('opus');
}

/**
 * Friendly display label for a DYNAMIC ("Other models") Claude row, derived from
 * its concrete wire id so it disambiguates from the pinned families. The SDK's
 * bare `displayName` for a non-default snapshot is just the family (e.g. "Opus"),
 * which would collide with the pinned "Opus 5.5 · 1M" row — so we parse the version
 * (and 1M context) out of the resolved id instead: `claude-opus-4-8[1m]` →
 * "Opus 4.8 · 1M". Falls back to the SDK label / raw id if the id doesn't parse.
 */
export function formatDynamicClaudeLabel(option: ClaudeModelOption): string {
  const concrete = option.resolvedModel ?? option.id;
  const has1m = /\[1m\]$/i.test(concrete);
  const base = concrete.replace(/\[1m\]$/i, '').replace(/^claude-/i, '');
  const tokens = base.split('-').filter(Boolean);
  const family = tokens.shift();
  // Keep short numeric version segments (4, 8); drop date-like tokens (20251001).
  const version = tokens.filter((t) => /^\d{1,2}$/.test(t)).join('.');
  // Only trust the "Family Version" parse when a version was actually recovered —
  // otherwise the id is shaped unexpectedly and parsing would drop tokens, so we
  // fall back to the SDK's displayName / raw id instead.
  const parsed = family && version ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}` : '';
  const name = parsed || option.label || option.id;
  return has1m ? `${name} · 1M` : name;
}

interface ModelPillProps {
  panelId: string;
  /** Provider owning the panel settings; controls the visible model family. */
  agentProvider?: AgentProvider;
  /** Current model id/alias (e.g. 'sonnet'); null falls back to the 'auto' display. */
  currentModel: string | null;
  /** Invoked after the model is persisted so the host updates its local state. */
  onModelChange: (model: string) => void;
}

export function ModelPill({
  panelId,
  agentProvider = 'claude',
  currentModel,
  onModelChange,
}: ModelPillProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const isOmp = agentProvider === 'omp';
  const { isAliasUsable, unavailableReason } = useModelAvailability();
  const { options: codexCatalogOptions } = useCodexModelCatalog(agentProvider === 'codex');
  // Dynamic Claude catalog: the "Other models" the login can select, appended
  // below the four pinned families. Only fetched for a Claude picker.
  const { options: claudeCatalogOptions } = useClaudeModelCatalog(agentProvider !== 'codex' && !isOmp);
  const {
    options: ompCatalogOptions,
    loading: ompLoading,
    error: ompError,
  } = useOmpModelCatalog(isOmp);
  const ompGroups = groupOmpOptionsByProvider(ompCatalogOptions);
  const active = currentModel ?? 'auto';
  const codexOptions: ReadonlyArray<ModelOption> = codexCatalogOptions.map((option) => ({
    ...option,
    context: null,
  }));
  // OMP renders its own grouped item list below (no pinned families, no 'auto'
  // synthesis) rather than feeding the generic options.map loop, which assumes
  // the ModelOption shape (context/description) OMP's catalog does not carry.
  const options = isOmp ? [] : agentProvider === 'codex' ? codexOptions : MODEL_OPTIONS;
  // A dynamic (non-pinned) Claude id displays its friendly parsed label; a pinned
  // alias falls through to modelDisplayLabel (which knows the curated "Opus 5.5 · 1M").
  const claudeDynamicActive =
    agentProvider !== 'codex' && !isOmp
      ? claudeCatalogOptions.find((option) => option.id === active)
      : undefined;
  const claudeDynamicLabel = claudeDynamicActive
    ? formatDynamicClaudeLabel(claudeDynamicActive)
    : undefined;
  const ompActive = ompCatalogOptions.find((option) => option.id === active);
  const label = agentProvider === 'codex'
    ? (codexOptions.find((option) => option.id === active)?.label ?? modelDisplayLabel(active, agentProvider))
    : isOmp
      ? (ompActive?.label ?? modelDisplayLabel(active, agentProvider))
      : (claudeDynamicLabel ?? modelDisplayLabel(active, agentProvider));

  const handleSelect = async (model: string): Promise<void> => {
    setOpen(false);
    if (model === active) return;
    try {
      const res = await API.claudePanels.setModel(panelId, model);
      if (res.success) onModelChange(model);
      else console.error('Failed to set model:', res.error);
    } catch (err) {
      console.error('Failed to set model:', err);
    }
  };

  const items: DropdownItem[] = options.map((o) => {
    const usable = agentProvider === 'codex' || isAliasUsable(o.id);
    const baseLabel = o.context ? `${o.label} · ${o.context}` : o.label;
    return {
      id: o.id,
      label: usable ? baseLabel : `${baseLabel} — unavailable`,
      description: usable
        ? o.context
          ? `${o.description} · ${o.context} context`
          : o.description
        : (unavailableReason(o.id) ?? 'Currently unavailable — runs use Opus'),
      icon: Cpu,
      iconColor: 'text-text-secondary',
      onClick: () => {
        if (usable) void handleSelect(o.id);
      },
      disabled: !usable,
      variant: 'default',
    };
  });

  // "Other models" — the dynamic Claude catalog below the pinned four. A disabled,
  // non-clickable header row acts as the section divider (Dropdown has no separator).
  if (agentProvider !== 'codex' && !isOmp && claudeCatalogOptions.length > 0) {
    items.push({
      id: '__claude_other_models_header',
      label: 'Other models',
      description: 'Also available to your Claude Code login',
      disabled: true,
      variant: 'default',
    });
    for (const option of claudeCatalogOptions) {
      items.push({
        id: option.id,
        label: formatDynamicClaudeLabel(option),
        description: option.description || option.id,
        icon: Cpu,
        iconColor: 'text-text-secondary',
        onClick: () => void handleSelect(option.id),
        variant: 'default',
      });
    }
  }

  // OMP's catalog — grouped by ompProvider (e.g. 'anthropic', 'openai'), each
  // group under its own disabled header row (same divider idiom as "Other
  // models" above). No pinned families and no synthesized 'auto' row: the
  // catalog is the whole list, and every entry is directly usable (no
  // availability guard — that machinery is Claude-only).
  if (isOmp) {
    if (ompGroups.length === 0) {
      items.push({
        id: '__omp_empty',
        label: ompLoading ? 'Loading OMP models…' : ompError ? 'Could not load OMP models' : 'No OMP models available',
        disabled: true,
        variant: 'default',
      });
    }
    for (const [ompProvider, groupOptions] of ompGroups) {
      items.push({
        id: `__omp_group_${ompProvider}`,
        label: ompProvider,
        disabled: true,
        variant: 'default',
      });
      for (const option of groupOptions) {
        items.push({
          id: option.id,
          label: option.label,
          icon: Cpu,
          iconColor: 'text-text-secondary',
          onClick: () => void handleSelect(option.id),
          variant: 'default',
        });
      }
    }
  }

  const trigger = (
    <Pill
      variant="default"
      icon={<Cpu className="w-3.5 h-3.5 text-text-secondary" />}
      className="transition-all duration-200 shadow-sm"
      title={`${AGENT_PROVIDER_LABELS[agentProvider]} model — applies on your next message`}
    >
      {label}
      <ChevronDown
        className={cn('w-3 h-3 transition-transform text-text-secondary', open ? 'rotate-180' : '')}
      />
    </Pill>
  );

  return (
    <Dropdown trigger={trigger} items={items} selectedId={active} position="auto" onOpenChange={setOpen} />
  );
}
