/**
 * ProposalCardList — renders a thread's proposals as a stack of
 * {@link ProposalCard}s (S1.3), mounted in {@link AgentThreadView}'s bottomSlot
 * above the composer. `agentThreadStore.proposals` is already oldest-first
 * (see its docstring), so proposals render in that order — newest at the
 * bottom, immediately above the composer, matching a chat-log's natural
 * reading order. Renders nothing when there are no proposals yet.
 */
import type { AgentProposal } from '../../../../shared/types/agentThread';
import { ProposalCard } from './ProposalCard';

export interface ProposalCardListProps {
  proposals: AgentProposal[];
}

export function ProposalCardList({ proposals }: ProposalCardListProps): React.ReactElement | null {
  if (proposals.length === 0) return null;

  return (
    <div data-testid="proposal-card-list" className="flex flex-col gap-2">
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
