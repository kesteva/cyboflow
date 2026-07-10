/**
 * RunPendingInputStrip — persistent footer strip for a run's pending
 * review_items + live AskUserQuestion gates.
 *
 * Covers: null empty state; renders pending items for the run only
 * (blocking-first order comes from the shared selector); live-question
 * de-dupe (a live Question for the run suppresses any `source==='question'`
 * review item for that run and renders an AskUserQuestionCard instead).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { Question } from '../../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Mock stores — drive selectors from mutable module-level state; getState()
// returns spies for init() so we can assert mount/unmount wiring.
// ---------------------------------------------------------------------------

let mockItems: ReviewItem[] = [];
const mockReviewInit = vi.fn();
const mockReviewUnsubscribe = vi.fn();
mockReviewInit.mockImplementation(() => mockReviewUnsubscribe);

vi.mock('../../../stores/reviewItemsSlice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/reviewItemsSlice')>();
  const useReviewItemsSlice = Object.assign(
    (selector: (s: { items: ReviewItem[] }) => unknown) => selector({ items: mockItems }),
    { getState: () => ({ init: mockReviewInit }) },
  );
  return {
    ...actual,
    useReviewItemsSlice,
  };
});

let mockQuestionQueue: Question[] = [];
const mockQuestionInit = vi.fn();
const mockQuestionUnsubscribe = vi.fn();
mockQuestionInit.mockImplementation(() => mockQuestionUnsubscribe);

vi.mock('../../../stores/questionStore', () => ({
  useQuestionStore: Object.assign(
    (selector: (s: { queue: Question[] }) => unknown) => selector({ queue: mockQuestionQueue }),
    { getState: () => ({ init: mockQuestionInit }) },
  ),
}));

// Stand-ins for the reused cards, so we can count/attribute them cheaply.
vi.mock('../../ReviewQueue/ReviewItemCard', () => ({
  ReviewItemCard: ({ item }: { item: ReviewItem }) => (
    <div data-testid="review-item-card" data-item-id={item.id} data-kind={item.kind} data-blocking={item.blocking} />
  ),
}));

vi.mock('../../AskUserQuestion/AskUserQuestionCard', () => ({
  AskUserQuestionCard: ({ item }: { item: Question }) => (
    <div data-testid="ask-question-card" data-tool-use-id={item.toolUseId} data-run-id={item.runId} />
  ),
}));

import { RunPendingInputStrip } from '../RunPendingInputStrip';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rvw_1',
    project_id: 5,
    run_id: 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'finding',
    status: 'pending',
    blocking: false,
    title: 'Some finding',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: null,
    payload: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    runId: 'run-1',
    workflowName: 'sprint',
    toolUseId: 'tool-1',
    questions: [],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    answeredAt: null,
    answerJson: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockItems = [];
  mockQuestionQueue = [];
  mockReviewInit.mockClear();
  mockReviewUnsubscribe.mockClear();
  mockQuestionInit.mockClear();
  mockQuestionUnsubscribe.mockClear();
});

describe('RunPendingInputStrip', () => {
  it('renders null when there are no pending review items and no live questions', () => {
    const { container } = render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls reviewItemsSlice.init(projectId) (guarded on null) and questionStore.init() on mount, and unsubscribes reviewItemsSlice (but NOT questionStore) on unmount', () => {
    // questionStore.init() is an app-lifetime singleton owned by CyboflowRoot
    // for the whole app; this strip must call init() (harmless/idempotent)
    // but must NOT invoke the returned unsubscribe on its own unmount, since
    // it is never the sole owner of that subscription. reviewItemsSlice's
    // init is per-projectId (not a single unconditional global singleton),
    // so its unsubscribe-on-unmount contract is unaffected.
    const { unmount } = render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    expect(mockReviewInit).toHaveBeenCalledWith(5);
    expect(mockQuestionInit).toHaveBeenCalledWith();
    unmount();
    expect(mockReviewUnsubscribe).toHaveBeenCalled();
    expect(mockQuestionUnsubscribe).not.toHaveBeenCalled();
  });

  it('does not call reviewItemsSlice.init when projectId is null', () => {
    render(<RunPendingInputStrip runId="run-1" projectId={null} />);
    expect(mockReviewInit).not.toHaveBeenCalled();
    expect(mockQuestionInit).toHaveBeenCalled();
  });

  it('renders only pending items for this run, blocking-first', () => {
    mockItems = [
      makeReviewItem({ id: 'rvw-non-blocking', run_id: 'run-1', kind: 'decision', blocking: false }),
      makeReviewItem({ id: 'rvw-other-run', run_id: 'run-2', kind: 'decision', blocking: true }),
      makeReviewItem({ id: 'rvw-blocking', run_id: 'run-1', kind: 'decision', blocking: true }),
      makeReviewItem({ id: 'rvw-resolved', run_id: 'run-1', kind: 'decision', blocking: true, status: 'resolved' }),
    ];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    const cards = screen.getAllByTestId('review-item-card');
    expect(cards.map((c) => c.getAttribute('data-item-id'))).toEqual(['rvw-blocking', 'rvw-non-blocking']);
  });

  it('shows the header chip + shown count', () => {
    mockItems = [makeReviewItem({ id: 'rvw-1', run_id: 'run-1', kind: 'decision' })];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    expect(screen.getByTestId('pending-input-chip')).toHaveTextContent('Needs your input');
    expect(screen.getByTestId('pending-input-count')).toHaveTextContent('1');
  });

  it('caps max-height with an internal scroll region and a top border on the strip', () => {
    mockItems = [makeReviewItem({ id: 'rvw-1', run_id: 'run-1', kind: 'decision' })];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    const strip = screen.getByTestId('run-pending-input-strip');
    expect(strip).toHaveClass('border-t');
    expect(strip).toHaveStyle({ maxHeight: '40vh' });
    const scrollRegion = screen.getByRole('list');
    expect(scrollRegion).toHaveClass('overflow-y-auto');
  });

  it('renders a live question as an AskUserQuestionCard', () => {
    mockQuestionQueue = [makeQuestion({ toolUseId: 'tool-live', runId: 'run-1' })];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    const cards = screen.getAllByTestId('ask-question-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute('data-tool-use-id', 'tool-live');
  });

  it('ignores a live question for a different run', () => {
    mockQuestionQueue = [makeQuestion({ toolUseId: 'tool-other', runId: 'run-2' })];
    const { container } = render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('suppresses a source===question review item for the run when a live question is present (no duplicate surface)', () => {
    mockItems = [
      makeReviewItem({ id: 'rvw-question', run_id: 'run-1', kind: 'decision', source: 'question', payload: null }),
      makeReviewItem({ id: 'rvw-decision', run_id: 'run-1', kind: 'decision' }),
    ];
    mockQuestionQueue = [makeQuestion({ toolUseId: 'tool-live', runId: 'run-1' })];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);

    const reviewCards = screen.getAllByTestId('review-item-card');
    expect(reviewCards.map((c) => c.getAttribute('data-item-id'))).toEqual(['rvw-decision']);

    const questionCards = screen.getAllByTestId('ask-question-card');
    expect(questionCards).toHaveLength(1);
  });

  it('drops kind===finding items — findings go to the triage queue, not the strip', () => {
    mockItems = [
      makeReviewItem({ id: 'rvw-finding', run_id: 'run-1', kind: 'finding' }),
      makeReviewItem({ id: 'rvw-decision', run_id: 'run-1', kind: 'decision' }),
    ];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    expect(screen.getAllByTestId('review-item-card').map((c) => c.getAttribute('data-item-id'))).toEqual([
      'rvw-decision',
    ]);
  });

  it('keeps a source===question review item when no live question is present for the run', () => {
    mockItems = [
      makeReviewItem({ id: 'rvw-question', run_id: 'run-1', kind: 'decision', source: 'question', payload: null }),
    ];
    mockQuestionQueue = [];
    render(<RunPendingInputStrip runId="run-1" projectId={5} />);
    expect(screen.getAllByTestId('review-item-card').map((c) => c.getAttribute('data-item-id'))).toEqual([
      'rvw-question',
    ]);
  });
});
