/**
 * AgentThreadView — the global-agent thread's transcript, proposal cards, and
 * composer (S1.2 + S1.3), mounted inside AgentRail's body. Renders through the
 * SAME UnifiedChatView the workflow-run and quick-session hosts use (ChatMode
 * 'agent') so the three never visually drift — see
 * docs/proposals/GLOBAL-AGENT-PLAN.md §2.3 / §3 S1.2/S1.3. {@link ProposalCardList}
 * mounts above the suggestion chips/composer, keyed off
 * `useAgentThreadStore(s => s.proposals)`.
 *
 * `variant="guided"` hosts the SAME thread inside the onboarding tour's
 * guided column (step 11, IdeaProposalsStep). That mount predates the rail's
 * first mount, so it must neither peek nor clear the one-shot onboarding
 * greeting (that belongs to the rail) and drops the suggestion chips in
 * favour of a caller-supplied composer placeholder.
 */
import { useEffect, useMemo, useState } from 'react';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import type { AgentThreadImageAttachment } from '../../../../shared/types/agentThread';
import { UnifiedChatView } from '../cyboflow/unified/UnifiedChatView';
import { GUIDED_TARGETS } from '../onboarding/guided/GuidedLeader';
import { useUnifiedAgentThreadMessages } from '../cyboflow/unified/useUnifiedAgentThreadMessages';
import { useAgentThreadStore } from '../../stores/agentThreadStore';
import { AgentComposer } from './AgentComposer';
import { AgentSuggestionChips } from './AgentSuggestionChips';
import { clearAssistantGreeting, peekAssistantGreeting } from './onboardingGreeting';
import { ProposalCardList } from './ProposalCardList';
import { LiveTail } from '../chat/LiveTail';
import { reduceLiveTail, hasVisibleTailContent } from '../../utils/liveTailReducer';

export interface AgentThreadViewProps {
  /** 'rail' (default) — the AgentRail host: onboarding greeting + suggestion
   *  chips. 'guided' — the onboarding tour's guided column (step 11): neither,
   *  and no prompt-history rail (the 620px box needs the width for the transcript). */
  variant?: 'rail' | 'guided';
  /** Overrides the composer's default placeholder — used by the guided host. */
  composerPlaceholder?: string;
}

export function AgentThreadView({
  variant = 'rail',
  composerPlaceholder,
}: AgentThreadViewProps = {}): React.ReactElement {
  const thread = useAgentThreadStore((s) => s.thread);
  const sending = useAgentThreadStore((s) => s.sending);
  const sendMessage = useAgentThreadStore((s) => s.sendMessage);
  const proposals = useAgentThreadStore((s) => s.proposals);
  const composerDraft = useAgentThreadStore((s) => s.composerDraft);
  const setComposerDraft = useAgentThreadStore((s) => s.setComposerDraft);
  const liveEvents = useAgentThreadStore((s) => s.liveEvents);

  const { messages, loadError } = useUnifiedAgentThreadMessages(thread?.id ?? null);

  // Progressive-render live tail (Option A — see render-map.md), mirroring
  // RunChatView / ClaudePanel: reconstruct the in-flight assistant message's
  // text/thinking blocks from the store's `liveEvents` buffer. Claude-SDK-only
  // (the `stream_event` producer only exists under
  // main/src/services/panels/claude/) — on codex-sdk runtime `liveEvents` stays
  // empty, `reduceLiveTail` returns no active blocks, and the gate below
  // suppresses the node so ChatTranscript keeps its animated fallback.
  const liveTailState = useMemo(() => reduceLiveTail(liveEvents ?? []), [liveEvents]);
  // Gate on VISIBLE content, not block existence: a block opens empty at
  // content_block_start and an all-empty tail would render a bare "Claude"
  // header while suppressing the animated fallback (blank-bubble bug fixed
  // once already on RunChatView/ClaudePanel — commit b3609f07a).
  const liveTail = hasVisibleTailContent(liveTailState.activeBlocks) ? (
    <LiveTail blocks={liveTailState.activeBlocks} agentName="Claude" />
  ) : undefined;

  // The model actually answering: every projected assistant turn carries the
  // SDK's resolved model id (messageProjection stamps metadata.model), so the
  // last one is the truth. Before any turn has run, the per-thread override
  // (rarely set) or "default" — the ConfigManager alias is not exposed here.
  const activeModel = useMemo((): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && typeof m.metadata?.model === 'string' && m.metadata.model !== '') {
        return m.metadata.model;
      }
    }
    return thread?.model ?? 'default';
  }, [messages, thread?.model]);

  // One-shot onboarding greeting (see ./onboardingGreeting). Read once in a
  // state initializer — NON-destructively, because StrictMode double-invokes
  // initializers — and cleared by the mount effect below, so it shows on this
  // mount only and never re-appears on a later rail remount. Purely synthetic:
  // no SDK turn, no agent_messages row. The guided variant renders before the
  // rail ever mounts, so it must not consume the parked greeting either.
  const [greeting] = useState<string | null>(() =>
    variant === 'guided' ? null : peekAssistantGreeting(),
  );
  const [greetingAt] = useState<string>(() => new Date().toISOString());
  useEffect(() => {
    if (variant === 'guided') return;
    clearAssistantGreeting();
  }, [variant]);

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

  const handleSend = (text: string, images?: AgentThreadImageAttachment[]): void => {
    void sendMessage(text, images !== undefined && images.length > 0 ? { images } : undefined);
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
      liveTail={liveTail}
      folderLabel={null}
      branchName={null}
      contextUsage={null}
      railId={thread?.id ?? 'agent'}
      hidePromptRail={variant === 'guided'}
      bottomSlot={
        <div
          className="flex flex-col gap-2 border-t border-border-primary p-3"
          data-guided-target={variant === 'rail' ? GUIDED_TARGETS.assistantComposer : undefined}
        >
          <ProposalCardList proposals={proposals} />
          {variant === 'rail' && <AgentSuggestionChips onSend={handleSend} disabled={sending} />}
          <AgentComposer
            onSend={handleSend}
            disabled={sending || thread === null}
            placeholder={composerPlaceholder}
            prefill={composerDraft}
            onPrefillConsumed={() => setComposerDraft(null)}
          />
          <div
            data-testid="agent-model-badge"
            title="The model running this assistant (from its last turn; change it under Settings → Assistant)"
            className="text-right text-[9px] uppercase tracking-[0.1em] text-text-tertiary"
          >
            model · {activeModel}
          </div>
        </div>
      }
    />
  );
}
