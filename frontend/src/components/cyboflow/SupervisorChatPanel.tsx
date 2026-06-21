/**
 * SupervisorChatPanel — the Stage 3 human seam UI. Lets the user converse with the
 * long-lived SUPERVISOR of a programmatic run: the supervisor monitors the
 * host-driven walk (system notes) and answers questions; the user types to it.
 *
 * Wiring (vanilla tRPC proxy client, mirroring dynamicWorkflowStore):
 *   - seed:    trpc.cyboflow.supervisorChat.getTranscript.query({ runId })
 *   - live:    trpc.cyboflow.supervisorChat.onMessage.subscribe({ runId }) — each
 *              delta merged via mergeChatMessage (assistant replies grow in place)
 *   - send:    trpc.cyboflow.supervisorChat.send.mutate({ runId, text })
 *
 * The user's own message echoes back through the subscription (the session appends
 * + emits it), so there is no optimistic local insert. When no chat session is
 * active for the run (default review-queue supervisor, or a terminal run), the
 * seed is empty and `send` is a no-op — the panel shows an idle hint.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { mergeChatMessage, seedTranscript, type ChatMessage } from '../../utils/supervisorChatTranscript';

interface SupervisorChatPanelProps {
  runId: string;
}

export function SupervisorChatPanel({ runId }: SupervisorChatPanelProps): ReactElement {
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setTranscript([]);

    void trpc.cyboflow.supervisorChat.getTranscript
      .query({ runId })
      .then((messages) => {
        if (active) setTranscript(seedTranscript(messages));
      })
      .catch((err: unknown) => console.warn('[SupervisorChatPanel] getTranscript failed:', err));

    // Payload type inferred from AppRouter (repo rule — no local mirror).
    const sub = trpc.cyboflow.supervisorChat.onMessage.subscribe(
      { runId },
      {
        onData: (event) => {
          if (active) setTranscript((t) => mergeChatMessage(t, event.message));
        },
        onError: (err: unknown) => console.warn('[SupervisorChatPanel] onMessage error:', err),
      },
    );

    return () => {
      active = false;
      sub.unsubscribe();
    };
  }, [runId]);

  // Keep the view pinned to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [transcript]);

  const handleSend = async (): Promise<void> => {
    const text = input.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setInput('');
    try {
      await trpc.cyboflow.supervisorChat.send.mutate({ runId, text });
    } catch (err: unknown) {
      console.warn('[SupervisorChatPanel] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="supervisor-chat-panel">
      {/* No header here — the dock's collapse bar labels the panel. */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm">
        {transcript.length === 0 ? (
          <div className="text-[var(--color-text-secondary)]">
            No supervisor conversation yet. The supervisor watches this run; ask it what's happening.
          </div>
        ) : (
          transcript.map((msg, i) => <ChatRow key={`${msg.role}-${msg.ts}-${i}`} msg={msg} />)
        )}
      </div>

      <div className="border-t border-[var(--color-border-primary)] p-2">
        <textarea
          className="w-full resize-none rounded border border-[var(--color-border-primary)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm focus:outline-none"
          rows={2}
          placeholder="Ask the supervisor…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] text-[var(--color-text-secondary)]">⌘↵ to send</span>
          <button
            className="rounded bg-[var(--color-interactive)] px-3 py-1 text-xs font-medium text-[var(--color-text-on-interactive)] disabled:opacity-50"
            disabled={sending || input.trim().length === 0}
            onClick={() => void handleSend()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatRow({ msg }: { msg: ChatMessage }): ReactElement {
  if (msg.role === 'system') {
    return <div className="text-[11px] italic text-[var(--color-text-secondary)]">{msg.text}</div>;
  }
  const isUser = msg.role === 'user';
  return (
    <div className={isUser ? 'text-right' : 'text-left'}>
      <span
        className={
          'inline-block max-w-[85%] whitespace-pre-wrap rounded px-2 py-1 text-left ' +
          (isUser
            ? 'bg-[var(--color-interactive)] text-[var(--color-text-on-interactive)]'
            : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]')
        }
      >
        {msg.text}
      </span>
    </div>
  );
}
