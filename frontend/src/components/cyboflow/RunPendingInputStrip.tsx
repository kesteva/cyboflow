/**
 * RunPendingInputStrip — persistent footer strip surfacing a run's pending
 * review_items + live AskUserQuestion gates.
 *
 * Mounted once in RunCenterPane, BETWEEN the tab content and TerminalDock, so
 * it is visible regardless of the active tab. Mirrors the init/subscribe/
 * cleanup + empty-state-null pattern established by
 * `ReviewQueue/PendingApprovalsForRun.tsx`, but sources from TWO stores:
 *
 *   - {@link useReviewItemsSlice} (project-scoped review_items inbox) —
 *     filtered to this run's PENDING items, blocking-first, via the shared
 *     {@link pendingReviewItemsForRun} selector.
 *   - {@link useQuestionStore} (global live AskUserQuestion queue) — filtered
 *     to this run's Questions.
 *
 * ## De-dupe: folded question review items vs. live questions
 *
 * A `source === 'question'` review item is the FOLDED read-model row for an
 * open AskUserQuestion gate — it carries no `toolUseId` (`payload: null`) and
 * there is at most one pending per run. So whenever the run has ANY live
 * questionStore Question, every `source === 'question'` review item for that
 * run is dropped from the render (the live AskUserQuestionCard is the single
 * surface for answering it) — suppression is by RUN, not by toolUseId.
 */
import { useEffect, useMemo, type ReactElement } from 'react';
import { useReviewItemsSlice, pendingReviewItemsForRun } from '../../stores/reviewItemsSlice';
import { useQuestionStore } from '../../stores/questionStore';
import { ReviewItemCard } from '../ReviewQueue/ReviewItemCard';
import { AskUserQuestionCard } from '../AskUserQuestion/AskUserQuestionCard';

interface RunPendingInputStripProps {
  runId: string;
  projectId: number | null;
}

export function RunPendingInputStrip({ runId, projectId }: RunPendingInputStripProps): ReactElement | null {
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

  const pendingItems = useMemo(() => {
    const pending = pendingReviewItemsForRun(items, runId);
    if (liveQuestions.length === 0) return pending;
    // A live question is present for this run — suppress the folded
    // question-sourced review item(s) so the run's gate has one surface.
    return pending.filter((it) => it.source !== 'question');
  }, [items, runId, liveQuestions.length]);

  const shownCount = pendingItems.length + liveQuestions.length;
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
        {liveQuestions.map((question) => (
          <AskUserQuestionCard key={question.toolUseId} item={question} />
        ))}
      </div>
    </div>
  );
}
