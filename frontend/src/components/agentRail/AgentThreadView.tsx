/**
 * AgentThreadView — the global-agent thread's transcript, proposal cards, and
 * composer (S1.2 + S1.3), mounted inside AgentRail's body. Renders through the
 * SAME UnifiedChatView the workflow-run and quick-session hosts use (ChatMode
 * 'agent') so the three never visually drift — see
 * docs/proposals/GLOBAL-AGENT-PLAN.md §2.3 / §3 S1.2/S1.3. {@link ProposalCardList}
 * mounts above the suggestion chips/composer, keyed off
 * `useAgentThreadStore(s => s.proposals)`.
 */
import { useEffect, useMemo, useState } from 'react';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import { UnifiedChatView } from '../cyboflow/unified/UnifiedChatView';
import { useUnifiedAgentThreadMessages } from '../cyboflow/unified/useUnifiedAgentThreadMessages';
import { useAgentThreadStore } from '../../stores/agentThreadStore';
import { AgentComposer } from './AgentComposer';
import { AgentSuggestionChips } from './AgentSuggestionChips';
import { clearAssistantGreeting, peekAssistantGreeting } from './onboardingGreeting';
import { ProposalCardList } from './ProposalCardList';

export function AgentThreadView(): React.ReactElement {
  const thread = useAgentThreadStore((s) => s.thread);
  const sending = useAgentThreadStore((s) => s.sending);
  const sendMessage = useAgentThreadStore((s) => s.sendMessage);
  const proposals = useAgentThreadStore((s) => s.proposals);

  const { messages, loadError } = useUnifiedAgentThreadMessages(thread?.id ?? null);

  // One-shot onboarding greeting (see ./onboardingGreeting). Read once in a
  // state initializer — NON-destructively, because StrictMode double-invokes
  // initializers — and cleared by the mount effect below, so it shows on this
  // mount only and never re-appears on a later rail remount. Purely synthetic:
  // no SDK turn, no agent_messages row.
  const [greeting] = useState<string | null>(() => peekAssistantGreeting());
  const [greetingAt] = useState<string>(() => new Date().toISOString());
  useEffect(() => {
    clearAssistantGreeting();
  }, []);

  const messagesWithGreeting = useMemo<UnifiedMessage[]>(() => {
    if (greeting === null) return messages;
    return [
      {
        id: 'onboarding-greeting',
        role: 'assistant',
        timestamp: greetingAt,
        segments: [{ type: 'text', content: greeting }],
      },
      ...messages,
    ];
  }, [greeting, greetingAt, messages]);

  const handleSend = (text: string): void => {
    void sendMessage(text);
  };

  return (
    <UnifiedChatView
      name="cyboflow assistant"
      transport="sdk"
      mode="agent"
      running={sending}
      messages={messagesWithGreeting}
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
