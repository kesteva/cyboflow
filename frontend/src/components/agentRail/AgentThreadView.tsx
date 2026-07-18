/**
 * AgentThreadView — the global-agent thread's transcript + composer (S1.2),
 * mounted inside AgentRail's body. Renders through the SAME UnifiedChatView
 * the workflow-run and quick-session hosts use (ChatMode 'agent') so the three
 * never visually drift — see docs/proposals/GLOBAL-AGENT-PLAN.md §2.3 / §3 S1.2.
 */
import { useEffect } from 'react';
import { UnifiedChatView } from '../cyboflow/unified/UnifiedChatView';
import { useUnifiedAgentThreadMessages } from '../cyboflow/unified/useUnifiedAgentThreadMessages';
import { useAgentThreadStore } from '../../stores/agentThreadStore';
import { AgentComposer } from './AgentComposer';
import { AgentSuggestionChips } from './AgentSuggestionChips';

/**
 * Module-scoped once-per-app-launch gate for the auto-digest trigger. A plain
 * `useEffect(..., [])` inside this component would re-fire every time AgentRail
 * remounts — it unmounts whenever the user leaves a landing-family view (see
 * `shouldShowAgentRail` in AgentRail.tsx) — so the guard must live OUTSIDE
 * React state/component lifecycle. The server-side throttle
 * (AgentThreadService.DIGEST_THROTTLE_MS, ≥10min/thread) is the real
 * authority; this is just "don't re-ask on every navigation within one launch".
 */
let digestTriggeredThisLaunch = false;

export function AgentThreadView(): React.ReactElement {
  const thread = useAgentThreadStore((s) => s.thread);
  const sending = useAgentThreadStore((s) => s.sending);
  const sendMessage = useAgentThreadStore((s) => s.sendMessage);
  const triggerDigest = useAgentThreadStore((s) => s.triggerDigest);

  const { messages, loadError } = useUnifiedAgentThreadMessages(thread?.id ?? null);

  // Auto-digest: gated on `thread` (not on mount) — init()'s getThread query
  // resolves asynchronously, and `thread` is Zustand state that survives
  // AgentRail unmount/remount, so this fires exactly once per launch the
  // first time a thread is available, however many times the rail toggles
  // in and out of view before then.
  useEffect(() => {
    if (thread === null || digestTriggeredThisLaunch) return;
    digestTriggeredThisLaunch = true;
    void triggerDigest();
  }, [thread, triggerDigest]);

  const handleSend = (text: string): void => {
    void sendMessage(text);
  };

  return (
    <UnifiedChatView
      name="cyboflow agent"
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
          {/* S1.3 mounts the ProposalCard list here, keyed off
              useAgentThreadStore(s => s.proposals) — deliberately out of scope
              for S1.2 (see docs/proposals/GLOBAL-AGENT-PLAN.md §3 S1.3). */}
          <AgentSuggestionChips onSend={handleSend} disabled={sending} />
          <AgentComposer
            onSend={handleSend}
            disabled={sending || thread === null}
            model={thread?.model ?? null}
          />
        </div>
      }
    />
  );
}
