/**
 * LiveTail — transient progressive-render surface for an in-flight assistant
 * message. Renders the not-yet-settled `text`/`thinking` blocks produced by
 * `liveTailReducer.reduceLiveTail`, styled like a normal (but ephemeral)
 * assistant message so it reads as "the message is being typed", not as a
 * separate UI element.
 *
 * This component is purely presentational — it takes the ALREADY-REDUCED
 * `LiveTailBlock[]` (not raw StreamEvents); the host (RunChatView /
 * ClaudePanel) is responsible for calling `reduceLiveTail` and only rendering
 * `<LiveTail />` when `activeBlocks.length > 0` — see ChatTranscript.tsx's
 * `liveTail?: ReactNode` prop, which falls back to
 * ThinkingPlaceholder/InlineWorkingIndicator whenever the host passes nothing.
 *
 * Reuses the SAME `MessageSegment` renderer the settled transcript uses for
 * `text`/`thinking` segments, so markdown, thinking-rail styling, and
 * light/dark theming stay byte-for-byte identical to the final message once it
 * lands (no bespoke styling to invent or drift).
 */
import React from 'react';
import { Bot } from 'lucide-react';
import { MessageSegment } from '../panels/ai/components/MessageSegment';
import type { LiveTailBlock } from '../../utils/liveTailReducer';

const NOOP_EXPANDED_TOOLS = new Set<string>();
function noopToggleToolExpand(): void {
  // Live-tail blocks are never tool_call segments — MessageSegment requires
  // the handler prop, but it is unreachable here.
}

export interface LiveTailProps {
  blocks: LiveTailBlock[];
  /** Display name for the assistant role, matching ChatTranscript's agentName. */
  agentName?: string;
}

export const LiveTail: React.FC<LiveTailProps> = ({ blocks, agentName = 'Claude' }) => {
  if (blocks.length === 0) return null;

  const hasThinking = blocks.some((b) => b.kind === 'thinking');

  return (
    <div
      data-testid="live-tail"
      className={`rounded-lg transition-all relative group p-4 ${
        hasThinking ? 'bg-surface-primary/50' : 'bg-surface-primary'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className="rounded-full p-1.5 flex-shrink-0 bg-interactive/20 text-interactive-on-dark">
          <Bot className="w-4 h-4" />
        </div>
        <div className="flex-1 flex items-baseline gap-2">
          <span className="font-medium text-text-primary text-sm">{agentName}</span>
        </div>
      </div>

      <div className="ml-7 space-y-2">
        {blocks.map((block) => (
          <MessageSegment
            key={`live-tail-${block.index}`}
            segment={{ type: block.kind, content: block.text }}
            messageId="live-tail"
            index={block.index}
            isUser={false}
            expandedTools={NOOP_EXPANDED_TOOLS}
            collapseTools={false}
            showToolCalls={false}
            showThinking
            onToggleToolExpand={noopToggleToolExpand}
          />
        ))}
      </div>
    </div>
  );
};
