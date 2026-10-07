import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { EmptyStrip, GhostButton } from '../landing/QueuePrimitives';
import { useNow } from '../../hooks/useNow';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { AgentMessageBubble } from './AgentMessageBubble';
import { ThreadBanner } from './ThreadBanner';
import { ThreadComposer } from './ThreadComposer';
import { ThreadHeader } from './ThreadHeader';

const NEAR_BOTTOM_PX = 80;

export function PersistentAgentThreadView({
  agentId,
  onBack,
  onOpenPairing,
  onReconnect,
}: {
  agentId: string;
  onBack: () => void;
  onOpenPairing: (agentId: string) => void;
  onReconnect: (agentId: string) => void;
}): React.JSX.Element | null {
  const agent = usePersistentAgentsStore((s) => s.agents.find((a) => a.id === agentId) ?? null);
  const thread = usePersistentAgentsStore((s) => s.threads[agentId]);
  const openThread = usePersistentAgentsStore((s) => s.openThread);
  const loadEarlier = usePersistentAgentsStore((s) => s.loadEarlier);
  const send = usePersistentAgentsStore((s) => s.send);
  const markRead = usePersistentAgentsStore((s) => s.markRead);
  const now = useNow(30_000);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => openThread(agentId), [openThread, agentId, reloadKey]);

  const messages = thread?.messages ?? [];
  let latestInboundId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'in') {
      latestInboundId = messages[i].id;
      break;
    }
  }

  // Mark read while the window is visible: on mount (clears a stale count), whenever a newer inbound
  // message lands, and when the window becomes visible again.
  useEffect(() => {
    const mark = (): void => {
      if (document.visibilityState === 'visible') markRead(agentId);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [agentId, latestInboundId, markRead]);

  // Scroll: stick to the bottom for new messages while the reader is near it; keep the viewport still when
  // earlier messages are prepended.
  const listRef = useRef<HTMLDivElement>(null);
  const prev = useRef<{ height: number; nearBottom: boolean; firstId: string | null; lastId: string | null } | null>(null);
  const onScroll = useCallback((): void => {
    const el = listRef.current;
    if (!el || prev.current === null) return;
    prev.current.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);
  const firstId = messages[0]?.id ?? null;
  const lastId = messages[messages.length - 1]?.id ?? null;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const p = prev.current;
    if (p === null) {
      el.scrollTop = el.scrollHeight;
    } else if (p.firstId !== firstId && p.lastId === lastId) {
      el.scrollTop += el.scrollHeight - p.height;
    } else if (p.nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
    prev.current = {
      height: el.scrollHeight,
      nearBottom: p === null ? true : el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX,
      firstId,
      lastId,
    };
  }, [firstId, lastId, messages.length, thread?.status]);

  if (agent === null) return null;

  const status = thread?.status ?? 'loading';
  const isBridge = agent.connection?.kind === 'bridge';

  return (
    <div className="flex h-full flex-col">
      <ThreadHeader agent={agent} onBack={onBack} onOpenPairing={onOpenPairing} onReconnect={onReconnect} />
      <ThreadBanner agent={agent} onOpenPairing={onOpenPairing} onReconnect={onReconnect} />
      <div
        ref={listRef}
        onScroll={onScroll}
        data-testid="persistent-agent-thread"
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-7 py-4"
      >
        {thread?.hasMore === true && (
          <div className="flex justify-center">
            <GhostButton
              data-testid="thread-load-earlier"
              disabled={thread.loadingEarlier}
              onClick={() => void loadEarlier(agentId)}
            >
              {thread.loadingEarlier ? 'Loading…' : 'Load earlier messages'}
            </GhostButton>
          </div>
        )}
        {status === 'loading' && messages.length === 0 && (
          <div className="flex justify-center py-6 text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading messages" />
          </div>
        )}
        {status === 'error' && messages.length === 0 && (
          <div role="alert" className="flex flex-col items-start gap-2 text-[12px] text-status-error">
            <span>{thread?.error ?? 'Could not load this thread.'}</span>
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </Button>
          </div>
        )}
        {status === 'ready' && messages.length === 0 && (
          <EmptyStrip testId="thread-empty">
            {isBridge
              ? `No messages yet. Say hello — it reaches ${agent.displayName} the next time it checks in.`
              : 'No messages yet.'}
          </EmptyStrip>
        )}
        {messages.map((m) => (
          <AgentMessageBubble
            key={m.id}
            message={m}
            agentName={agent.displayName}
            connectionState={agent.connection?.state ?? null}
            now={now}
          />
        ))}
      </div>
      <ThreadComposer agent={agent} onSend={(text) => send(agentId, text)} onReconnect={onReconnect} />
    </div>
  );
}
