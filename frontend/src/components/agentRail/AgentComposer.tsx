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
import { CornerDownLeft, Paperclip, X } from 'lucide-react';
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
  /** Disabled while a turn is in flight, or before the thread has loaded. */
  disabled: boolean;
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
    if (admitted.length > 0) setImages([...imagesRef.current, ...admitted]);
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

  const submit = useCallback(() => {
    const text = value.trim();
    if (disabled) return;
    if (text.length === 0 && images.length === 0) return;
    // Every held image already passed `isSendableImage` at attach time, so this
    // narrowing cannot drop one; the filter is the type-level proof of that.
    const wire = images
      .map(toAgentThreadImageAttachment)
      .filter((image): image is AgentThreadImageAttachment => image !== null);
    onSend(text, wire.length > 0 ? wire : undefined);
    setValue('');
    setImages([]);
    setAttachError(null);
  }, [value, images, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = !disabled && (value.trim().length > 0 || images.length > 0);

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
      </div>
    </div>
  );
}
