/**
 * FeedbackDocPanel tests — the in-artifact feedback surface (IDEA-033).
 *
 * useFeedback and the project-scoped reviewItemsSlice are mocked (the same way
 * ArtifactTabRenderer.test.tsx mocks them) so these are pure rendering/
 * interaction tests over the panel's own logic: drafts list + edit/delete,
 * the pending/failed batch banners, the Send button's disabled reasons, the
 * noOp warning, and the addressed-history toggle.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { FeedbackDocPanel } from '../FeedbackDocPanel';
import { useFeedback, type UseFeedbackResult } from '../../../../hooks/useFeedback';
import type { ReviewItem } from '../../../../../../shared/types/reviews';
import type { FeedbackBatch, FeedbackComment } from '../../../../../../shared/types/feedback';

vi.mock('../../../../hooks/useFeedback', () => ({ useFeedback: vi.fn() }));
const mockFeedback = vi.mocked(useFeedback);

const createCommentMock = vi.fn().mockResolvedValue(undefined);
const updateCommentMock = vi.fn().mockResolvedValue(undefined);
const deleteCommentMock = vi.fn().mockResolvedValue(undefined);
const sendBatchMock = vi.fn().mockResolvedValue({ sent: true, batchId: 'batch-1', round: 1 });

function setFeedback(overrides: Partial<UseFeedbackResult> = {}): void {
  mockFeedback.mockReturnValue({
    comments: [],
    batches: [],
    loading: false,
    createComment: createCommentMock,
    updateComment: updateCommentMock,
    deleteComment: deleteCommentMock,
    sendBatch: sendBatchMock,
    ...overrides,
  });
}

let mockReviewItems: ReviewItem[] = [];
const mockReviewInit = vi.fn();
const mockReviewRelease = vi.fn();
mockReviewInit.mockImplementation(() => mockReviewRelease);
vi.mock('../../../../stores/reviewItemsSlice', () => ({
  useReviewItemsSlice: Object.assign(
    (selector: (s: { items: ReviewItem[] }) => unknown) => selector({ items: mockReviewItems }),
    { getState: () => ({ init: mockReviewInit }) },
  ),
}));
function setReviewItems(items: ReviewItem[]): void {
  mockReviewItems = items;
}

function makeGateItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rvw_gate',
    project_id: 1,
    run_id: 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'decision',
    status: 'pending',
    blocking: true,
    title: 'Approve ideas',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: 'gate:human-step:approve-ideas',
    payload: { kind: 'decision', gate: 'approve-ideas', ideaRefs: ['IDEA-014'] },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<FeedbackComment> = {}): FeedbackComment {
  return {
    id: 'cmt-1',
    projectId: 1,
    runId: 'run-1',
    atype: 'idea-spec',
    sourceRef: 'idea-1',
    batchId: null,
    anchor: { quote: 'the login flow', occurrence: 0, bodyHash: 'abc' },
    body: 'clarify the error states',
    status: 'draft',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    sentAt: null,
    addressedAt: null,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<FeedbackBatch> = {}): FeedbackBatch {
  return {
    id: 'batch-1',
    projectId: 1,
    runId: 'run-1',
    atype: 'idea-spec',
    sourceRef: 'idea-1',
    round: 1,
    status: 'pending',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    appliedAt: null,
    ...overrides,
  };
}

const DOC = 'The login flow needs a redesign for clarity.';

function renderPanel(props: Partial<ComponentProps<typeof FeedbackDocPanel>> = {}) {
  return render(
    <FeedbackDocPanel
      projectId={1}
      runId="run-1"
      atype="idea-spec"
      sourceRef="idea-1"
      documentSource={DOC}
      ideaDecomposed={false}
      {...props}
    >
      <div data-testid="doc-shell">{DOC}</div>
    </FeedbackDocPanel>,
  );
}

describe('FeedbackDocPanel', () => {
  beforeEach(() => {
    mockFeedback.mockReset();
    createCommentMock.mockClear();
    updateCommentMock.mockClear();
    deleteCommentMock.mockClear();
    sendBatchMock.mockClear();
    sendBatchMock.mockResolvedValue({ sent: true, batchId: 'batch-1', round: 1 });
    setFeedback();
    setReviewItems([]);
  });

  it('renders the doc-shell children and an empty-state prompt with no comments', () => {
    renderPanel();
    expect(screen.getByTestId('doc-shell')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-empty')).toBeInTheDocument();
  });

  it('lists draft comments with the truncated quote + body, and Edit/Delete actions', () => {
    const draft = makeComment();
    setFeedback({ comments: [draft] });
    renderPanel();

    const row = screen.getByTestId(`feedback-draft-row-${draft.id}`);
    expect(row).toHaveTextContent('the login flow');
    expect(row).toHaveTextContent('clarify the error states');
    expect(screen.getByTestId(`feedback-draft-edit-${draft.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`feedback-draft-delete-${draft.id}`)).toBeInTheDocument();
  });

  it('edits a draft comment via the inline textarea', async () => {
    const draft = makeComment();
    setFeedback({ comments: [draft] });
    renderPanel();

    fireEvent.click(screen.getByTestId(`feedback-draft-edit-${draft.id}`));
    const textarea = screen.getByTestId(`feedback-edit-textarea-${draft.id}`);
    fireEvent.change(textarea, { target: { value: 'updated comment text' } });
    fireEvent.click(screen.getByTestId(`feedback-edit-save-${draft.id}`));

    await waitFor(() => expect(updateCommentMock).toHaveBeenCalledWith(draft.id, 'updated comment text'));
  });

  it('deletes a draft comment', async () => {
    const draft = makeComment();
    setFeedback({ comments: [draft] });
    renderPanel();

    fireEvent.click(screen.getByTestId(`feedback-draft-delete-${draft.id}`));
    await waitFor(() => expect(deleteCommentMock).toHaveBeenCalledWith(draft.id));
  });

  it('shows a stale-anchor badge when the comment predates the current document text', () => {
    const draft = makeComment({ anchor: { quote: 'the login flow', occurrence: 0, bodyHash: 'stale-hash' } });
    setFeedback({ comments: [draft] });
    renderPanel();
    expect(screen.getByTestId(`feedback-stale-badge-${draft.id}`)).toBeInTheDocument();
  });

  it('renders sent comments read-only (no edit/delete) alongside the pending banner', () => {
    const sent = makeComment({ id: 'cmt-sent', status: 'sent', batchId: 'batch-1' });
    setFeedback({ comments: [sent], batches: [makeBatch({ status: 'pending', round: 2 })] });
    renderPanel();

    expect(screen.getByTestId('feedback-pending-banner')).toHaveTextContent('Revision in progress — round 2…');
    expect(screen.getByTestId(`feedback-sent-row-${sent.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`feedback-draft-edit-${sent.id}`)).not.toBeInTheDocument();
  });

  it('shows a dismissable failed-batch banner with its error', () => {
    setFeedback({ batches: [makeBatch({ status: 'failed', round: 1, error: 'agent crashed' })] });
    renderPanel();

    const banner = screen.getByTestId('feedback-failed-banner');
    expect(banner).toHaveTextContent('Revision failed (round 1)');
    expect(banner).toHaveTextContent('agent crashed');

    fireEvent.click(screen.getByTestId('feedback-failed-dismiss'));
    expect(screen.queryByTestId('feedback-failed-banner')).not.toBeInTheDocument();
  });

  it('groups addressed comments into a collapsed "Previous rounds" section that expands', () => {
    const addressed = makeComment({ id: 'cmt-addr', status: 'addressed', batchId: 'batch-1' });
    setFeedback({ comments: [addressed], batches: [makeBatch({ status: 'applied', round: 3 })] });
    renderPanel();

    expect(screen.getByTestId('feedback-history-toggle')).toHaveTextContent('Previous rounds (1)');
    expect(screen.queryByTestId('feedback-history-body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('feedback-history-toggle'));
    expect(screen.getByTestId('feedback-history-body')).toHaveTextContent('Round 3');
    expect(screen.getByTestId('feedback-history-body')).toHaveTextContent('clarify the error states');
  });

  // -- Send button gating -----------------------------------------------------

  it('disables Send with "No open review gate" when no pending decision gate exists', () => {
    setFeedback({ comments: [makeComment()] });
    setReviewItems([]); // no gate
    renderPanel();

    const button = screen.getByTestId('feedback-send-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No open review gate');
  });

  it('disables Send with "No draft comments to send" when there is a gate but no drafts', () => {
    setFeedback({ comments: [] });
    setReviewItems([makeGateItem()]);
    renderPanel();

    const button = screen.getByTestId('feedback-send-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No draft comments to send');
  });

  it('disables Send with "Idea already decomposed" regardless of gate/drafts/pending state', () => {
    setFeedback({ comments: [makeComment()] });
    setReviewItems([makeGateItem()]);
    renderPanel({ ideaDecomposed: true });

    const button = screen.getByTestId('feedback-send-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Idea already decomposed');
  });

  it('disables Send with "Revision in progress" when a batch is already pending', () => {
    setFeedback({ comments: [makeComment()], batches: [makeBatch({ status: 'pending' })] });
    setReviewItems([makeGateItem()]);
    renderPanel();

    const button = screen.getByTestId('feedback-send-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Revision in progress');
  });

  it('enables Send when a gate is open, drafts exist, the idea is not decomposed, and no batch is pending', async () => {
    setFeedback({ comments: [makeComment()] });
    setReviewItems([makeGateItem()]);
    renderPanel();

    const button = screen.getByTestId('feedback-send-button');
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Send feedback (1)');

    fireEvent.click(button);
    await waitFor(() => expect(sendBatchMock).toHaveBeenCalledTimes(1));
  });

  it('surfaces a noOp refusal reason inline instead of silently doing nothing', async () => {
    sendBatchMock.mockResolvedValueOnce({ noOp: true, reason: 'busy' });
    setFeedback({ comments: [makeComment()] });
    setReviewItems([makeGateItem()]);
    renderPanel();

    fireEvent.click(screen.getByTestId('feedback-send-button'));
    await waitFor(() =>
      expect(screen.getByTestId('feedback-noop-warning')).toHaveTextContent('A revision is already in progress.'),
    );
  });

  it('only counts pending blocking decision gates for THIS run', () => {
    setFeedback({ comments: [makeComment()] });
    setReviewItems([makeGateItem({ run_id: 'other-run' })]);
    renderPanel();
    expect(screen.getByTestId('feedback-send-button')).toHaveAttribute('title', 'No open review gate');
  });
});
