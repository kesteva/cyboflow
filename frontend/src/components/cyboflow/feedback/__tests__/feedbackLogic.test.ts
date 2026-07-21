import { describe, it, expect } from 'vitest';
import {
  computeSendDisabledReason,
  groupAddressedByRound,
  latestBatchStatus,
} from '../feedbackLogic';
import type { FeedbackBatch, FeedbackComment } from '../../../../../../shared/types/feedback';

function makeComment(overrides: Partial<FeedbackComment> = {}): FeedbackComment {
  return {
    id: 'cmt-1',
    projectId: 1,
    runId: 'run-1',
    atype: 'idea-spec',
    sourceRef: 'idea-1',
    batchId: null,
    anchor: { quote: 'hello', occurrence: 0, bodyHash: 'abc' },
    body: 'please clarify',
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

describe('computeSendDisabledReason', () => {
  it('is enabled (null) when everything lines up', () => {
    expect(
      computeSendDisabledReason({
        draftCount: 2,
        ideaDecomposed: false,
        hasPendingGate: true,
        hasPendingBatch: false,
      }),
    ).toBeNull();
  });

  it('prioritizes decomposed over every other reason', () => {
    expect(
      computeSendDisabledReason({
        draftCount: 2,
        ideaDecomposed: true,
        hasPendingGate: true,
        hasPendingBatch: true,
      }),
    ).toBe('Idea already decomposed');
  });

  it('flags a pending batch before gate-absence and draft-count', () => {
    expect(
      computeSendDisabledReason({
        draftCount: 2,
        ideaDecomposed: false,
        hasPendingGate: false,
        hasPendingBatch: true,
      }),
    ).toBe('Revision in progress');
  });

  it('flags no open gate before draft-count', () => {
    expect(
      computeSendDisabledReason({
        draftCount: 0,
        ideaDecomposed: false,
        hasPendingGate: false,
        hasPendingBatch: false,
      }),
    ).toBe('No open review gate');
  });

  it('flags zero drafts last', () => {
    expect(
      computeSendDisabledReason({
        draftCount: 0,
        ideaDecomposed: false,
        hasPendingGate: true,
        hasPendingBatch: false,
      }),
    ).toBe('No draft comments to send');
  });
});

describe('groupAddressedByRound', () => {
  it('groups addressed comments by batch round, newest first', () => {
    const batches = [
      makeBatch({ id: 'b1', round: 1, status: 'applied' }),
      makeBatch({ id: 'b2', round: 2, status: 'applied' }),
    ];
    const comments = [
      makeComment({ id: 'c1', batchId: 'b1', status: 'addressed' }),
      makeComment({ id: 'c2', batchId: 'b2', status: 'addressed' }),
      makeComment({ id: 'c3', batchId: 'b1', status: 'addressed' }),
    ];
    const groups = groupAddressedByRound(comments, batches);
    expect(groups.map((g) => g.round)).toEqual([2, 1]);
    expect(groups[0].comments.map((c) => c.id)).toEqual(['c2']);
    expect(groups[1].comments.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('ignores drafts and sent comments — only addressed groups', () => {
    const batches = [makeBatch({ id: 'b1', round: 1 })];
    const comments = [
      makeComment({ id: 'c1', status: 'draft' }),
      makeComment({ id: 'c2', status: 'sent', batchId: 'b1' }),
    ];
    expect(groupAddressedByRound(comments, batches)).toEqual([]);
  });

  it('ignores an addressed comment with a null batchId', () => {
    const comments = [makeComment({ id: 'c1', status: 'addressed', batchId: null })];
    expect(groupAddressedByRound(comments, [])).toEqual([]);
  });

  it('falls back to round 0 when the owning batch is missing from the batches list', () => {
    const comments = [makeComment({ id: 'c1', status: 'addressed', batchId: 'ghost' })];
    const groups = groupAddressedByRound(comments, []);
    expect(groups).toEqual([{ round: 0, batchId: 'ghost', comments: [comments[0]] }]);
  });
});

describe('latestBatchStatus', () => {
  it('returns null when the idea has no batches', () => {
    expect(latestBatchStatus([], 'idea-1')).toBeNull();
  });

  it('picks the most RECENT batch (by createdAt) across BOTH atypes for the idea', () => {
    const batches = [
      makeBatch({ id: 'b1', atype: 'idea-spec', sourceRef: 'idea-1', round: 1, status: 'applied', createdAt: '2026-07-01T00:00:00.000Z' }),
      makeBatch({ id: 'b2', atype: 'arch-design', sourceRef: 'idea-1', round: 2, status: 'pending', createdAt: '2026-07-02T00:00:00.000Z' }),
      makeBatch({ id: 'b3', atype: 'idea-spec', sourceRef: 'idea-OTHER', round: 5, status: 'applied', createdAt: '2026-07-03T00:00:00.000Z' }),
    ];
    expect(latestBatchStatus(batches, 'idea-1')).toEqual({ kind: 'pending', round: 2 });
  });

  it('an OLDER-createdAt applied idea-spec round does not hide a NEWER pending arch-design round', () => {
    // round is scoped per (atype, sourceRef) — idea-spec round 2 is not "later"
    // than arch-design round 1 just because its round number is higher.
    const batches = [
      makeBatch({ id: 'b-spec', atype: 'idea-spec', sourceRef: 'idea-1', round: 2, status: 'applied', createdAt: '2026-07-01T00:00:00.000Z' }),
      makeBatch({ id: 'b-arch', atype: 'arch-design', sourceRef: 'idea-1', round: 1, status: 'pending', createdAt: '2026-07-05T00:00:00.000Z' }),
    ];
    expect(latestBatchStatus(batches, 'idea-1')).toEqual({ kind: 'pending', round: 1 });
  });

  it('ties on createdAt break by status priority: pending > failed > applied', () => {
    const tied = '2026-07-01T00:00:00.000Z';
    const applied = makeBatch({ id: 'b-applied', round: 1, status: 'applied', createdAt: tied });
    const failed = makeBatch({ id: 'b-failed', round: 2, status: 'failed', error: 'boom', createdAt: tied });
    const pending = makeBatch({ id: 'b-pending', round: 3, status: 'pending', createdAt: tied });

    expect(latestBatchStatus([applied, failed], 'idea-1')).toEqual({ kind: 'failed', round: 2, error: 'boom' });
    expect(latestBatchStatus([failed, pending], 'idea-1')).toEqual({ kind: 'pending', round: 3 });
    expect(latestBatchStatus([applied, pending, failed], 'idea-1')).toEqual({ kind: 'pending', round: 3 });
  });

  it('passes a single batch through unchanged', () => {
    const batches = [makeBatch({ round: 4, status: 'applied' })];
    expect(latestBatchStatus(batches, 'idea-1')).toEqual({ kind: 'applied', round: 4 });
  });

  it('surfaces a failed batch with its error', () => {
    const batches = [makeBatch({ round: 1, status: 'failed', error: 'agent crashed' })];
    expect(latestBatchStatus(batches, 'idea-1')).toEqual({ kind: 'failed', round: 1, error: 'agent crashed' });
  });

  it('reports applied for a successfully-applied latest batch', () => {
    const batches = [makeBatch({ round: 3, status: 'applied' })];
    expect(latestBatchStatus(batches, 'idea-1')).toEqual({ kind: 'applied', round: 3 });
  });
});
