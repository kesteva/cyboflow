/**
 * AgentThreadView — the global-agent thread's transcript, proposal cards, and
 * composer (S1.2 + S1.3), mounted inside AgentRail's body. Renders through the
 * SAME UnifiedChatView the workflow-run and quick-session hosts use (ChatMode
 * 'agent') so the three never visually drift — see
 * docs/proposals/GLOBAL-AGENT-PLAN.md §2.3 / §3 S1.2/S1.3. {@link ProposalCardList}
 * mounts above the suggestion chips/composer, keyed off
 * `useAgentThreadStore(s => s.proposals)`.
 */
import { useEffect } from 'react';
import { UnifiedChatView } from '../cyboflow/unified/UnifiedChatView';
import { useUnifiedAgentThreadMessages } from '../cyboflow/unified/useUnifiedAgentThreadMessages';
import { useAgentThreadStore } from '../../stores/agentThreadStore';
import { AgentComposer } from './AgentComposer';
import { AgentSuggestionChips } from './AgentSuggestionChips';
import { ProposalCardList } from './ProposalCardList';

/**
 * Module-scoped once-per-app-launch gate for the auto-digest trigger. A plain
 * `useEffect(..., [])` inside this component would re-fire every time AgentRail
 * remounts — it unmounts whenever the user leaves a landing-family view (see
 * `shouldShowAgentRail` in AgentRail.tsx) — so the guard must live OUTSIDE
 * React state/component lifecycle. The server-side cap
 * (AgentThreadService.triggerDigest, once per local calendar day, PERSISTED in
 * agent_threads.last_digest_at) is the real authority across launches; this is
 * just "don't re-ask on every navigation within one launch".
 */
let digestTriggeredThisLaunch = false;

export function AgentThreadView(): React.ReactElement {
  const thread = useAgentThreadStore((s) => s.thread);
  const sending = useAgentThreadStore((s) => s.sending);
  const sendMessage = useAgentThreadStore((s) => s.sendMessage);
  const triggerDigest = useAgentThreadStore((s) => s.triggerDigest);
  const proposals = useAgentThreadStore((s) => s.proposals);

  const { messages, loadError } = useUnifiedAgentThreadMessages(thread?.id ?? null);

  // Auto-digest: gated on `thread` (not on mount) — init()'s getThread query
  // resolves asynchronously, and `thread` is Zustand state that survives
  // AgentRail unmount/remount, so this fires exactly once per launch the
  // first time a thread is available, however many times the rail toggles
  // in and out of view before then. We set the gate OPTIMISTICALLY (before the
  // await) so a concurrent remount can't double-fire, then REOPEN it if the
  // attempt was non-consuming — assistant disabled, or the call failed before
  // the backend stamped the day — so a later remount (e.g. after the user
  // enables the assistant) can retry this launch. A 'consumed' outcome (sent,
  // or the persisted once-per-day cap already fired today) keeps it closed.
  useEffect(() => {
    if (thread === null || digestTriggeredThisLaunch) return;
    digestTriggeredThisLaunch = true;
    void triggerDigest().then((outcome) => {
      if (outcome === 'retry') digestTriggeredThisLaunch = false;
    });
  }, [thread, triggerDigest]);

  const handleSend = (text: string): void => {
    void sendMessage(text);
  };

  return (
    <UnifiedChatView
      name="cyboflow assistant"
      transport="sdk"
      mode="agent"
      running={sending}
      messages={messages}
      loadError={loadError}
      isWaitingForResponse={sending}
      folderLabel={null}
      branchName={null}
      contextUsage={null}
      railId={thread?.id ?? 'agent'}
      bottomSlot={
        <div className="flex flex-col gap-2 border-t border-border-primary p-3">
          <ProposalCardList proposals={proposals} />
          <AgentSuggestionChips onSend={handleSend} disabled={sending} />
          <AgentComposer onSend={handleSend} disabled={sending || thread === null} />
        </div>
      }
    />
  );
}
