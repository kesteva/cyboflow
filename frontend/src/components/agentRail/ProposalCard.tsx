/**
 * ProposalCard — one proposal, rendered per its kind and status (S1.3).
 *
 * Card anatomy mirrors the design packet's "Action Cards.dc.html" (source of
 * truth, see docs/proposals/GLOBAL-AGENT-PLAN.md §3 S1.3): a dark head bar
 * (`PROPOSED ACTION · <kind>` + amber "needs confirm") over a kind-specific
 * body (delegated to {@link ProposalCardBodies}) with a rust-primary Confirm
 * + ghost Dismiss footer, while `status === 'proposed'`. On any terminal
 * status the head bar/footer disappear and the card collapses to a compact
 * resolved row — a status circle + a bold verb + muted detail — EXCEPT
 * reprioritize-backlog, which keeps its ranked rows visible with a per-item
 * ✓/✕ overlay (the brief's explicit ask for partial-failure visibility, not a
 * one-line opaque summary).
 *
 * Confirm/dismiss wiring:
 *   - Confirm sets a LOCAL optimistic 'executing' flag immediately (spinner +
 *     disabled footer) for the round-trip latency window. `agentThreadStore`'s
 *     own `confirmProposal` action already refreshes `proposals` from the
 *     server BEFORE its promise resolves (see agentThreadStore.ts), so by the
 *     time this handler's `finally` clears the local flag, the incoming
 *     `proposal` PROP already reflects the server truth — the local flag never
 *     fights the prop.
 *   - A `{ok:false, reason:'claimed'}` race-loser response is NOT an error:
 *     the store's post-mutate refresh already pulled the WINNER's terminal
 *     state into `proposals`, so this card's next render shows that (real)
 *     resolved state instead of the stale 'proposed' one — no error UI needed,
 *     the finally-block just drops the local optimistic flag and lets the
 *     refreshed prop take over.
 *   - 'superseded' / 'validation-failed' are likewise already persisted server-
 *     side (supersedeProposal / finalizeProposal) before the mutation resolves,
 *     so the refreshed prop's `status`/`result` alone drive those card states —
 *     no special-casing needed here beyond reading them.
 *   - `ok:true, kind:'open-session'` is the ONE result that requires a client
 *     action beyond re-rendering: performing the navigation (proposalNavigation.ts).
 *   - A thrown mutation (transport/network failure, not a discriminated
 *     `ok:false`) is caught and surfaced as a small inline error — the store's
 *     confirmProposal/dismissProposal do not swallow rejections themselves.
 */
import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AgentProposal, AgentProposalStatus } from '../../../../shared/types/agentThread';
import { useAgentThreadStore } from '../../stores/agentThreadStore';
import {
  PROPOSAL_KIND_LABEL,
  LaunchRunBody,
  ReprioritizeBacklogBody,
  ReprioritizeBacklogRows,
  EditWorkflowBody,
  OpenSessionBody,
} from './ProposalCardBodies';
import {
  parseLaunchRunResult,
  parseReprioritizeResult,
  parseEditWorkflowResult,
} from './proposalResultTypes';
import { navigateToProposalTarget } from './proposalNavigation';

const RESOLVED_STATUSES: ReadonlySet<AgentProposalStatus> = new Set([
  'executed',
  'failed',
  'dismissed',
  'superseded',
]);

function isResolved(status: AgentProposalStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Status circle — the packet's 24-26px resolved-row indicator.
// ---------------------------------------------------------------------------

type CircleTone = 'success' | 'error' | 'warning' | 'neutral';

const CIRCLE_CLASS: Record<CircleTone, string> = {
  success: 'bg-status-success text-text-on-status-success',
  error: 'bg-status-error text-text-on-status-error',
  warning: 'bg-status-warning text-text-on-status-warning',
  // No text-on-status-neutral token exists (colors.css only defines
  // success/warning/error/info) — paper-on-neutral is the closest legible pair.
  neutral: 'bg-status-neutral text-bg-primary',
};

function StatusCircle({ tone, glyph }: { tone: CircleTone; glyph: string }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      data-testid="proposal-status-circle"
      data-tone={tone}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${CIRCLE_CLASS[tone]}`}
    >
      {glyph}
    </span>
  );
}

function ResolvedLine({
  tone,
  glyph,
  verb,
  detail,
}: {
  tone: CircleTone;
  glyph: string;
  verb: string;
  detail?: string | null;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5 p-2.5" data-testid="proposal-card-resolved-row">
      <StatusCircle tone={tone} glyph={glyph} />
      <div className="text-[11px] leading-snug">
        <span className="font-bold text-text-primary">{verb}</span>
        {detail != null && detail !== '' && <span className="text-text-tertiary"> {detail}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resolved-state renderers per kind
// ---------------------------------------------------------------------------

function LaunchRunResolved({ proposal }: { proposal: AgentProposal }): React.ReactElement {
  if (proposal.status === 'dismissed') {
    return <ResolvedLine tone="neutral" glyph="✕" verb="Dismissed." />;
  }
  const r = parseLaunchRunResult(proposal.result);
  if (r === null) {
    return <ResolvedLine tone={proposal.status === 'failed' ? 'error' : 'success'} verb="Resolved." glyph={proposal.status === 'failed' ? '✕' : '✓'} />;
  }
  if (r.status === 'executed') {
    return <ResolvedLine tone="success" glyph="✓" verb="Run launched." detail={r.runId != null ? `run ${r.runId}` : undefined} />;
  }
  return <ResolvedLine tone="error" glyph="✕" verb="Launch failed." detail={r.error} />;
}

function ReprioritizeResolved({ proposal }: { proposal: AgentProposal }): React.ReactElement {
  if (proposal.status === 'dismissed') {
    return <ResolvedLine tone="neutral" glyph="✕" verb="Dismissed." />;
  }
  const payload = proposal.payload.kind === 'reprioritize-backlog' ? proposal.payload : null;
  const result = parseReprioritizeResult(proposal.result);
  if (payload === null) {
    return <ResolvedLine tone="error" glyph="✕" verb="Resolved." />;
  }
  const okCount = result?.items.filter((i) => i.ok).length ?? 0;
  const total = payload.items.length;
  return (
    <div className="flex flex-col gap-2 p-2.5">
      <div className="flex items-center gap-2.5">
        <StatusCircle tone={result?.status === 'failed' ? 'warning' : 'success'} glyph={result?.status === 'failed' ? '!' : '✓'} />
        <span className="text-[11px] font-bold text-text-primary">
          Reprioritized {okCount} of {total} task{total === 1 ? '' : 's'}.
        </span>
      </div>
      <ReprioritizeBacklogRows items={payload.items} result={result} />
    </div>
  );
}

function EditWorkflowResolved({ proposal }: { proposal: AgentProposal }): React.ReactElement {
  if (proposal.status === 'dismissed') {
    return <ResolvedLine tone="neutral" glyph="✕" verb="Dismissed." />;
  }
  if (proposal.status === 'superseded') {
    return (
      <ResolvedLine
        tone="warning"
        glyph="↻"
        verb="Changed since drafted."
        detail="The workflow moved before this edit landed — a refreshed diff is coming in the next turn."
      />
    );
  }
  const r = parseEditWorkflowResult(proposal.result);
  if (r === null) {
    return <ResolvedLine tone={proposal.status === 'failed' ? 'error' : 'success'} glyph={proposal.status === 'failed' ? '✕' : '✓'} verb="Resolved." />;
  }
  if (r.status === 'executed') {
    return <ResolvedLine tone="success" glyph="✓" verb="Workflow updated." detail={r.workflowId} />;
  }
  if (r.reason === 'validation-failed' && r.issues != null) {
    return (
      <div className="flex flex-col gap-1.5 p-2.5" data-testid="proposal-validation-issues">
        <div className="flex items-center gap-2.5">
          <StatusCircle tone="error" glyph="✕" />
          <span className="text-[11px] font-bold text-text-primary">Edit did not validate.</span>
        </div>
        <ul className="ml-7 list-disc text-[10.5px] text-text-tertiary">
          {r.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
        <p className="ml-7 text-[10.5px] italic text-text-tertiary">A revised edit is coming in the next turn.</p>
      </div>
    );
  }
  return <ResolvedLine tone="error" glyph="✕" verb="Edit failed." detail={r.reason} />;
}

function OpenSessionResolved({ proposal }: { proposal: AgentProposal }): React.ReactElement {
  if (proposal.status === 'dismissed') {
    return <ResolvedLine tone="neutral" glyph="✕" verb="Dismissed." />;
  }
  return <ResolvedLine tone="success" glyph="✓" verb="Opened." />;
}

// ---------------------------------------------------------------------------
// ProposalCard
// ---------------------------------------------------------------------------

export interface ProposalCardProps {
  proposal: AgentProposal;
}

export function ProposalCard({ proposal }: ProposalCardProps): React.ReactElement {
  const confirmProposal = useAgentThreadStore((s) => s.confirmProposal);
  const dismissProposal = useAgentThreadStore((s) => s.dismissProposal);
  const [optimisticExecuting, setOptimisticExecuting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resolved = isResolved(proposal.status);
  const isExecuting = optimisticExecuting || proposal.status === 'executing';

  const handleConfirm = useCallback(async () => {
    setActionError(null);
    setOptimisticExecuting(true);
    try {
      const result = await confirmProposal(proposal.id);
      // 'claimed' / 'not-found' / 'not-executable' are refusals, not errors —
      // the store already refreshed `proposals` with the server's real state
      // (the winner's, for a claimed race), so nothing else to do here.
      //
      // Narrowing note: `result.kind === 'open-session'` alone does NOT
      // discriminate the union — the executor's ok:true branch types `kind` as
      // the full `AgentProposalKind` (it can never ACTUALLY be 'open-session'
      // at runtime, since the executor rejects that kind before returning
      // ok:true, but the type doesn't encode that). The `navigation` property
      // is the only field unique to the open-session branch, so check for it.
      if (result.ok && 'navigation' in result) {
        navigateToProposalTarget(result.navigation);
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Could not confirm — please try again.');
    } finally {
      setOptimisticExecuting(false);
    }
  }, [confirmProposal, proposal.id]);

  const handleDismiss = useCallback(async () => {
    setActionError(null);
    try {
      await dismissProposal(proposal.id);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Could not dismiss — please try again.');
    }
  }, [dismissProposal, proposal.id]);

  return (
    <div
      data-testid="proposal-card"
      data-kind={proposal.kind}
      data-status={proposal.status}
      className="border-[1.4px] border-border-emphasized bg-surface-primary transition-[border-color] duration-[120ms]"
    >
      {!resolved && (
        <div className="flex items-center gap-2 bg-text-primary px-2.5 py-1.5 text-[9px] uppercase tracking-[0.18em] text-text-on-interactive">
          <span>Proposed action &middot; {PROPOSAL_KIND_LABEL[proposal.kind]}</span>
          <span className="flex-1" />
          {isExecuting ? (
            <span className="flex items-center gap-1 normal-case tracking-normal opacity-80" data-testid="proposal-card-confirming">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              confirming&hellip;
            </span>
          ) : (
            <span className="text-status-warning" data-testid="proposal-card-needs-confirm">
              needs confirm
            </span>
          )}
        </div>
      )}

      {!resolved && (
        <div className="p-3">
          {proposal.kind === 'launch-run' && proposal.payload.kind === 'launch-run' && (
            <LaunchRunBody payload={proposal.payload} />
          )}
          {proposal.kind === 'reprioritize-backlog' && proposal.payload.kind === 'reprioritize-backlog' && (
            <ReprioritizeBacklogBody payload={proposal.payload} />
          )}
          {proposal.kind === 'edit-workflow' && proposal.payload.kind === 'edit-workflow' && (
            <EditWorkflowBody payload={proposal.payload} />
          )}
          {proposal.kind === 'open-session' && proposal.payload.kind === 'open-session' && (
            <OpenSessionBody payload={proposal.payload} />
          )}
        </div>
      )}

      {!resolved && (
        <div className="flex gap-1.5 border-t border-border-primary p-2.5">
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isExecuting}
            data-testid="proposal-card-confirm"
            className="flex-1 border border-interactive bg-interactive px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-text-on-interactive transition-[border-color] duration-[120ms] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => void handleDismiss()}
            disabled={isExecuting}
            data-testid="proposal-card-dismiss"
            className="border border-border-primary bg-surface-primary px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary transition-[border-color] duration-[120ms] hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            Dismiss
          </button>
        </div>
      )}

      {resolved && (
        <>
          {proposal.kind === 'launch-run' && <LaunchRunResolved proposal={proposal} />}
          {proposal.kind === 'reprioritize-backlog' && <ReprioritizeResolved proposal={proposal} />}
          {proposal.kind === 'edit-workflow' && <EditWorkflowResolved proposal={proposal} />}
          {proposal.kind === 'open-session' && <OpenSessionResolved proposal={proposal} />}
        </>
      )}

      {actionError != null && (
        <p className="border-t border-border-primary p-2 text-[10px] text-status-error" role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}
