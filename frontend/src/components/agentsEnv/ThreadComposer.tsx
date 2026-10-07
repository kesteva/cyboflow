import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../ui/Button';
import { PERSISTENT_AGENT_MAX_MESSAGE_BYTES } from '../../../../shared/types/persistentAgents';
import type { LocalFailure } from '../../stores/persistentAgentsStore';
import { utf8ByteLength } from './agentsEnvFormat';
import { failureCopy } from './agentsVocabulary';
import type { AgentViewT, SendResult } from './types';

const MAX_ROWS_PX = 8 * 20;

export function ThreadComposer({
  agent,
  onSend,
  onReconnect,
}: {
  agent: AgentViewT;
  onSend: (text: string) => Promise<SendResult | LocalFailure>;
  onReconnect?: (agentId: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ copy: string; reconnect: boolean } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const c = agent.connection;
  const disabledReason = c === null ? 'Not connected' : c.state === 'revoked' ? 'Connection revoked' : null;
  const trimmed = text.trim();
  const bytes = utf8ByteLength(trimmed);
  const tooLong = bytes > PERSISTENT_AGENT_MAX_MESSAGE_BYTES;
  const canSend = disabledReason === null && trimmed !== '' && !tooLong && !sending;
  const kb = Math.ceil(bytes / 1024);
  const maxKb = Math.round(PERSISTENT_AGENT_MAX_MESSAGE_BYTES / 1024);
  const showCounter = tooLong || bytes > PERSISTENT_AGENT_MAX_MESSAGE_BYTES * 0.9;

  const grow = (): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  };

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    setSending(true);
    setFailure(null);
    try {
      const res = await onSend(trimmed);
      if (res.ok) {
        setText('');
        requestAnimationFrame(grow);
      } else {
        setFailure({
          copy: failureCopy(res).copy,
          reconnect: res.error === 'connection_revoked' && c?.kind === 'bridge',
        });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border-primary bg-bg-secondary px-7 py-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          data-testid="thread-composer-input"
          aria-label="Message"
          rows={1}
          value={text}
          disabled={disabledReason !== null}
          placeholder={disabledReason ?? `Message ${agent.displayName}…`}
          onChange={(e) => {
            setText(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={(e) => {
            // Attachments are out of scope: an image on the clipboard is ignored, never inlined.
            if (Array.from(e.clipboardData?.files ?? []).length > 0) e.preventDefault();
          }}
          className="min-h-[34px] flex-1 resize-none border border-border-primary bg-surface-primary px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive disabled:opacity-60"
        />
        <Button
          variant="primary"
          size="sm"
          icon={<Send className="h-3 w-3" />}
          data-testid="thread-send"
          loading={sending}
          disabled={!canSend}
          onClick={() => void submit()}
        >
          Send
        </Button>
      </div>
      {showCounter && (
        <p
          data-testid="thread-composer-counter"
          className={`mt-1 text-[11px] ${tooLong ? 'text-status-error' : 'text-text-tertiary'}`}
        >
          {tooLong ? `Too long (${kb} KB of ${maxKb} KB)` : `${kb} KB of ${maxKb} KB`}
        </p>
      )}
      {failure !== null && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-status-error">
          <span>{failure.copy}</span>
          {failure.reconnect && onReconnect && (
            <Button variant="ghost" size="sm" onClick={() => onReconnect(agent.id)}>
              Reconnect…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
