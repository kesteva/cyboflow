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
import { useQuestionStore } from '../../stores/questionStore';
import { MarkdownPreview } from '../MarkdownPreview';
import { AskUserQuestionCard } from '../AskUserQuestion/AskUserQuestionCard';
import { PendingApprovalsForRun } from '../ReviewQueue/PendingApprovalsForRun';
import { trpc } from '../../trpc/client';
import type { StreamEvent } from '../../utils/cyboflowApi';
import type { ChatMessage } from '../../../../shared/types/chatMessage';
import type { Question } from '../../../../shared/types/questions';

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
// Public component
// ---------------------------------------------------------------------------

export function RunChatView({ runId }: { runId: string | null }): ReactElement {
  const activeQuickSessionId = useCyboflowStore((s) => s.activeQuickSessionId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const questionQueue = useQuestionStore((s) => s.queue);

  const [historicalMessages, setHistoricalMessages] = useState<ChatMessage[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

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

    // ---- Deduplicate historical overlap with live ----
    // Both feeds derive from raw_events. Any live event that arrived between
    // setActiveRun (which begins streamEvents accumulation) and the
    // listMessages query resolution (which populates historicalMessages)
    // appears in BOTH arrays. We prefer LIVE events over historical ones
    // because live events carry the full content blocks (including tool_use),
    // while historical ChatMessages are text-only.
    //
    // Strategy: build a set of message ids present in live events, then drop
    // matching historical messages. Non-overlapping historical messages
    // (older turns from before the subscription started) are kept.

    // cyboflowStore.streamEvents is already scoped to the active run
    // (cleared on setActiveRun) — no runId filter needed.
    const liveItems: TimelineItem[] = streamEvents
      .filter((e) => e.type === 'assistant' || e.type === 'user')
      .map((event) => ({ kind: 'live' as const, event }));

    const liveAssistantIds = new Set<string>();
    const liveTimestamps: string[] = [];
    for (const item of liveItems) {
      if (item.kind !== 'live') continue;
      liveTimestamps.push(item.event.timestamp);
      if (item.event.type === 'assistant') {
        const msgId = (item.event.payload as { message?: { id?: string } }).message?.id;
        if (typeof msgId === 'string') {
          liveAssistantIds.add(msgId);
        }
      }
    }

    // Earliest live event timestamp — used to gate historical user messages.
    const earliestLiveTimestamp = liveTimestamps.length === 0
      ? ''
      : liveTimestamps.reduce((a, b) => (a < b ? a : b));

    const dedupedHistorical: TimelineItem[] = historicalItems.filter((item) => {
      if (item.kind !== 'historical') return true;
      const { message } = item;
      if (message.role === 'assistant') {
        return !liveAssistantIds.has(message.id);
      }
      if (message.role === 'user' && earliestLiveTimestamp !== '') {
        return message.createdAt < earliestLiveTimestamp;
      }
      return true;
    });

    return [...dedupedHistorical, ...liveItems];
  }, [historicalMessages, streamEvents, runId]);

  // -------------------------------------------------------------------------
  // Auto-scroll to bottom when timeline changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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

  return (
    <div className="flex h-full flex-col gap-2">
      <div ref={scrollContainerRef} className="flex-1 overflow-auto rounded border border-border-primary bg-bg-secondary p-2">
        {isLoadingHistory && (
          <p className="text-xs text-text-muted">Loading history...</p>
        )}
        {loadError !== null && (
          <p className="text-xs text-status-error">Error loading history: {loadError}</p>
        )}

        {mergedTimeline.map((item, idx) => renderTimelineItem(item, idx, deps))}
      </div>

      <PendingApprovalsForRun runId={runId} />

      <ChatInput runId={runId} />
    </div>
  );
}
