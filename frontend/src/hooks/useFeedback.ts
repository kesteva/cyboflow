/**
 * useFeedback — live comments+batches for in-artifact feedback (IDEA-033).
 *
 * Two modes, selected by whether `atype`+`sourceRef` are given:
 *  - DOC-SCOPED (both set): backs one FeedbackDocPanel instance — comments and
 *    batches are exactly this document's, and createComment/updateComment/
 *    deleteComment/sendBatch are wired to it.
 *  - RUN-SCOPED (both omitted): backs the gate-row "changes requested" chips —
 *    comments/batches span every document (idea-spec + arch-design, every
 *    idea) in the run. The mutation helpers throw if called in this mode; the
 *    chips are read-only consumers.
 *
 * Seeds from `feedback.list` (mirrors useArtifactsList's seed/subscribe
 * lifecycle), then stays live via the project-scoped `onFeedbackChanged`
 * subscription. Each event carries the FULL refreshed `{comments, batches}`
 * for the ONE document it touched (`event.atype` + `event.sourceRef`) —
 * {@link mergeFeedbackEvent} replaces that document's slice of local state
 * without disturbing any other document's, so the same merge works for both
 * modes (in doc-scoped mode every existing entry already belongs to the one
 * scoped document, so "replace matching entries" reduces to a full replace).
 *
 * The seed query and the subscription open concurrently, so an event can
 * arrive before the seed resolves. Applying it immediately would then get
 * clobbered by the (now stale) seed snapshot. Events that arrive while the
 * seed is in flight are buffered and replayed — in arrival order, through
 * `mergeFeedbackEvent` — on top of the seed once it settles (empty state if
 * the seed failed), so the newest write always wins regardless of arrival
 * order. Once the seed has settled, events apply directly.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type {
  CommentAnchor,
  FeedbackAtype,
  FeedbackBatch,
  FeedbackChangedEvent,
  FeedbackComment,
  SendFeedbackResult,
} from '../../../shared/types/feedback';

export interface UseFeedbackResult {
  comments: FeedbackComment[];
  batches: FeedbackBatch[];
  /** False once the initial `feedback.list` seed has resolved (or failed). */
  loading: boolean;
  /** Doc-scoped only — throws if the hook was not given `atype` + `sourceRef`. */
  createComment: (anchor: CommentAnchor, body: string) => Promise<void>;
  updateComment: (commentId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  /** Doc-scoped only — throws if the hook was not given `atype` + `sourceRef`. */
  sendBatch: () => Promise<SendFeedbackResult>;
}

interface FeedbackState {
  comments: FeedbackComment[];
  batches: FeedbackBatch[];
}

const EMPTY_STATE: FeedbackState = { comments: [], batches: [] };

/**
 * Replace one document's slice of local state with an incoming event's full
 * refreshed set for that document (matched on `atype` + `sourceRef`), leaving
 * every other document's entries untouched. Pure — exported for testing.
 */
export function mergeFeedbackEvent(prev: FeedbackState, event: FeedbackChangedEvent): FeedbackState {
  const touchesOtherDoc = (atype: FeedbackAtype, sourceRef: string): boolean =>
    !(atype === event.atype && sourceRef === event.sourceRef);
  return {
    comments: [...prev.comments.filter((c) => touchesOtherDoc(c.atype, c.sourceRef)), ...event.comments],
    batches: [...prev.batches.filter((b) => touchesOtherDoc(b.atype, b.sourceRef)), ...event.batches],
  };
}

export function useFeedback(
  projectId: number | null,
  runId: string | null,
  atype?: FeedbackAtype,
  sourceRef?: string,
): UseFeedbackResult {
  const [state, setState] = useState<FeedbackState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (projectId === null || runId === null) {
      setState(EMPTY_STATE);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Seed is in flight until the `feedback.list` promise settles (resolve or
    // reject) — events that arrive before then go here instead of `setState`
    // directly, so they can't be clobbered by the (older) seed snapshot.
    let seedSettled = false;
    const buffered: FeedbackChangedEvent[] = [];
    setState(EMPTY_STATE);
    setLoading(true);

    trpc.cyboflow.feedback.list
      .query({
        runId,
        ...(atype !== undefined ? { atype } : {}),
        ...(sourceRef !== undefined ? { sourceRef } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        seedSettled = true;
        setState(buffered.reduce<FeedbackState>((acc, event) => mergeFeedbackEvent(acc, event), result));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[useFeedback] initial list failed:', err);
        seedSettled = true;
        setState((prev) => buffered.reduce<FeedbackState>((acc, event) => mergeFeedbackEvent(acc, event), prev));
        setLoading(false);
      });

    // Project-scoped change stream. Payload type is inferred from AppRouter
    // (FeedbackChangedEvent) — never a local mirror or `unknown` + guard.
    const sub = trpc.cyboflow.feedback.onFeedbackChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          if (event.runId !== runId) return;
          if (atype !== undefined && event.atype !== atype) return;
          if (sourceRef !== undefined && event.sourceRef !== sourceRef) return;
          if (!seedSettled) {
            buffered.push(event);
            return;
          }
          setState((prev) => mergeFeedbackEvent(prev, event));
        },
        onError: (err: unknown) => console.warn('[useFeedback] onFeedbackChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [projectId, runId, atype, sourceRef]);

  const createComment = async (anchor: CommentAnchor, body: string): Promise<void> => {
    if (runId === null || atype === undefined || sourceRef === undefined) {
      throw new Error('[useFeedback] createComment requires a doc-scoped hook (atype + sourceRef)');
    }
    await trpc.cyboflow.feedback.createComment.mutate({ runId, atype, sourceRef, anchor, body });
  };

  const updateComment = async (commentId: string, body: string): Promise<void> => {
    if (runId === null) {
      throw new Error('[useFeedback] updateComment requires a runId');
    }
    await trpc.cyboflow.feedback.updateComment.mutate({ runId, commentId, body });
  };

  const deleteComment = async (commentId: string): Promise<void> => {
    if (runId === null) {
      throw new Error('[useFeedback] deleteComment requires a runId');
    }
    await trpc.cyboflow.feedback.deleteComment.mutate({ runId, commentId });
  };

  const sendBatch = async (): Promise<SendFeedbackResult> => {
    if (runId === null || atype === undefined || sourceRef === undefined) {
      throw new Error('[useFeedback] sendBatch requires a doc-scoped hook (atype + sourceRef)');
    }
    return trpc.cyboflow.feedback.sendBatch.mutate({ runId, atype, sourceRef });
  };

  return {
    comments: state.comments,
    batches: state.batches,
    loading,
    createComment,
    updateComment,
    deleteComment,
    sendBatch,
  };
}
