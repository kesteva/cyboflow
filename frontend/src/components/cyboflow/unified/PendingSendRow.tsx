/**
 * PendingSendRow — the pinned optimistic-echo strip rendered between the chat
 * transcript and the composer (see UnifiedChatView). Each entry is a message the
 * user just sent that has not yet surfaced as a real transcript row:
 *
 *   - 'sending' — dispatched, awaiting its transcript echo. Subtle spinner; not
 *                 clickable (it will reconcile itself momentarily).
 *   - 'queued'  — buffered server-side, will be delivered at the next turn
 *                 boundary. Distinct "queued" treatment; click to reopen (pulls
 *                 the text back into the composer and dequeues it).
 *   - 'failed'  — the dispatch rejected. Error treatment; click to reopen (pulls
 *                 the text back into the composer to retry).
 *
 * Presentational only: it reads the entries + a reopen callback from the host and
 * owns no state. Styling matches the composer's paper-aesthetic tokens.
 */
import { Loader2, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '../../../utils/cn';
import type { PendingSend } from '../../../stores/pendingSendStore';

export interface PendingSendRowProps {
  entries: PendingSend[];
  /** Reopen a 'queued'/'failed' entry — repopulate the composer + remove it. */
  onReopen: (entry: PendingSend) => void;
}

export function PendingSendRow({ entries, onReopen }: PendingSendRowProps): React.ReactElement | null {
  if (entries.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-t border-border-primary bg-bg-primary px-4 pt-2"
      data-testid="pending-send-row"
    >
      {entries.map((entry) => {
        const reopenable = entry.status === 'queued' || entry.status === 'failed';
        return (
          <button
            key={entry.id}
            type="button"
            disabled={!reopenable}
            onClick={reopenable ? () => onReopen(entry) : undefined}
            data-testid={`pending-send-${entry.status}`}
            title={
              entry.status === 'sending'
                ? 'Sending…'
                : entry.status === 'queued'
                  ? 'Queued — will send at the next pause. Click to edit.'
                  : 'Send failed. Click to edit and retry.'
            }
            className={cn(
              'flex items-start gap-2 border px-3 py-2 text-left text-xs transition-colors',
              entry.status === 'failed'
                ? 'border-status-error/40 bg-status-error/5 text-status-error'
                : entry.status === 'queued'
                  ? 'border-dashed border-border-hover bg-surface-secondary text-text-secondary'
                  : 'border-border-primary bg-surface-secondary text-text-tertiary',
              reopenable ? 'cursor-pointer hover:border-interactive' : 'cursor-default',
            )}
          >
            <span className="mt-0.5 shrink-0">
              {entry.status === 'sending' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : entry.status === 'queued' ? (
                <Clock className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">
                {entry.status === 'sending'
                  ? 'Sending'
                  : entry.status === 'queued'
                    ? 'Queued · click to edit'
                    : 'Failed · click to retry'}
              </span>
              <span className="block whitespace-pre-wrap break-words font-mono">{entry.text}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
