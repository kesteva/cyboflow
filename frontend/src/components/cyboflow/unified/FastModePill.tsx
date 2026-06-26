import { Zap } from 'lucide-react';
import { API } from '../../../utils/api';
import { TogglePill } from '../../ui/Pill';

/**
 * FastModePill — the Opus-only "Fast" opt-in for a quick SDK session's composer,
 * shown next to the Checkpoint pill. Fast mode is the premium Opus-only research
 * preview (faster output); it has no effect on other models, so the host only
 * mounts this pill while Opus is the selected model.
 *
 * Persists via `claude-panels:set-fast-mode` (panel settings), which threads into
 * the next turn's buildSdkOptions — so, like the model pill, the change applies on
 * the user's next message and no respawn is needed here.
 */
interface FastModePillProps {
  panelId: string;
  /** Current persisted opt-in. */
  fastMode: boolean;
  /** Invoked after the toggle is persisted so the host updates its local state. */
  onChange: (fastMode: boolean) => void;
}

export function FastModePill({ panelId, fastMode, onChange }: FastModePillProps): React.ReactElement {
  const handleToggle = async (next: boolean): Promise<void> => {
    try {
      const res = await API.claudePanels.setFastMode(panelId, next);
      if (res.success) onChange(next);
      else console.error('Failed to set fast mode:', res.error);
    } catch (err) {
      console.error('Failed to set fast mode:', err);
    }
  };

  return (
    <TogglePill
      checked={fastMode}
      onCheckedChange={(v) => void handleToggle(v)}
      icon={<Zap className="h-2.5 w-2.5" />}
      title="Fast mode — faster Opus output · premium · applies on your next message"
      data-testid="composer-fast-mode-pill"
    >
      Fast
    </TogglePill>
  );
}
