/**
 * useTransientResolvedProposals — turns resolved proposals into transient
 * notifications for {@link ProposalCardList}.
 *
 * Rules:
 *  - A proposal in an actionable status ('proposed' | 'executing') always
 *    passes through.
 *  - A proposal that is ALREADY resolved the first time this hook observes
 *    its id (initial mount / app relaunch) never renders — it's marked
 *    stale forever.
 *  - A proposal that transitions from an actionable status to a resolved
 *    one while mounted stays visible for {@link RESOLVED_PROPOSAL_TTL_MS},
 *    then disappears.
 *
 * The "first seen" / "just transitioned" bookkeeping happens synchronously
 * during render (idempotent ref mutations, safe under React's double-invoke
 * in StrictMode/dev) so an already-resolved proposal never flashes on
 * mount. The only *scheduled* state update is the timeout that forces a
 * re-render once the soonest pending expiry elapses — real `setState`
 * happens exclusively from that effect's timer callback, never from render.
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentProposal, AgentProposalStatus } from '../../../../shared/types/agentThread';

export const RESOLVED_PROPOSAL_TTL_MS = 45_000;

// Mirrors ProposalCard.tsx's private RESOLVED_STATUSES — kept local here so
// this hook has no dependency on ProposalCard's rendering module.
const RESOLVED_STATUSES: ReadonlySet<AgentProposalStatus> = new Set([
  'executed',
  'failed',
  'dismissed',
  'superseded',
]);

function isResolvedProposalStatus(status: AgentProposalStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}

export function useTransientResolvedProposals(proposals: AgentProposal[]): AgentProposal[] {
  const lastStatusRef = useRef<Map<string, AgentProposalStatus>>(new Map());
  const staleForeverRef = useRef<Set<string>>(new Set());
  const expiresAtRef = useRef<Map<string, number>>(new Map());
  const [, setTick] = useState(0);

  // 1. Update transition bookkeeping for the ids present this render.
  for (const proposal of proposals) {
    const prevStatus = lastStatusRef.current.get(proposal.id);
    const nowResolved = isResolvedProposalStatus(proposal.status);
    if (prevStatus === undefined) {
      if (nowResolved) staleForeverRef.current.add(proposal.id);
    } else if (!isResolvedProposalStatus(prevStatus) && nowResolved) {
      expiresAtRef.current.set(proposal.id, Date.now() + RESOLVED_PROPOSAL_TTL_MS);
    }
    lastStatusRef.current.set(proposal.id, proposal.status);
  }

  // 2. Derive the visible list, cleaning up expired timers as we go.
  const now = Date.now();
  const visible: AgentProposal[] = [];
  let soonestExpiry: number | null = null;
  for (const proposal of proposals) {
    if (!isResolvedProposalStatus(proposal.status)) {
      visible.push(proposal);
      continue;
    }
    if (staleForeverRef.current.has(proposal.id)) continue;
    const expiresAt = expiresAtRef.current.get(proposal.id);
    if (expiresAt === undefined) continue;
    if (expiresAt <= now) {
      expiresAtRef.current.delete(proposal.id);
      continue;
    }
    visible.push(proposal);
    if (soonestExpiry === null || expiresAt < soonestExpiry) soonestExpiry = expiresAt;
  }

  // 3. Schedule a re-render for the soonest pending expiry, if any.
  useEffect(() => {
    if (soonestExpiry === null) return;
    const delay = Math.max(soonestExpiry - Date.now(), 0);
    const timer = setTimeout(() => setTick((t) => t + 1), delay);
    return () => clearTimeout(timer);
  }, [soonestExpiry]);

  return visible;
}
