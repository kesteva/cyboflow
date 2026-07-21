import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentProposal, AgentProposalStatus } from '../../../../shared/types/agentThread';

vi.mock('./ProposalCard', () => ({
  ProposalCard: ({ proposal }: { proposal: AgentProposal }) => (
    <div data-testid="proposal-card-stub" data-id={proposal.id} data-status={proposal.status} />
  ),
}));

import { ProposalCardList } from './ProposalCardList';
import { RESOLVED_PROPOSAL_TTL_MS } from './useTransientResolvedProposals';

function makeProposal(id: string, status: AgentProposalStatus = 'proposed'): AgentProposal {
  return {
    id,
    threadId: 'thread-1',
    kind: 'open-session',
    payload: { kind: 'open-session', navigation: { target: 'run', runId: 'run-1' } },
    preconditions: null,
    status,
    result: null,
    idempotencyKey: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    decidedAt: null,
  };
}

describe('ProposalCardList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when there are no proposals', () => {
    const { container } = render(<ProposalCardList proposals={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one ProposalCard per actionable proposal, in the given (oldest-first) order', () => {
    render(<ProposalCardList proposals={[makeProposal('p1'), makeProposal('p2')]} />);

    const cards = screen.getAllByTestId('proposal-card-stub');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-id', 'p1');
    expect(cards[1]).toHaveAttribute('data-id', 'p2');
  });

  it('never renders a proposal that is already resolved on first observation (initial load)', () => {
    render(
      <ProposalCardList
        proposals={[makeProposal('already-done', 'executed'), makeProposal('active', 'proposed')]}
      />
    );

    const cards = screen.getAllByTestId('proposal-card-stub');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute('data-id', 'active');
  });

  it('never renders a proposal first observed already resolved, even mid-session on a later render', () => {
    const { rerender } = render(<ProposalCardList proposals={[makeProposal('active', 'proposed')]} />);
    expect(screen.getAllByTestId('proposal-card-stub')).toHaveLength(1);

    rerender(
      <ProposalCardList
        proposals={[makeProposal('active', 'proposed'), makeProposal('late-arrival', 'executed')]}
      />
    );

    const cards = screen.getAllByTestId('proposal-card-stub');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute('data-id', 'active');
  });

  it('shows a proposal that resolves while mounted, then expires it after the TTL elapses', () => {
    const { rerender } = render(<ProposalCardList proposals={[makeProposal('p1', 'proposed')]} />);
    expect(screen.getAllByTestId('proposal-card-stub')).toHaveLength(1);

    rerender(<ProposalCardList proposals={[makeProposal('p1', 'executed')]} />);
    expect(screen.getByTestId('proposal-card-stub')).toHaveAttribute('data-status', 'executed');

    act(() => {
      vi.advanceTimersByTime(RESOLVED_PROPOSAL_TTL_MS / 2);
    });
    rerender(<ProposalCardList proposals={[makeProposal('p1', 'executed')]} />);
    expect(screen.getByTestId('proposal-card-stub')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(RESOLVED_PROPOSAL_TTL_MS);
    });
    rerender(<ProposalCardList proposals={[makeProposal('p1', 'executed')]} />);
    expect(screen.queryByTestId('proposal-card-stub')).not.toBeInTheDocument();
  });

  it('treats a dismissed transition the same as any other resolution', () => {
    const { rerender } = render(<ProposalCardList proposals={[makeProposal('p1', 'proposed')]} />);

    rerender(<ProposalCardList proposals={[makeProposal('p1', 'dismissed')]} />);
    expect(screen.getByTestId('proposal-card-stub')).toHaveAttribute('data-status', 'dismissed');

    act(() => {
      vi.advanceTimersByTime(RESOLVED_PROPOSAL_TTL_MS * 1.5);
    });
    rerender(<ProposalCardList proposals={[makeProposal('p1', 'dismissed')]} />);
    expect(screen.queryByTestId('proposal-card-stub')).not.toBeInTheDocument();
  });

  it('renders null once every proposal has expired or was filtered out', () => {
    const { rerender, container } = render(<ProposalCardList proposals={[makeProposal('p1', 'proposed')]} />);

    rerender(<ProposalCardList proposals={[makeProposal('p1', 'executed')]} />);
    act(() => {
      vi.advanceTimersByTime(RESOLVED_PROPOSAL_TTL_MS * 1.5);
    });
    rerender(<ProposalCardList proposals={[makeProposal('p1', 'executed')]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
