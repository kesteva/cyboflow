import { cn } from '../../../utils/cn';
import type { ChatStatusKind } from './useChatVisibility';

/**
 * The mode-identity status pill (top strip, right-aligned). Four states:
 * interactive (idle quick), generating (running quick), paused (idle flow),
 * executing (running flow). Running states get the rust accent + a pulsing dot;
 * idle states are muted. Pure presentational — derive `status` with
 * resolveChatStatus.
 */
export function ChatStatusPill({ status }: { status: ChatStatusKind }): React.ReactElement {
  const running = status === 'executing' || status === 'generating';
  return (
    <span
      data-testid="chat-status-pill"
      className={cn(
        'inline-flex items-center gap-1.5 border border-current px-2 py-0.5',
        'text-[9px] font-bold uppercase tracking-[0.16em]',
        running ? 'text-interactive' : 'text-text-tertiary',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full bg-current',
          running && 'motion-safe:animate-pulse',
        )}
      />
      {status}
    </span>
  );
}
