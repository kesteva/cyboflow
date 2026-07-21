/**
 * AgentComposer — the agent rail's composer strip (S1.2).
 *
 * Rust `▸` glyph + an auto-growing textarea (Cmd/Ctrl+Enter to send, mirroring
 * UnifiedComposer's keybinding — frontend/src/components/cyboflow/unified/UnifiedComposer.tsx)
 * + a read-only model chip. Deliberately its own small component rather than a
 * UnifiedComposer/resolveChatVisibility instantiation: the agent thread has none
 * of UnifiedComposer's session-config surface (attachments, permission mode,
 * checkpoint, fast mode) — this stays visually consistent with the other
 * composers (border/mono-text/uppercase-button conventions, italic placeholder
 * per the design packet) without inheriting that machinery.
 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownLeft } from 'lucide-react';

export interface AgentComposerProps {
  /** Send the trimmed text. Never called with an empty string. */
  onSend: (text: string) => void;
  /** Disabled while a turn is in flight, or before the thread has loaded. */
  disabled: boolean;
  /** thread.model (null ⇒ ConfigManager default — shown as "default"). */
  model: string | null;
}

const PLACEHOLDER = 'Ask, or run /plan /approve /triage…';

/** Auto-grow cap: 4 lines at the textarea's `leading-4` (16px) line height,
 * plus the textarea's own vertical padding (none). */
const COMPOSER_MAX_LINES = 4;
const COMPOSER_LINE_HEIGHT_PX = 16;
const COMPOSER_MAX_PX = COMPOSER_MAX_LINES * COMPOSER_LINE_HEIGHT_PX;

export function AgentComposer({ onSend, disabled, model }: AgentComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to COMPOSER_MAX_PX (4 lines), then scroll — re-measured on
  // every value change so the box also shrinks back after a send clears it.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Empty value → clear the inline height entirely so the box rests at its
    // CSS single-line baseline. An empty textarea's scrollHeight is unreliable
    // (it can report the previous rendered height, e.g. the 4-line cap on
    // mount), so measuring it would wedge the empty composer tall.
    if (value.length === 0) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [value]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (text.length === 0 || disabled) return;
    onSend(text);
    setValue('');
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div
      data-testid="agent-composer"
      className="flex items-end gap-2 border border-border-primary bg-bg-tertiary px-2 py-1.5"
    >
      <span aria-hidden="true" className="pb-0.5 text-interactive">
        &#9656;
      </span>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder={PLACEHOLDER}
        data-testid="agent-composer-input"
        className="max-h-16 min-h-[18px] flex-1 resize-none overflow-y-auto bg-transparent text-[11px] leading-4 text-text-primary outline-none placeholder:italic placeholder:text-text-tertiary disabled:cursor-not-allowed"
      />
      <span
        data-testid="agent-composer-model-chip"
        title="Model — session config"
        className="shrink-0 border border-border-primary px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-text-tertiary"
      >
        {model ?? 'default'}
      </span>
      <button
        type="button"
        onClick={submit}
        disabled={!canSend}
        data-testid="agent-composer-send"
        aria-label="Send"
        title="Send (⌘⏎)"
        className={
          canSend
            ? 'shrink-0 border border-interactive bg-interactive px-1.5 py-1 text-[color:var(--color-text-on-interactive)] transition-[filter] hover:brightness-110'
            : 'shrink-0 cursor-not-allowed border border-border-primary px-1.5 py-1 text-text-disabled opacity-50'
        }
      >
        <CornerDownLeft className="h-3 w-3" />
      </button>
    </div>
  );
}
