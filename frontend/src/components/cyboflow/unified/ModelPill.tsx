import { useState } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import { API } from '../../../utils/api';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Pill } from '../../ui/Pill';
import { cn } from '../../../utils/cn';

/**
 * ModelPill — interactive model selector for a quick SDK session's composer.
 *
 * Replaces the read-only "Sonnet 🔒" pill. Persists the choice via the existing
 * `claude-panels:set-model` IPC (panel settings), which takes effect on the NEXT
 * turn — each quick-SDK turn re-spawns the SDK process and reads the model — so
 * no respawn is needed here. Mirrors the CommitModePill pattern (Dropdown + Pill
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

// Opus is listed once per context window (1M / 250K); the spawn seam
// (modelContext.ts) maps `opus`→4.8[1m], `opus-250k`→4.8. Sonnet 5 is 1M-native
// (no context-1m beta, no 250K mode), so it has a single honest 1M row; the
// `sonnet-250k` alias stays resolvable (→ Sonnet 5) for back-compat but is not
// offered here.
export const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  { id: 'opus', label: 'Opus 4.8', context: '1M', description: 'Most capable' },
  { id: 'opus-250k', label: 'Opus 4.8', context: '250K', description: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet 5', context: '1M', description: 'Balanced' },
  { id: 'haiku', label: 'Haiku 4.5', context: '200K', description: 'Fastest' },
  { id: 'auto', label: 'Auto', context: null, description: 'Let Claude pick the model' },
];

const OPTION_BY_ID = new Map(MODEL_OPTIONS.map((o) => [o.id, o] as const));

/** Compact "version · context" display for a model id (falls back to the raw id). */
export function modelDisplayLabel(id: string | null | undefined): string {
  const active = id ?? 'auto';
  const o = OPTION_BY_ID.get(active);
  if (!o) return active;
  return o.context ? `${o.label} · ${o.context}` : o.label;
}

/** Whether a picker model id is an Opus variant — fast mode is Opus-only. */
export function isOpusModel(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.toLowerCase().includes('opus');
}

interface ModelPillProps {
  panelId: string;
  /** Current model id/alias (e.g. 'sonnet'); null falls back to the 'auto' display. */
  currentModel: string | null;
  /** Invoked after the model is persisted so the host updates its local state. */
  onModelChange: (model: string) => void;
}

export function ModelPill({ panelId, currentModel, onModelChange }: ModelPillProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const active = currentModel ?? 'auto';
  const label = modelDisplayLabel(active);

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

  const items: DropdownItem[] = MODEL_OPTIONS.map((o) => ({
    id: o.id,
    label: o.context ? `${o.label} · ${o.context}` : o.label,
    description: o.context ? `${o.description} · ${o.context} context` : o.description,
    icon: Cpu,
    iconColor: 'text-text-secondary',
    onClick: () => void handleSelect(o.id),
    variant: 'default',
  }));

  const trigger = (
    <Pill
      variant="default"
      icon={<Cpu className="w-3.5 h-3.5 text-text-secondary" />}
      className="transition-all duration-200 shadow-sm"
      title="Model — applies on your next message"
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
