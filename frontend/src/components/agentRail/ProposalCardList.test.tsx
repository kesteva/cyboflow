import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { AgentProposal } from '../../../../shared/types/agentThread';

vi.mock('./ProposalCard', () => ({
  ProposalCard: ({ proposal }: { proposal: AgentProposal }) => (
    <div data-testid="proposal-card-stub" data-id={proposal.id} />
  ),
}));

import { ProposalCardList } from './ProposalCardList';

function makeProposal(id: string): AgentProposal {
  return {
    id,
    threadId: 'thread-1',
    kind: 'open-session',
    payload: { kind: 'open-session', navigation: { target: 'run', runId: 'run-1' } },
    preconditions: null,
    status: 'proposed',
    result: null,
    idempotencyKey: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    decidedAt: null,
  };
}

describe('ProposalCardList', () => {
  it('renders nothing when there are no proposals', () => {
    const { container } = render(<ProposalCardList proposals={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one ProposalCard per proposal, in the given (oldest-first) order', () => {
    render(<ProposalCardList proposals={[makeProposal('p1'), makeProposal('p2')]} />);

    const cards = screen.getAllByTestId('proposal-card-stub');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-id', 'p1');
    expect(cards[1]).toHaveAttribute('data-id', 'p2');
  });
});
