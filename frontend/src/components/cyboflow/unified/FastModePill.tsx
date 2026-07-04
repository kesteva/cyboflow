import { TriangleAlert, Zap } from 'lucide-react';
import { API } from '../../../utils/api';
import { TogglePill } from '../../ui/Pill';
import type { FastModeStateNotice } from '../../../../../shared/types/panels';

/**
 * FastModePill — the Opus-only "Fast" opt-in for a quick SDK session's composer,
 * shown next to the Checkpoint pill. Fast mode is the premium Opus-only research
 * preview (faster output); it has no effect on other models, so the host only
 * mounts this pill while Opus is the selected model.
 *
 * Persists via `claude-panels:set-fast-mode` (panel settings), which threads into
 * the next turn's buildSdkOptions — so, like the model pill, the change applies on
 * the user's next message and no respawn is needed here.
 *
 * The toggle records the REQUEST; the CLI can still decline it (boot-time
 * org/entitlement check — fast mode needs extra usage enabled — or a rate-limit
 * cooldown). When the latest turn REQUESTED fast mode but reported a
 * `fast_mode_state` other than 'on', the pill shows a warning glyph + an honest
 * tooltip instead of silently implying fast output.
 */
interface FastModePillProps {
  panelId: string;
  /** Current persisted opt-in. */
  fastMode: boolean;
  /** Invoked after the toggle is persisted so the host updates its local state. */
  onChange: (fastMode: boolean) => void;
  /**
   * Latest CLI-reported fast-mode state for this panel (null until a turn has
   * reported). Only a report whose spawn actually requested fast mode can
   * trigger the warning — a stale "off" from a pre-toggle turn never does.
   */
  report?: FastModeStateNotice | null;
}

export function FastModePill({ panelId, fastMode, onChange, report = null }: FastModePillProps): React.ReactElement {
  const handleToggle = async (next: boolean): Promise<void> => {
    try {
      const res = await API.claudePanels.setFastMode(panelId, next);
      if (res.success) onChange(next);
      else console.error('Failed to set fast mode:', res.error);
    } catch (err) {
      console.error('Failed to set fast mode:', err);
    }
  };

  const declined = fastMode && report !== null && report.requestedFast && report.state !== 'on';
  const title = declined
    ? report.state === 'cooldown'
      ? 'Fast mode is cooling down after a rate limit — turns run at standard speed for now'
      : 'Fast mode requested but not active — your account may need extra usage enabled (turns ran at standard speed)'
    : 'Fast mode — faster Opus output · premium · applies on your next message';

  return (
    <TogglePill
      checked={fastMode}
      onCheckedChange={(v) => void handleToggle(v)}
      icon={<Zap className="h-2.5 w-2.5" />}
      title={title}
      data-testid="composer-fast-mode-pill"
      data-fast-declined={declined ? report.state : undefined}
    >
      Fast
      {declined && (
        <TriangleAlert
          className="h-3 w-3 text-status-warning"
          data-testid="composer-fast-mode-warning"
          aria-label="Fast mode not active"
        />
      )}
    </TogglePill>
  );
}
