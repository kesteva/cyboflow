import { Folder, GitBranch } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { parseContextUsage, contextMeterClass } from './contextUsage';

/**
 * Meta strip — always visible across all four matrix cells:
 *   [folder chip] [branch chip] … [token usage + context-% meter]
 *
 * Consolidates the three duplicate chip renderings that used to live in
 * ChatInput, ClaudeInputWithImages, and the WorkflowCanvas. Pure presentational;
 * the host derives folder/branch/contextUsage.
 *
 * The context meter is real for the SDK substrate (the producer string flows
 * from main/src/events.ts) and renders an empty "--%" state for PTY runs (no
 * structured result message) or before the first SDK result lands.
 */
export interface ChatMetaStripProps {
  /** short folder label (worktree basename / repo slug). */
  folderLabel: string | null;
  /** full path for the chip tooltip. */
  folderTitle?: string | null;
  branchName: string | null;
  /** raw producer string e.g. "54k/200k tokens (27%)", or null when unknown. */
  contextUsage: string | null;
}

export function ChatMetaStrip({
  folderLabel,
  folderTitle,
  branchName,
  contextUsage,
}: ChatMetaStripProps): React.ReactElement {
  const ctx = parseContextUsage(contextUsage);

  return (
    <div
      data-testid="chat-meta-strip"
      className="flex shrink-0 items-center gap-2.5 border-t border-border-primary bg-bg-primary px-4 py-1.5"
    >
      {folderLabel !== null && (
        <span
          className="inline-flex items-center gap-1.5 border border-border-primary bg-surface-primary px-2 py-0.5 text-[10.5px] text-interactive"
          title={folderTitle ?? undefined}
        >
          <Folder className="h-3 w-3" />
          <span className="max-w-[180px] truncate">{folderLabel}</span>
        </span>
      )}
      {branchName !== null && (
        <span
          className="inline-flex items-center gap-1.5 border border-border-primary bg-surface-primary px-2 py-0.5 font-mono text-[10.5px] text-status-success"
          title={branchName}
        >
          <GitBranch className="h-3 w-3" />
          <span className="max-w-[180px] truncate">{branchName}</span>
        </span>
      )}

      <span className="flex-1" />

      <div className="flex items-center gap-2 whitespace-nowrap text-[10.5px] tabular-nums text-text-secondary">
        {ctx === null ? (
          <span className="text-text-tertiary">-- tokens · --% ctx</span>
        ) : (
          <>
            <span>
              <b className="font-bold text-text-primary">{ctx.used}</b> tokens
            </span>
            <span
              className="relative h-1.5 w-[84px] overflow-hidden border border-border-primary bg-surface-sunken"
              aria-hidden
            >
              <span
                className={cn('absolute inset-y-0 left-0', contextMeterClass(ctx.percent))}
                style={{ width: `${Math.min(ctx.percent, 100)}%` }}
              />
            </span>
            <span className="text-text-tertiary">{ctx.percent}% of {ctx.total} ctx</span>
          </>
        )}
      </div>
    </div>
  );
}
