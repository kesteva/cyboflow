/**
 * RunChatView — Chat tab content for the per-run bottom pane.
 *
 * Renders a curated, scrollable conversation for the active run:
 *  - Historical text turns bootstrapped from `cyboflow.runs.listMessages`
 *  - Live `StreamEvent` deltas from `cyboflowStore.streamEvents`
 *  - Inline `AskUserQuestionCard` at AskUserQuestion tool_use positions
 *  - Per-run-filtered `PendingApprovalCard` instances at the bottom
 *
 * This component does NOT include a chat input bar (TASK-762) and does NOT
 * touch the QuestionRouter, tRPC, or DB layers.
 *
 * Modes:
 *  - runId non-null: full conversation view (this file's main branch)
 *  - runId null + activeQuickSessionId non-null: quick-session placeholder
 *  - runId null + activeQuickSessionId null: "No active run" placeholder
 */
import { useEffect, useRef, useMemo, useState, type ReactElement } from 'react';
import { ChatInput } from './ChatInput';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useReviewQueueStore } from '../../stores/reviewQueueStore';
import { useQuestionStore } from '../../stores/questionStore';
import { MarkdownPreview } from '../MarkdownPreview';
import { AskUserQuestionCard } from '../AskUserQuestion/AskUserQuestionCard';
import { PendingApprovalCard } from '../ReviewQueue/PendingApprovalCard';
import { trpc } from '../../trpc/client';
import type { StreamEvent } from '../../utils/cyboflowApi';
import type { ChatMessage } from '../../../../shared/types/chatMessage';
import type { Question } from '../../../../shared/types/questions';
import type { Approval } from '../../../../shared/types/approvals';
import type { QueueItem } from '../../utils/reviewQueueSelectors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A merged timeline item — either a historical ChatMessage or a live StreamEvent. */
type TimelineItem =
  | { kind: 'historical'; message: ChatMessage }
  | { kind: 'live'; event: StreamEvent };

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

interface EventRenderDeps {
  questionQueue: Question[];
  runId: string;
}

/**
 * Render a single assistant content block.
 * Returns null for 'thinking' blocks (intentionally skipped per plan step 4).
 */
function renderAssistantBlock(
  block: Extract<StreamEvent, { type: 'assistant' }>['payload']['message']['content'][number],
  idx: number,
  deps: EventRenderDeps,
): ReactElement | null {
  if (block.type === 'text') {
    return (
      <div key={idx} className="assistant-bubble mb-1 rounded border-l-2 border-pink-400 bg-bg-secondary p-2 text-xs">
        <MarkdownPreview content={block.text} />
      </div>
    );
  }

  if (block.type === 'tool_use') {
    if (block.name === 'AskUserQuestion') {
      // Match by toolUseId (camelCase on Question) to block.id
      const question = deps.questionQueue.find((q) => q.toolUseId === block.id);
      if (question != null) {
        return (
          <div key={idx} className="mb-1">
            <AskUserQuestionCard item={question} />
          </div>
        );
      }
      // Question already answered (no pending match)
      return (
        <div key={idx} className="mb-1 text-xs text-text-muted italic">
          Question already answered
        </div>
      );
    }

    // Other tool_use blocks — compact tool-name + JSON preview (matches RunView pattern)
    return (
      <div key={idx} className="mb-1 rounded border border-border-primary bg-bg-secondary p-1 text-xs">
        <span className="font-semibold text-text-secondary">tool:</span>{' '}
        <span className="text-text-primary">{block.name}</span>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-text-secondary">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }

  // thinking blocks: skip
  return null;
}

/**
 * Render a single timeline item.
 */
function renderTimelineItem(
  item: TimelineItem,
  idx: number,
  deps: EventRenderDeps,
): ReactElement | null {
  if (item.kind === 'historical') {
    const { message } = item;
    if (message.role === 'user') {
      return (
        <div key={`hist-${idx}`} className="user-bubble mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs">
          <span className="font-semibold text-text-primary">user</span>
          <p className="mt-1 text-text-primary whitespace-pre-wrap">{message.text}</p>
        </div>
      );
    }
    // assistant role
    return (
      <div key={`hist-${idx}`} className="assistant-bubble mb-1 rounded border-l-2 border-pink-400 bg-bg-secondary p-2 text-xs">
        <MarkdownPreview content={message.text} />
      </div>
    );
  }

  // kind === 'live'
  const { event } = item;

  if (event.type === 'user') {
    const content = event.payload.message?.content ?? [];
    return (
      <div key={`live-${idx}`} className="user-bubble mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs">
        <span className="font-semibold text-text-primary">user</span>
        <div className="mt-1">
          {content.map((block, bi) => {
            const shortId = block.tool_use_id.slice(0, 8);
            const bodyText = typeof block.content === 'string'
              ? block.content
              : block.content.map((c) => c.text).join('');
            return (
              <div key={bi} className="mt-1">
                {block.is_error === true && (
                  <span className="mr-1 rounded bg-red-600 px-1 text-white">error</span>
                )}
                <span className="font-mono text-text-secondary">{shortId}…</span>
                {' '}
                <span className="text-text-primary">{bodyText}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (event.type === 'assistant') {
    const content = event.payload.message?.content ?? [];
    return (
      <div key={`live-${idx}`}>
        {content.map((block, bi) => renderAssistantBlock(block, bi, deps))}
      </div>
    );
  }

  // Other event types (system, result, stream_event, etc.) are not rendered in chat view
  return null;
}

// ---------------------------------------------------------------------------
// Approval conversion helper
// ---------------------------------------------------------------------------

/** Wrap a raw Approval in the QueueItem shape PendingApprovalCard expects. */
function approvalToQueueItem(approval: Approval): QueueItem {
  return {
    kind: 'single',
    approval,
    isBlocking: false,
  };
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function RunChatView({ runId }: { runId: string | null }): ReactElement {
  const activeQuickSessionId = useCyboflowStore((s) => s.activeQuickSessionId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const approvalQueue = useReviewQueueStore((s) => s.queue);
  const questionQueue = useQuestionStore((s) => s.queue);

  const [historicalMessages, setHistoricalMessages] = useState<ChatMessage[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------
  // Bootstrap from listMessages when runId changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (runId === null) {
      setHistoricalMessages([]);
      setLoadError(null);
      return;
    }

    let aborted = false;

    setIsLoadingHistory(true);
    setLoadError(null);
    setHistoricalMessages([]);

    trpc.cyboflow.runs.listMessages.query({ runId })
      .then((result) => {
        if (!aborted) {
          setHistoricalMessages(result);
          setIsLoadingHistory(false);
        }
      })
      .catch((err: unknown) => {
        if (!aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setLoadError(message);
          setIsLoadingHistory(false);
        }
      });

    return () => {
      aborted = true;
    };
  }, [runId]);

  // -------------------------------------------------------------------------
  // Merge historical + live events into a single timeline
  // -------------------------------------------------------------------------

  // mergedTimeline — historical messages (from listMessages query) merged
  // with live stream events (from cyboflowStore.streamEvents). Both feeds
  // derive from raw_events; the dedup pass below removes the overlap that
  // accumulates between setActiveRun and the listMessages resolution.
  // See FIND-SPRINT-039-11 for the original bug report.
  const mergedTimeline = useMemo<TimelineItem[]>(() => {
    const historicalItems: TimelineItem[] = historicalMessages.map((message) => ({
      kind: 'historical',
      message,
    }));

    // ---- Deduplicate live overlap with history ----
    // Both feeds derive from raw_events. Any live event that arrived between
    // setActiveRun (which begins streamEvents accumulation) and the
    // listMessages query resolution (which populates historicalMessages)
    // appears in BOTH arrays. Drop the live duplicates so each message
    // renders exactly once.
    //
    // Assistant events: dedup by payload.message.id ↔ historicalMessage.id
    //   (selectRunMessages extracts the same id from payload.message.id).
    // User events: no stable id at the message level — fall back to
    //   timestamp filter (drop user events whose timestamp ≤ the latest
    //   historicalMessage.createdAt).

    const historicalAssistantIds = new Set<string>(
      historicalMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.id),
    );

    // Latest historical createdAt — used to gate user events. Empty history
    // produces a sentinel that lets everything through (since '' < any ISO).
    const latestHistoricalCreatedAt = historicalMessages.length === 0
      ? ''
      : historicalMessages
          .map((m) => m.createdAt)
          .reduce((a, b) => (a > b ? a : b));

    const liveItems: TimelineItem[] = streamEvents
      .filter((e) => e.runId === runId)
      .filter((e) => {
        if (e.type === 'assistant') {
          const msgId = e.payload.message?.id;
          if (typeof msgId === 'string' && historicalAssistantIds.has(msgId)) {
            return false; // dedup: already in history
          }
          return true;
        }
        if (e.type === 'user') {
          // User events carry no stable message id — gate by timestamp.
          // Strict-less-or-equal: a live event at exactly the same ISO
          // string as the latest historical entry is treated as part of
          // the historical batch (drop it).
          return e.timestamp > latestHistoricalCreatedAt;
        }
        // Other event types (system, result, stream_event, ...) are not
        // rendered by renderTimelineItem anyway; pass them through so
        // future renderer additions are not silently filtered.
        return true;
      })
      .map((event) => ({ kind: 'live', event }));

    return [...historicalItems, ...liveItems];
  }, [historicalMessages, streamEvents, runId]);

  // -------------------------------------------------------------------------
  // Auto-scroll to bottom when timeline changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mergedTimeline]);

  // -------------------------------------------------------------------------
  // Render branches
  // -------------------------------------------------------------------------

  if (runId === null && activeQuickSessionId !== null) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        Quick session chat (history rendered by panel surface)
      </div>
    );
  }

  if (runId === null) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        No active run
      </div>
    );
  }

  // runId is non-null — full conversation view
  const deps: EventRenderDeps = { questionQueue, runId };
  const runApprovals = approvalQueue.filter((a) => a.runId === runId);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex-1 overflow-auto rounded border border-border-primary bg-bg-secondary p-2">
        {isLoadingHistory && (
          <p className="text-xs text-text-muted">Loading history...</p>
        )}
        {loadError !== null && (
          <p className="text-xs text-status-error">Error loading history: {loadError}</p>
        )}

        {mergedTimeline.map((item, idx) => renderTimelineItem(item, idx, deps))}

        <div ref={bottomRef} />
      </div>

      {runApprovals.length > 0 && (
        <div className="rounded border border-border-primary bg-bg-secondary p-2">
          <p className="mb-2 text-xs font-semibold text-text-primary">Pending approvals</p>
          <div>
            {runApprovals.map((approval) => (
              <PendingApprovalCard
                key={approval.id}
                item={approvalToQueueItem(approval)}
              />
            ))}
          </div>
        </div>
      )}

      <ChatInput runId={runId} />
    </div>
  );
}
