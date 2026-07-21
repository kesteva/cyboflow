/**
 * ProposalCardList — renders a thread's proposals as a stack of
 * {@link ProposalCard}s (S1.3), mounted in {@link AgentThreadView}'s bottomSlot
 * above the composer. `agentThreadStore.proposals` is already oldest-first
 * (see its docstring), so proposals render in that order — newest at the
 * bottom, immediately above the composer, matching a chat-log's natural
 * reading order.
 *
 * Resolved proposals are transient: {@link useTransientResolvedProposals}
 * hides ones already resolved on first observation and expires the rest a
 * short while after they resolve, so a completed action doesn't linger in
 * the rail forever. Renders nothing once the visible list is empty.
 */
import type { AgentProposal } from '../../../../shared/types/agentThread';
import { ProposalCard } from './ProposalCard';
import { useTransientResolvedProposals } from './useTransientResolvedProposals';

export interface ProposalCardListProps {
  proposals: AgentProposal[];
}

export function ProposalCardList({ proposals }: ProposalCardListProps): React.ReactElement | null {
  const visible = useTransientResolvedProposals(proposals);
  if (visible.length === 0) return null;

  return (
    <div data-testid="proposal-card-list" className="flex flex-col gap-2">
      {visible.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
