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
export const MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string; description: string }> = [
  { id: 'auto', label: 'Auto', description: 'Let Claude pick the model' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced · 1M context' },
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest' },
];

const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  MODEL_OPTIONS.map((o) => [o.id, o.label]),
);

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
  const label = MODEL_LABELS[active] ?? active;

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
    label: o.label,
    description: o.description,
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
