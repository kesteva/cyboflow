/**
 * FeedbackDocPanel — the in-artifact feedback surface (IDEA-033) shared by the
 * idea-spec and arch-design doc bodies in ArtifactTabRenderer.
 *
 * Wraps the caller's existing doc-shell markup (`children`) in a selectable
 * container: dragging a text selection over it shows a floating "Comment"
 * button near the selection, which opens a small popover to save a draft
 * comment anchored to that quote (see `frontend/src/utils/textAnchors.ts`).
 * Below the doc, a comments panel lists drafts (editable), the sent batch (read
 * -only, "Revision in progress"), a failed-batch banner, and a collapsed
 * "Previous rounds" history of addressed comments — plus the "Send feedback"
 * button, gated by {@link computeSendDisabledReason}.
 *
 * Data comes from `useFeedback` (seed + live `onFeedbackChanged` subscription);
 * gate presence comes from the already-wired project-scoped `reviewItemsSlice`
 * (no new subscription) — the same pattern ApproveIdeasBody/ApproveDesignsBody
 * use to find their pending decision gate.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { useFeedback } from '../../../hooks/useFeedback';
import { useReviewItemsSlice } from '../../../stores/reviewItemsSlice';
import { applyHighlights, captureAnchor, isAnchorStale } from '../../../utils/textAnchors';
import { computeSendDisabledReason, groupAddressedByRound } from './feedbackLogic';
import type { CommentAnchor, FeedbackAtype, FeedbackComment } from '../../../../../shared/types/feedback';

const HAIRLINE = 'var(--color-border-primary)';
const MUTED = 'var(--color-text-secondary)';
const INK = 'var(--color-text-primary)';
const FAINT = 'var(--color-text-tertiary)';
// Mirrors ArtifactTabRenderer's VERDICT_FAIL/VERDICT_PASS — kept local since
// this file has no dependency on that module's internal constants.
const FAIL = '#c0392b';
const PASS = '#2d8a5b';

interface FeedbackDocPanelProps {
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  /** The exact markdown/text string being rendered — anchors hash against it. */
  documentSource: string;
  ideaDecomposed: boolean;
  accent?: string;
  children: ReactNode;
}

interface PendingSelection {
  anchor: CommentAnchor;
  top: number;
  left: number;
}

function truncateQuote(quote: string, max = 90): string {
  const trimmed = quote.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function FeedbackDocPanel({
  projectId,
  runId,
  atype,
  sourceRef,
  documentSource,
  ideaDecomposed,
  accent = 'var(--color-interactive-primary)',
  children,
}: FeedbackDocPanelProps): ReactElement {
  const { comments, batches, createComment, updateComment, deleteComment, sendBatch } = useFeedback(
    projectId,
    runId,
    atype,
    sourceRef,
  );

  // -- Selection capture + the floating "Comment" button/popover -----------

  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleMouseUp = (): void => {
    if (popoverOpen) return;
    const selection = window.getSelection();
    const container = containerRef.current;
    if (!selection || !container) {
      setPending(null);
      return;
    }
    const anchor = captureAnchor(selection, container, documentSource);
    if (!anchor) {
      setPending(null);
      return;
    }
    const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setPending({
      anchor,
      top: rangeRect.bottom - containerRect.top + container.scrollTop + 6,
      left: Math.max(0, rangeRect.left - containerRect.left),
    });
  };

  // Dismiss the floating button (not the popover — that has explicit
  // Save/Cancel) when the user clicks anywhere outside this whole panel.
  useEffect(() => {
    if (!pending || popoverOpen) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPending(null);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [pending, popoverOpen]);

  // Persistent highlights for every still-relevant (draft + sent) comment.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const entries = comments
      .filter((c): c is FeedbackComment => c.status === 'draft' || c.status === 'sent')
      .map((c) => ({ id: c.id, anchor: c.anchor }));
    return applyHighlights(container, entries);
  }, [comments, documentSource]);

  const openPopover = (): void => {
    setDraftText('');
    setPopoverOpen(true);
  };
  const cancelPopover = (): void => {
    setPopoverOpen(false);
    setPending(null);
    setDraftText('');
  };
  const savePopover = async (): Promise<void> => {
    if (!pending || draftText.trim().length === 0 || saving) return;
    setSaving(true);
    try {
      await createComment(pending.anchor, draftText.trim());
      setPopoverOpen(false);
      setPending(null);
      setDraftText('');
    } finally {
      setSaving(false);
    }
  };

  // -- Comment groups ---------------------------------------------------------

  const drafts = useMemo(() => comments.filter((c) => c.status === 'draft'), [comments]);
  const sentComments = useMemo(() => comments.filter((c) => c.status === 'sent'), [comments]);
  const addressedComments = useMemo(() => comments.filter((c) => c.status === 'addressed'), [comments]);
  const addressedGroups = useMemo(
    () => groupAddressedByRound(addressedComments, batches),
    [addressedComments, batches],
  );
  const pendingBatch = useMemo(() => batches.find((b) => b.status === 'pending') ?? null, [batches]);
  const latestFailedBatch = useMemo(() => {
    const failed = batches.filter((b) => b.status === 'failed');
    if (failed.length === 0) return null;
    return failed.reduce((a, b) => (b.round > a.round ? b : a));
  }, [batches]);

  const [dismissedFailedIds, setDismissedFailedIds] = useState<Set<string>>(new Set());
  const showFailedBanner = latestFailedBatch !== null && !dismissedFailedIds.has(latestFailedBatch.id);

  const [historyOpen, setHistoryOpen] = useState(false);

  // -- Gate presence: the already-wired project-scoped review_items inbox ---

  useEffect(() => {
    const release = useReviewItemsSlice.getState().init(projectId);
    return () => { release(); };
  }, [projectId]);
  const reviewItems = useReviewItemsSlice((s) => s.items);
  const hasPendingGate = useMemo(
    () =>
      reviewItems.some(
        (it) => it.run_id === runId && it.kind === 'decision' && it.status === 'pending' && it.blocking,
      ),
    [reviewItems, runId],
  );

  const disabledReason = computeSendDisabledReason({
    draftCount: drafts.length,
    ideaDecomposed,
    hasPendingGate,
    hasPendingBatch: pendingBatch !== null,
  });

  const [sending, setSending] = useState(false);
  const [noOpReason, setNoOpReason] = useState<string | null>(null);

  const onSend = async (): Promise<void> => {
    if (disabledReason || sending) return;
    setSending(true);
    setNoOpReason(null);
    try {
      const result = await sendBatch();
      if ('noOp' in result) setNoOpReason(result.reason);
    } finally {
      setSending(false);
    }
  };

  // -- Draft row inline edit state (keyed by comment id) ---------------------

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const startEdit = (comment: FeedbackComment): void => {
    setEditingId(comment.id);
    setEditText(comment.body);
  };
  const cancelEdit = (): void => {
    setEditingId(null);
    setEditText('');
  };
  const saveEdit = async (commentId: string): Promise<void> => {
    if (editText.trim().length === 0) return;
    await updateComment(commentId, editText.trim());
    setEditingId(null);
    setEditText('');
  };

  return (
    <div ref={wrapperRef} data-testid="feedback-doc-panel">
      <div style={{ position: 'relative' }}>
        <div ref={containerRef} onMouseUp={handleMouseUp} data-testid="feedback-doc-container">
          {children}
        </div>
        {pending && !popoverOpen && (
          <button
            type="button"
            data-testid="feedback-comment-button"
            onClick={openPopover}
            style={{
              position: 'absolute',
              top: pending.top,
              left: pending.left,
              zIndex: 5,
              fontSize: '10.5px',
              fontWeight: 700,
              padding: '4px 10px',
              borderRadius: 4,
              border: 'none',
              background: accent,
              color: 'var(--color-surface-primary)',
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            }}
          >
            + Comment
          </button>
        )}
        {popoverOpen && pending && (
          <div
            data-testid="feedback-comment-popover"
            style={{
              position: 'absolute',
              top: pending.top,
              left: pending.left,
              zIndex: 6,
              width: 260,
              background: 'var(--color-surface-primary)',
              border: `1px solid ${HAIRLINE}`,
              borderRadius: 4,
              padding: 10,
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ fontSize: '10px', fontStyle: 'italic', color: FAINT, marginBottom: 6 }}>
              &ldquo;{truncateQuote(pending.anchor.quote, 60)}&rdquo;
            </div>
            <textarea
              data-testid="feedback-comment-textarea"
              autoFocus
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder="What should change here?"
              rows={3}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontSize: '11px',
                padding: 6,
                border: `1px solid ${HAIRLINE}`,
                borderRadius: 3,
                resize: 'vertical',
                background: 'var(--color-bg-primary)',
                color: INK,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                data-testid="feedback-comment-cancel"
                onClick={cancelPopover}
                style={{ fontSize: '10px', fontWeight: 600, padding: '4px 10px', border: `1px solid ${HAIRLINE}`, borderRadius: 3, background: 'var(--color-surface-primary)', color: MUTED, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="feedback-comment-save"
                disabled={saving || draftText.trim().length === 0}
                onClick={() => void savePopover()}
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '4px 10px',
                  border: 'none',
                  borderRadius: 3,
                  background: accent,
                  color: 'var(--color-surface-primary)',
                  cursor: saving || draftText.trim().length === 0 ? 'default' : 'pointer',
                  opacity: saving || draftText.trim().length === 0 ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        data-testid="feedback-comments-panel"
        style={{ maxWidth: 680, margin: '0 auto 40px', border: `1px solid ${HAIRLINE}`, background: 'var(--color-surface-primary)' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderBottom: `1px solid ${HAIRLINE}`,
          }}
        >
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: accent }}>
            Feedback
          </span>
          <span style={{ flex: 1 }} />
          {noOpReason && (
            <span data-testid="feedback-noop-warning" style={{ fontSize: '10px', color: FAIL, fontWeight: 600 }}>
              {noOpReasonText(noOpReason)}
            </span>
          )}
          <button
            type="button"
            data-testid="feedback-send-button"
            title={disabledReason ?? 'Send the drafted comments for a scoped revision'}
            disabled={disabledReason !== null || sending}
            onClick={() => void onSend()}
            style={{
              fontSize: '10px',
              fontWeight: 700,
              padding: '5px 12px',
              border: 'none',
              borderRadius: 3,
              background: disabledReason !== null || sending ? 'var(--color-surface-tertiary)' : INK,
              color: disabledReason !== null || sending ? MUTED : 'var(--color-surface-primary)',
              cursor: disabledReason !== null || sending ? 'default' : 'pointer',
            }}
          >
            {sending ? 'Sending…' : `Send feedback (${drafts.length})`}
          </button>
        </div>

        {pendingBatch && (
          <div
            data-testid="feedback-pending-banner"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', fontSize: '11px', color: MUTED, borderBottom: `1px solid ${HAIRLINE}` }}
          >
            <span className="cf-pulse" aria-hidden="true" style={{ color: accent }}>●</span>
            {`Revision in progress — round ${pendingBatch.round}…`}
          </div>
        )}

        {showFailedBanner && latestFailedBatch && (
          <div
            data-testid="feedback-failed-banner"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 14px', fontSize: '11px', color: FAIL, background: 'rgba(192,57,43,0.08)', borderBottom: `1px solid ${HAIRLINE}` }}
          >
            <span style={{ flex: 1 }}>
              {`Revision failed (round ${latestFailedBatch.round})`}
              {latestFailedBatch.error ? `: ${latestFailedBatch.error}` : ''}
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              data-testid="feedback-failed-dismiss"
              onClick={() => setDismissedFailedIds((prev) => new Set(prev).add(latestFailedBatch.id))}
              style={{ border: 'none', background: 'none', color: FAIL, cursor: 'pointer', fontSize: '12px', lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </div>
        )}

        <div style={{ padding: '10px 14px' }}>
          {drafts.length === 0 && sentComments.length === 0 ? (
            <div data-testid="feedback-empty" style={{ fontSize: '11px', color: FAINT, fontStyle: 'italic' }}>
              Highlight text in the document above to leave a comment.
            </div>
          ) : (
            <>
              {drafts.map((comment) => (
                <div
                  key={comment.id}
                  data-testid={`feedback-draft-row-${comment.id}`}
                  style={{ borderLeft: `2px solid ${accent}`, paddingLeft: 8, marginBottom: 10 }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: '10px', fontStyle: 'italic', color: FAINT, flex: 1 }}>
                      &ldquo;{truncateQuote(comment.anchor.quote)}&rdquo;
                    </span>
                    {isAnchorStale(comment.anchor, documentSource) && (
                      <span
                        data-testid={`feedback-stale-badge-${comment.id}`}
                        style={{ fontSize: '9px', fontWeight: 700, color: FAIL, border: `1px solid ${FAIL}`, borderRadius: 2, padding: '0 4px' }}
                      >
                        outdated anchor
                      </span>
                    )}
                  </div>
                  {editingId === comment.id ? (
                    <div style={{ marginTop: 4 }}>
                      <textarea
                        data-testid={`feedback-edit-textarea-${comment.id}`}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: '11px', padding: 6, border: `1px solid ${HAIRLINE}`, borderRadius: 3, background: 'var(--color-bg-primary)', color: INK }}
                      />
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button type="button" data-testid={`feedback-edit-save-${comment.id}`} onClick={() => void saveEdit(comment.id)} style={smallButtonStyle(accent, true)}>
                          Save
                        </button>
                        <button type="button" data-testid={`feedback-edit-cancel-${comment.id}`} onClick={cancelEdit} style={smallButtonStyle(MUTED, false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: '11.5px', color: INK, marginTop: 2 }}>{comment.body}</div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                        <button type="button" data-testid={`feedback-draft-edit-${comment.id}`} onClick={() => startEdit(comment)} style={linkButtonStyle(accent)}>
                          Edit
                        </button>
                        <button type="button" data-testid={`feedback-draft-delete-${comment.id}`} onClick={() => void deleteComment(comment.id)} style={linkButtonStyle(FAIL)}>
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {sentComments.map((comment) => (
                <div
                  key={comment.id}
                  data-testid={`feedback-sent-row-${comment.id}`}
                  style={{ borderLeft: `2px solid ${HAIRLINE}`, paddingLeft: 8, marginBottom: 10, opacity: 0.75 }}
                >
                  <div style={{ fontSize: '10px', fontStyle: 'italic', color: FAINT }}>
                    &ldquo;{truncateQuote(comment.anchor.quote)}&rdquo;
                  </div>
                  <div style={{ fontSize: '11.5px', color: INK, marginTop: 2 }}>{comment.body}</div>
                </div>
              ))}
            </>
          )}

          {addressedGroups.length > 0 && (
            <div style={{ marginTop: 8, borderTop: `1px solid ${HAIRLINE}`, paddingTop: 8 }}>
              <button
                type="button"
                data-testid="feedback-history-toggle"
                onClick={() => setHistoryOpen((v) => !v)}
                style={{ fontSize: '10.5px', fontWeight: 700, color: MUTED, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {`${historyOpen ? '▾' : '▸'} Previous rounds (${addressedGroups.length})`}
              </button>
              {historyOpen && (
                <div data-testid="feedback-history-body" style={{ marginTop: 8 }}>
                  {addressedGroups.map((group) => (
                    <div key={group.batchId} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: PASS, marginBottom: 4 }}>
                        {`Round ${group.round}`}
                      </div>
                      {group.comments.map((comment) => (
                        <div key={comment.id} style={{ borderLeft: `2px solid ${HAIRLINE}`, paddingLeft: 8, marginBottom: 6 }}>
                          <div style={{ fontSize: '10px', fontStyle: 'italic', color: FAINT }}>
                            &ldquo;{truncateQuote(comment.anchor.quote)}&rdquo;
                          </div>
                          <div style={{ fontSize: '11px', color: MUTED, marginTop: 2 }}>{comment.body}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function smallButtonStyle(color: string, primary: boolean): CSSProperties {
  return {
    fontSize: '10px',
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: 3,
    border: primary ? 'none' : `1px solid ${HAIRLINE}`,
    background: primary ? color : 'var(--color-surface-primary)',
    color: primary ? 'var(--color-surface-primary)' : color,
    cursor: 'pointer',
  };
}

function linkButtonStyle(color: string): CSSProperties {
  return { fontSize: '10px', fontWeight: 600, color, background: 'none', border: 'none', cursor: 'pointer', padding: 0 };
}

function noOpReasonText(reason: string): string {
  switch (reason) {
    case 'not_found':
      return "Couldn't send — run or idea not found.";
    case 'not_parked':
      return "Couldn't send — the run is no longer parked at a gate.";
    case 'no_gate':
      return 'No open review gate for this run.';
    case 'decomposed':
      return 'This idea has already been decomposed.';
    case 'no_comments':
      return 'No draft comments to send.';
    case 'busy':
      return 'A revision is already in progress.';
    default:
      return "Couldn't send feedback.";
  }
}
