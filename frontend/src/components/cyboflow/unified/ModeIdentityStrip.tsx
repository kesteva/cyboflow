import { ChatStatusPill } from './ChatStatusPill';
import {
  resolveChatStatus,
  type ChatMode,
  type ChatTransport,
} from './useChatVisibility';

/**
 * Mode-identity strip — the 30px row under the chat's top edge:
 *   <name> · <TRANSPORT> transport · quick session|flow run · [status pill]
 *
 * Constant across all four matrix cells; only the values + pill swap. The
 * transport label follows the design packet's vocabulary (sdk → SDK,
 * interactive → PTY) even though the codebase substrate is 'interactive'.
 */
export interface ModeIdentityStripProps {
  /** session/panel label, e.g. "Claude 1" (SDK) or "Terminal" (PTY). */
  name: string;
  transport: ChatTransport;
  mode: ChatMode;
  running: boolean;
}

export function ModeIdentityStrip({
  name,
  transport,
  mode,
  running,
}: ModeIdentityStripProps): React.ReactElement {
  const status = resolveChatStatus({ mode, running });
  const transportLabel = transport === 'sdk' ? 'SDK' : 'PTY';
  return (
    <div
      data-testid="chat-mode-identity"
      className="flex h-[30px] shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap border-b border-border-primary bg-surface-tertiary px-4 text-[10px] text-text-tertiary"
    >
      <b className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-text-primary">
        {name}
      </b>
      <span className="text-text-disabled">·</span>
      <span>{transportLabel} transport</span>
      <span className="text-text-disabled">·</span>
      <span>{mode === 'quick' ? 'quick session' : 'flow run'}</span>
      <span className="flex-1" />
      <ChatStatusPill status={status} />
    </div>
  );
}
