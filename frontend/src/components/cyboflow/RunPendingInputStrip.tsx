/**
 * RunPendingInputStrip — persistent footer strip surfacing a run's pending
 * review_items + live AskUserQuestion gates.
 *
 * Mounted once in RunCenterPane, BETWEEN the tab content and TerminalDock, so
 * it is visible regardless of the active tab. Mirrors the init/subscribe/
 * cleanup + empty-state-null pattern established by `ReviewQueueView.tsx`, but
 * sources from TWO stores:
 *
 *   - {@link useReviewItemsSlice} (project-scoped review_items inbox) —
 *     filtered to this run's PENDING items, blocking-first, via the shared
 *     {@link pendingReviewItemsForRun} selector.
 *   - {@link useQuestionStore} (global live AskUserQuestion queue) — filtered
 *     to this run's Questions.
 *
 * ## De-dupe: three surfaces for one live question
 *
 * A live AskUserQuestion for a run can appear in THREE places; exactly one must
 * be interactive at a time:
 *
 *   1. The FOLDED read-model row — a `source === 'question'` review item (no
 *      `toolUseId`, `payload: null`, at most one pending per run). Whenever the
 *      run has ANY live questionStore Question, every `source === 'question'`
 *      review item for that run is dropped from the render — suppression is by
 *      RUN, not by toolUseId.
 *   2. The CHAT-TRANSCRIPT inline card — `RunChatView.renderToolCallExtra`
 *      renders an AskUserQuestionCard at the question's tool_use position, but
 *      only when the Chat tab is the visible bottom-dock surface.
 *   3. THIS strip's own AskUserQuestionCard — the guaranteed-visible fallback
 *      for every NON-chat tab (and a collapsed dock).
 *
 * To keep a single interactive surface, the strip stands down its own live
 * question card (#3) exactly when the chat transcript already renders it (#2) —
 * i.e. `chatSurfaceVisible` (Chat tab active AND the dock open). Any other tab,
 * or a collapsed dock, keeps the strip's card so the gate is never hidden. The
 * folded-row suppression (#1) still fires whenever the run has a live question,
 * regardless of which of #2/#3 is showing it.
 */
import { useEffect, useMemo, type ReactElement } from 'react';
import { useReviewItemsSlice, pendingReviewItemsForRun } from '../../stores/reviewItemsSlice';
import { useQuestionStore } from '../../stores/questionStore';
import { ReviewItemCard } from '../ReviewQueue/ReviewItemCard';
import { AskUserQuestionCard } from '../AskUserQuestion/AskUserQuestionCard';

interface RunPendingInputStripProps {
  runId: string;
  projectId: number | null;
  /**
   * Whether the chat transcript surface (which renders the same live question
   * inline via `RunChatView.renderToolCallExtra`) is currently VISIBLE — the
   * Chat tab is the active bottom-dock tab AND the dock is open. When true the
   * strip stands down its own live-question card so the gate has one interactive
   * surface. Defaults to false (strip owns the surface) — the safe fallback for
   * every non-chat tab / collapsed dock, and for callers that don't thread it.
   */
  chatSurfaceVisible?: boolean;
}

export function RunPendingInputStrip({
  runId,
  projectId,
  chatSurfaceVisible = false,
}: RunPendingInputStripProps): ReactElement | null {
  useEffect(() => {
    if (projectId === null) return;
    const unsubscribe = useReviewItemsSlice.getState().init(projectId);
    return () => { unsubscribe(); };
  }, [projectId]);

  useEffect(() => {
    // `useQuestionStore.init()` is an app-lifetime singleton — `CyboflowRoot`
    // already owns it for the whole app. Calling `init()` here is harmless
    // (idempotent: returns the existing cached unsubscribe when already
    // initialized), but this component must NOT invoke that unsubscribe on
    // its own unmount — it is never the sole owner of the subscription, and
    // doing so would tear down the app-wide live-question feed every time a
    // run pane unmounts (e.g. navigating back to Home) while CyboflowRoot,
    // and thus the subscription, is still very much alive.
    useQuestionStore.getState().init();
  }, []);

  const items = useReviewItemsSlice((s) => s.items);
  const questionQueue = useQuestionStore((s) => s.queue);

  const liveQuestions = useMemo(
    () => questionQueue.filter((q) => q.runId === runId),
    [questionQueue, runId],
  );

  // Live question cards THIS strip renders. When the chat transcript is the
  // visible surface it already renders them inline, so the strip stands down —
  // one interactive surface per live question (surface #2 vs #3, see docstring).
  const stripQuestions = chatSurfaceVisible ? [] : liveQuestions;

  const pendingItems = useMemo(() => {
    const pending = pendingReviewItemsForRun(items, runId);
    if (liveQuestions.length === 0) return pending;
    // A live question is present for this run — suppress the folded
    // question-sourced review item(s) regardless of which surface (chat inline
    // or this strip) is showing the live card, so the gate has one surface.
    return pending.filter((it) => it.source !== 'question');
  }, [items, runId, liveQuestions.length]);

  const shownCount = pendingItems.length + stripQuestions.length;
  if (shownCount === 0) return null;

  return (
    <div
      className="flex-shrink-0 flex flex-col border-t border-border-primary bg-bg-secondary"
      style={{ maxHeight: '40vh' }}
      data-testid="run-pending-input-strip"
    >
      <div className="flex items-center gap-2 px-4 py-2 flex-shrink-0">
        <span
          className="rounded-full bg-interactive/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-interactive"
          data-testid="pending-input-chip"
        >
          Needs your input
        </span>
        <span className="text-xs text-text-muted" data-testid="pending-input-count">
          {shownCount}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto" role="list">
        {pendingItems.map((item) => (
          <ReviewItemCard key={item.id} item={item} />
        ))}
        {stripQuestions.map((question) => (
          <AskUserQuestionCard key={question.toolUseId} item={question} />
        ))}
      </div>
    </div>
  );
}
