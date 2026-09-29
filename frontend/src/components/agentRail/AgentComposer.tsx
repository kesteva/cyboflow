/**
 * AgentComposer — the agent rail's composer strip (S1.2).
 *
 * Rust `▸` glyph + an auto-growing textarea (Cmd/Ctrl+Enter to send, mirroring
 * UnifiedComposer's keybinding — frontend/src/components/cyboflow/unified/UnifiedComposer.tsx)
 * + a read-only model chip. Deliberately its own small component rather than a
 * UnifiedComposer/resolveChatVisibility instantiation: the agent thread has none
 * of UnifiedComposer's session-config surface (permission mode, checkpoint, fast
 * mode) — this stays visually consistent with the other composers
 * (border/mono-text/uppercase-button conventions, italic placeholder per the
 * design packet) without inheriting that machinery.
 *
 * IMAGE ATTACHMENTS are the one piece of that surface it DOES carry, and they
 * work differently here. UnifiedComposer's images are persisted to disk and
 * cited by path, because the session agent can `Read` them. The assistant runs
 * with `tools: []`, so its images must reach the model as real content blocks —
 * this composer therefore hands `onSend` wire-shaped
 * {@link AgentThreadImageAttachment}s (base64, no data-URL prefix) rather than
 * the raw {@link AttachedImage} it holds internally. Unsupported types are
 * refused at ATTACH time, so nobody sends a turn believing a picture went with it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { CornerDownLeft, Paperclip, Square, X } from 'lucide-react';
import { kbdHint } from '../../utils/platform';
import {
  AGENT_THREAD_IMAGE_LIMITS,
  type AgentThreadImageAttachment,
} from '../../../../shared/types/agentThread';
import { processImageFile, type AttachedImage } from '../cyboflow/unified/attachments';
import { isSendableImage, toAgentThreadImageAttachment } from './agentImageAttachments';

export interface AgentComposerProps {
  /**
   * Send the trimmed text plus this turn's image attachments. Called with an
   * empty string ONLY when at least one image is attached (an image-only turn);
   * `images` is omitted entirely when nothing is attached, so a text-only caller
   * (e.g. AgentSuggestionChips) can keep a one-argument handler.
   */
  onSend: (text: string, images?: AgentThreadImageAttachment[]) => void;
  /** Disabled before the thread has loaded (there is nothing to send to yet).
   *  A turn IN FLIGHT is `sending`, not `disabled` — the composer stays
   *  typeable/focusable then so Esc can reach it (see `sending`). */
  disabled: boolean;
  /**
   * True while a turn is in flight (TASK-297's Stop control). The send glyph
   * becomes Stop; `Esc` while focused also stops. Omit (or `false`) for a
   * host with no interrupt seam yet — the composer then behaves exactly as
   * before `sending` existed.
   */
  sending?: boolean;
  /** Called by the Stop button / Esc while `sending`. Required when `sending` can be true. */
  onStop?: () => void;
  /**
   * TASK-301: buffer the draft as the next turn (delivered the instant the
   * in-flight turn lands). Shown as a "Queue" button alongside Stop ONLY while
   * `sending` AND there is a draft (text or an image) — omitted elsewhere, so a
   * host with no queue seam keeps today's Stop-only behavior. Also reachable via
   * plain ⌘/Ctrl+Enter while sending (mirrors UnifiedComposer: the same
   * keybinding sends when idle, queues when running).
   */
  onQueue?: (text: string, images?: AgentThreadImageAttachment[]) => void;
  /**
   * TASK-301: abort the in-flight turn and drive this draft as a fresh turn
   * NOW. Shown as a second, visually distinct button next to Queue (same
   * `sending && hasDraft` gate); reachable via ⌘/Ctrl+Shift+Enter, matching
   * UnifiedComposer's binding.
   */
  onInterruptSend?: (text: string, images?: AgentThreadImageAttachment[]) => void;
  /**
   * True while a turn has been buffered via `onQueue` and is waiting for the
   * in-flight turn to land. Renders a small inline "Queued" notice with a
   * cancel affordance (`onCancelQueued`); the draft/attachments that were
   * queued live in the HOST's state (agentThreadStore), not here — this
   * component only reflects the flag.
   */
  queued?: boolean;
  /** Called by the queued notice's cancel control. Required when `queued` can be true. */
  onCancelQueued?: () => void;
  /** Overrides the default placeholder (e.g. the onboarding guided host's
   *  follow-up prompt). Defaults to {@link PLACEHOLDER}. */
  placeholder?: string;
  /**
   * One-shot external pre-fill (Custom Views §7.1's authoring kickoff —
   * `agentThreadStore.composerDraft`). Applied to the internal draft the
   * instant it changes to a non-empty string, then immediately reported back
   * via `onPrefillConsumed` so the caller can clear its source — `null`/
   * `undefined`/empty is "nothing pending" and is never applied.
   */
  prefill?: string | null;
  /** Called right after `prefill` is applied, so the caller can clear it (one-shot; omitted if `prefill` is never used). */
  onPrefillConsumed?: () => void;
}

const PLACEHOLDER = 'Ask, or run /plan /approve /triage…';

/** Shown inline when an attach is refused; cleared by the next successful attach. */
const UNSUPPORTED_IMAGE_MESSAGE = 'Only PNG, JPEG, GIF, and WebP images can be attached.';
const TOO_MANY_IMAGES_MESSAGE = `At most ${AGENT_THREAD_IMAGE_LIMITS.maxImages} images per message.`;
const TOO_LARGE_IMAGE_MESSAGE = 'That image is too large (5 MB max).';

/** Auto-grow cap: 4 lines at the textarea's `leading-4` (16px) line height,
 * plus the textarea's own vertical padding (none). */
const COMPOSER_MAX_LINES = 4;
const COMPOSER_LINE_HEIGHT_PX = 16;
const COMPOSER_MAX_PX = COMPOSER_MAX_LINES * COMPOSER_LINE_HEIGHT_PX;

export function AgentComposer({
  onSend,
  disabled,
  sending = false,
  onStop,
  onQueue,
  onInterruptSend,
  queued = false,
  onCancelQueued,
  placeholder = PLACEHOLDER,
  prefill,
  onPrefillConsumed,
}: AgentComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Read-only mirror of `images`, so the async attach path below sees the live
   *  list rather than the closure it was created with (two fast pastes). */
  const imagesRef = useRef<AttachedImage[]>(images);
  imagesRef.current = images;

  // Apply an external pre-fill once, then report it consumed so the caller
  // clears its source — the next render's `prefill` goes back to falsy and
  // this effect will not refire until something sets a new one.
  useEffect(() => {
    if (prefill === null || prefill === undefined || prefill.length === 0) return;
    setValue(prefill);
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

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

  /**
   * Narrow + admit a batch of files. Every rejection reason is reported inline
   * (`processImageFile` returns null for a non-image or an oversized file; the
   * media-type check catches SVG/HEIC/BMP, which ARE images but not content
   * blocks), and the per-turn cap is applied against the live list so a paste of
   * six screenshots keeps the first four rather than dropping all six.
   */
  const addImages = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const accepted: AttachedImage[] = [];
    let error: string | null = null;
    for (const file of files) {
      const processed = await processImageFile(file);
      if (processed === null) {
        error = file.type.startsWith('image/') ? TOO_LARGE_IMAGE_MESSAGE : UNSUPPORTED_IMAGE_MESSAGE;
        continue;
      }
      if (!isSendableImage(processed)) {
        error = UNSUPPORTED_IMAGE_MESSAGE;
        continue;
      }
      accepted.push(processed);
    }
    const room = Math.max(0, AGENT_THREAD_IMAGE_LIMITS.maxImages - imagesRef.current.length);
    const admitted = accepted.slice(0, room);
    if (admitted.length < accepted.length) error = TOO_MANY_IMAGES_MESSAGE;
    if (admitted.length > 0) {
      // Advance the mirror HERE, not on the next render: two pastes whose
      // `processImageFile` awaits resolve back-to-back both run this section
      // before React re-renders, and the second must see the first's admits or
      // the cap is applied against a stale count.
      const next = [...imagesRef.current, ...admitted];
      imagesRef.current = next;
      setImages(next);
    }
    setAttachError(error);
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>): void => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      // Only preventDefault once an image is actually in the clipboard, so a
      // normal text paste is untouched.
      e.preventDefault();
      void addImages(files);
    },
    [addImages],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void addImages(files);
    },
    [addImages],
  );

  const handleFilePick = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      void addImages(Array.from(e.target.files ?? []));
      // Reset so re-picking the SAME file fires `change` again.
      e.target.value = '';
    },
    [addImages],
  );

  const removeImage = useCallback((id: string): void => {
    setImages((current) => current.filter((image) => image.id !== id));
    setAttachError(null);
  }, []);

  const hasDraft = value.trim().length > 0 || images.length > 0;

  /**
   * Shared dispatch: trim + convert attachments to their wire shape, hand them
   * to `handler`, then clear the draft. Used by `onSend` (idle), `onQueue`, and
   * `onInterruptSend` alike — they differ only in which handler receives the
   * text/images and which guard gates them (see the three thin wrappers below).
   */
  const dispatch = useCallback(
    (handler: (text: string, images?: AgentThreadImageAttachment[]) => void) => {
      const text = value.trim();
      // Every held image already passed `isSendableImage` at attach time, so this
      // narrowing cannot drop one; the filter is the type-level proof of that.
      const wire = images
        .map(toAgentThreadImageAttachment)
        .filter((image): image is AgentThreadImageAttachment => image !== null);
      handler(text, wire.length > 0 ? wire : undefined);
      setValue('');
      setImages([]);
      setAttachError(null);
    },
    [value, images],
  );

  const submit = useCallback(() => {
    if (disabled || sending || !hasDraft) return;
    dispatch(onSend);
  }, [disabled, sending, hasDraft, dispatch, onSend]);

  const queueDraft = useCallback(() => {
    if (disabled || !hasDraft || !onQueue) return;
    dispatch(onQueue);
  }, [disabled, hasDraft, onQueue, dispatch]);

  const interruptSendDraft = useCallback(() => {
    if (disabled || !hasDraft || !onInterruptSend) return;
    dispatch(onInterruptSend);
  }, [disabled, hasDraft, onInterruptSend, dispatch]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && sending) {
      e.preventDefault();
      onStop?.();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // ⌘⇧↵ while sending → interrupt & send (when offered); plain ⌘↵ while
      // sending → queue (when offered) — matches UnifiedComposer's binding
      // (the same keystroke sends when idle, queues when running).
      if (sending && e.shiftKey && onInterruptSend) {
        interruptSendDraft();
        return;
      }
      if (sending && onQueue) {
        queueDraft();
        return;
      }
      submit();
    }
  };

  const canSend = !disabled && !sending && hasDraft;
  const canQueueOrInterrupt = !disabled && hasDraft;

  return (
    // The thumbnail strip and the inline error sit ABOVE the input row inside the
    // same bordered box, so the row itself (glyph / textarea / send) keeps the
    // `items-end` + `self-stretch` geometry the send button's height depends on.
    <div
      data-testid="agent-composer"
      className="flex flex-col gap-1.5 border border-border-primary bg-bg-tertiary px-2 py-1.5"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {images.length > 0 && (
        <div data-testid="agent-composer-attachments" className="flex flex-wrap gap-1.5">
          {images.map((image) => (
            <div
              key={image.id}
              data-testid={`agent-composer-attachment-${image.id}`}
              className="relative h-10 w-10 shrink-0 overflow-hidden border border-border-primary"
            >
              <img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(image.id)}
                aria-label={`Remove ${image.name}`}
                className="absolute right-0 top-0 bg-bg-tertiary/90 p-0.5 text-text-secondary hover:text-text-primary"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError !== null && (
        <p data-testid="agent-composer-attach-error" className="text-[10px] text-status-error">
          {attachError}
        </p>
      )}
      <div className="flex items-end gap-2">
        <span aria-hidden="true" className="pb-0.5 text-interactive">
          &#9656;
        </span>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          data-testid="agent-composer-input"
          className="max-h-16 min-h-[18px] flex-1 resize-none overflow-y-auto bg-transparent text-[11px] leading-4 text-text-primary outline-none placeholder:italic placeholder:text-text-tertiary disabled:cursor-not-allowed"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFilePick}
          data-testid="agent-composer-file-input"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          data-testid="agent-composer-attach"
          aria-label="Attach images"
          title="Attach images"
          className="flex shrink-0 items-center justify-center pb-0.5 text-text-tertiary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Paperclip className="h-3 w-3" />
        </button>
        {sending ? (
          <>
            {/* TASK-301: Queue + Interrupt & send join Stop ONLY once a draft
                exists — an empty composer mid-turn keeps today's Stop-only
                affordance. Queue is the default, non-destructive action; the
                filled Interrupt & send button is visually distinct from the
                outlined Stop, mirroring UnifiedComposer's trio. */}
            {hasDraft && onQueue && (
              <button
                type="button"
                onClick={queueDraft}
                disabled={!canQueueOrInterrupt}
                data-testid="agent-composer-queue"
                aria-label="Queue"
                title={`Queue — sends once the current turn finishes (${kbdHint('mod', 'Enter')})`}
                className="flex shrink-0 items-center justify-center self-stretch border border-interactive bg-interactive px-1.5 text-[color:var(--color-text-on-interactive)] transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CornerDownLeft className="h-3 w-3" />
              </button>
            )}
            {hasDraft && onInterruptSend && (
              <button
                type="button"
                onClick={interruptSendDraft}
                disabled={!canQueueOrInterrupt}
                data-testid="agent-composer-interrupt-send"
                aria-label="Interrupt & send"
                title={`Stop the agent and send this now (${kbdHint('modShift', 'Enter')})`}
                className="flex shrink-0 items-center justify-center self-stretch border border-status-error bg-status-error px-1.5 text-[color:var(--color-text-on-interactive)] transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Square className="h-3 w-3" fill="currentColor" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onStop?.()}
              data-testid="agent-composer-stop"
              aria-label="Stop"
              title="Stop (Esc)"
              className="flex shrink-0 items-center justify-center self-stretch border border-status-error bg-status-error/10 px-1.5 text-status-error transition-colors hover:bg-status-error/20"
            >
              <Square className="h-3 w-3" fill="currentColor" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            data-testid="agent-composer-send"
            aria-label="Send"
            title={`Send (${kbdHint('mod', 'Enter')})`}
            className={
              // `self-stretch` makes the button's height track the composer's content
              // box — i.e. the auto-growing textarea — so it grows line-for-line with
              // the text while its width stays fixed (px-1.5). The icon is centered.
              canSend
                ? 'flex shrink-0 items-center justify-center self-stretch border border-interactive bg-interactive px-1.5 text-[color:var(--color-text-on-interactive)] transition-[filter] hover:brightness-110'
                : 'flex shrink-0 cursor-not-allowed items-center justify-center self-stretch border border-border-primary px-1.5 text-text-disabled opacity-50'
            }
          >
            <CornerDownLeft className="h-3 w-3" />
          </button>
        )}
      </div>
      {queued && (
        <p data-testid="agent-composer-queued" className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
          Queued — sends once the current turn finishes.
          <button
            type="button"
            onClick={() => onCancelQueued?.()}
            data-testid="agent-composer-queued-cancel"
            className="font-bold uppercase tracking-[0.08em] text-interactive hover:underline"
          >
            Cancel
          </button>
        </p>
      )}
    </div>
  );
}
