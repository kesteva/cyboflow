import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Paperclip, Square, Lock, X, FileText, CornerDownLeft } from 'lucide-react';
import FilePathAutocomplete from '../../FilePathAutocomplete';
import { cn } from '../../../utils/cn';
import type { ChatVisibility } from './useChatVisibility';
import {
  type AttachedImage,
  type ComposerAttachments,
  emptyAttachments,
  hasAttachments,
  processImageFile,
  makeTextAttachment,
  LARGE_TEXT_THRESHOLD,
} from './attachments';

/**
 * UnifiedComposer — the single, paper-aesthetic chat composer that replaces the
 * three divergent inputs (ChatInput, InteractiveSessionComposer, and the
 * Crystal-era ClaudeInputWithImages body).
 *
 * It is CONTROLLED: the host owns the draft text (`value`/`onChange`/
 * `textareaRef`) and the substrate-specific send (`onSubmit`/`onStop`). The
 * composer owns its own attachments + UI chrome, gated entirely by the
 * `visibility` record from useChatVisibility.
 *
 * Deliberate v1 deviations from the design packet (flagged):
 *  - model/effort render READ-ONLY (session config; mid-turn editing deferred).
 *  - the PTY inline thinking/tools segmented toggle is OMITTED — it cannot
 *    filter a raw xterm byte stream, so it would be a no-op control.
 */
export interface UnifiedComposerProps {
  /** the resolved visibility matrix. */
  visibility: ChatVisibility;
  /** agent is actively producing output → primary button becomes Stop. */
  running: boolean;

  /** controlled draft text (host-owned). */
  value: string;
  onChange: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** session id for @-file autocomplete (SDK only). */
  sessionId?: string;
  placeholder: string;

  /** disable the input + send (e.g. a flow run that isn't nudgeable). */
  disabled?: boolean;
  disabledHint?: string;

  /** primary action label when idle: 'Send' (quick) | 'Queue' (flow). */
  primaryLabel?: string;
  /** send handler; receives the composer-owned attachments. */
  onSubmit: (atts: ComposerAttachments) => void | Promise<void>;
  /** stop handler, shown as the primary button while running. */
  onStop?: () => void;
  /** external send-in-flight flag (host may also track its own). */
  sending?: boolean;
  sendError?: string | null;

  /** ⌃G reveal toggle (PTY); when omitted the hint bar shows no button. */
  onTogglePtyOpen?: () => void;

  /** SDK quick only — image/large-text attach is wired to the SDK send path. */
  supportsAttachments?: boolean;
  /** read-only model label (e.g. "Sonnet 4.5"), SDK only. Used only when
   *  `modelSlot` is absent (e.g. a flow run, or a running quick turn). */
  modelLabel?: string | null;
  /** interactive model selector (quick SDK, idle) — host supplies the node;
   *  when present it replaces the read-only model pill. */
  modelSlot?: React.ReactNode;
  /** interactive permission-mode selector (quick SDK) — host supplies the node;
   *  rendered next to the model affordance. */
  permissionSlot?: React.ReactNode;
  /** read-only effort label (e.g. "ultracode"). Shown whenever set, independent
   *  of substrate — cyboflow's only effort value is the interactive-only
   *  'ultracode', so it must not be gated on the SDK-only model affordance. */
  effortLabel?: string | null;

  /** ⚙ display-settings toggle (SDK); omitted → no settings button. */
  onToggleSettings?: () => void;
  /** checkpoint / commit-mode control (quick) — host supplies the node. */
  checkpointSlot?: React.ReactNode;
  /** compact-context control (SDK quick) — host supplies the node. */
  compactSlot?: React.ReactNode;
}

const READONLY_HINT = 'Set at session start — mid-session change coming later';

export function UnifiedComposer(props: UnifiedComposerProps): React.ReactElement {
  const {
    visibility,
    running,
    value,
    onChange,
    textareaRef,
    sessionId,
    placeholder,
    disabled = false,
    disabledHint,
    primaryLabel = 'Send',
    onSubmit,
    onStop,
    sending = false,
    sendError,
    onTogglePtyOpen,
    supportsAttachments = false,
    modelLabel,
    modelSlot,
    permissionSlot,
    effortLabel,
    onToggleSettings,
    checkpointSlot,
    compactSlot,
  } = props;

  const [atts, setAtts] = useState<ComposerAttachments>(emptyAttachments);
  const [isDragging, setIsDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow the textarea with its content (up to its max-height). Works for
  // both the plain textarea (PTY) and the FilePathAutocomplete textarea (SDK),
  // since both share `textareaRef`.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value, textareaRef]);

  const isSubmitting = busy || sending;
  const canSend = !disabled && !isSubmitting && (value.trim().length > 0 || hasAttachments(atts));

  // -- attachments ----------------------------------------------------------
  const addImages = useCallback(async (files: File[]) => {
    for (const file of files) {
      const img = await processImageFile(file);
      if (img) setAtts((a) => ({ ...a, images: [...a.images, img] }));
    }
  }, []);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      if (!supportsAttachments) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text.length > LARGE_TEXT_THRESHOLD) {
        e.preventDefault();
        setAtts((a) => ({ ...a, texts: [...a.texts, makeTextAttachment(text)] }));
        return;
      }
      const imageItems = Array.from(e.clipboardData?.items ?? []).filter((i) =>
        i.type.startsWith('image/'),
      );
      if (imageItems.length === 0) return;
      e.preventDefault();
      const files = imageItems.map((i) => i.getAsFile()).filter((f): f is File => f !== null);
      await addImages(files);
    },
    [supportsAttachments, addImages],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!supportsAttachments) return;
      await addImages(Array.from(e.dataTransfer.files));
    },
    [supportsAttachments, addImages],
  );

  const removeImage = (id: string) =>
    setAtts((a) => ({ ...a, images: a.images.filter((i) => i.id !== id) }));
  const removeText = (id: string) =>
    setAtts((a) => ({ ...a, texts: a.texts.filter((t) => t.id !== id) }));

  // -- submit ---------------------------------------------------------------
  const submit = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await onSubmit(atts);
      setAtts(emptyAttachments());
    } finally {
      setBusy(false);
    }
  }, [canSend, onSubmit, atts]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Escape') {
      if (running && onStop) {
        e.preventDefault();
        onStop();
      } else if (!visibility.isSDK && onTogglePtyOpen) {
        e.preventDefault();
        onTogglePtyOpen(); // close the PTY composer
      }
    }
  };

  // -- collapsed PTY hint bar (⌃G to reveal) --------------------------------
  if (!visibility.inputVisible) {
    return (
      <div className="shrink-0 border-t border-border-primary bg-bg-primary px-4 py-2.5">
        <div className="flex items-center gap-3 border border-dashed border-text-disabled bg-surface-secondary px-3 py-2.5 text-[11px] text-text-tertiary">
          <kbd className="inline-flex items-center gap-1 border border-border-hover bg-surface-primary px-2 py-1 text-[10px] text-text-primary">
            ⌃G
          </kbd>
          <span>
            Type directly in the terminal above, or press <b className="font-bold text-text-secondary">⌃G</b> to
            compose a message.
          </span>
          <span className="flex-1" />
          {onTogglePtyOpen && (
            <button
              type="button"
              onClick={onTogglePtyOpen}
              data-testid="unified-composer-reveal"
              className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-primary hover:text-interactive"
            >
              Show input →
            </button>
          )}
        </div>
      </div>
    );
  }

  const showAttachRow = atts.images.length > 0 || atts.texts.length > 0;

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t border-border-primary bg-bg-primary px-4 py-2.5"
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        if (supportsAttachments) setIsDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setIsDragging(false);
      }}
      data-testid="unified-composer"
    >
      {/* attachment previews */}
      {showAttachRow && (
        <div className="flex flex-wrap gap-2">
          {atts.texts.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1.5 border border-border-primary bg-surface-secondary px-2 py-1 text-[10px] text-text-secondary"
            >
              <FileText className="h-3 w-3" />
              <span className="max-w-[150px] truncate">{t.name}</span>
              <button onClick={() => removeText(t.id)} className="text-text-tertiary hover:text-interactive">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {atts.images.map((img: AttachedImage) => (
            <span
              key={img.id}
              className="inline-flex items-center gap-1.5 border border-border-primary bg-surface-primary px-1.5 py-1 text-[10px] text-text-secondary"
            >
              <img src={img.dataUrl} alt={img.name} className="h-5 w-5 border border-border-primary object-cover" />
              <span className="max-w-[120px] truncate">{img.name}</span>
              <button onClick={() => removeImage(img.id)} className="text-text-tertiary hover:text-interactive">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* input box */}
      <div
        className={cn(
          'flex items-center gap-2 border bg-surface-primary px-3 py-2 transition-colors',
          'focus-within:border-border-hover',
          isDragging ? 'border-interactive' : 'border-border-primary',
          disabled && 'opacity-60',
        )}
      >
        <span className="select-none font-mono text-sm font-bold text-interactive">›</span>
        {visibility.isSDK ? (
          <FilePathAutocomplete
            value={value}
            onChange={onChange}
            sessionId={sessionId}
            placeholder={isDragging ? 'Drop images here…' : placeholder}
            textareaRef={textareaRef}
            isTextarea
            rows={1}
            disabled={disabled}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            className="max-h-[120px] min-h-[20px] w-full resize-none border-0 bg-transparent font-mono text-xs text-text-primary placeholder-text-tertiary focus:outline-none disabled:cursor-not-allowed"
          />
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="max-h-[120px] min-h-[20px] w-full resize-none bg-transparent font-mono text-xs text-text-primary placeholder-text-tertiary focus:outline-none disabled:cursor-not-allowed"
          />
        )}
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {supportsAttachments && (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 border border-border-primary bg-surface-primary px-2.5 py-1.5 text-[10px] text-text-secondary transition-colors hover:border-border-hover"
            >
              <Paperclip className="h-3.5 w-3.5" /> Attach
              <span className="text-text-tertiary">· paste</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={async (e) => {
                await addImages(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        )}

        {/* read-only model (SDK selector per design) + effort. cyboflow's only
            effort value is 'ultracode', an interactive-only opt-in, so the
            effort pill is decoupled from the SDK-gated model pill and renders
            whenever the session carries one (session config; edit deferred). */}
        {visibility.showModelEffort &&
          (modelSlot ?? (modelLabel ? <ReadonlyPill label={modelLabel} /> : null))}
        {visibility.showModelEffort && permissionSlot}
        {effortLabel && <ReadonlyPill label={`effort: ${effortLabel}`} />}

        {/* checkpoint / commit-mode (quick) */}
        {visibility.showCheckpoint && checkpointSlot}

        {/* compact-context (SDK) */}
        {visibility.isSDK && compactSlot}

        {/* right cluster */}
        <div className="ml-auto flex items-center gap-2">
          {visibility.showSettings && onToggleSettings && (
            <button
              type="button"
              onClick={onToggleSettings}
              title="Display settings"
              aria-label="Display settings"
              className="inline-flex items-center border border-border-primary bg-surface-primary px-2 py-1.5 text-text-secondary transition-colors hover:border-border-hover"
            >
              <SettingsGlyph />
            </button>
          )}

          {running && onStop ? (
            <button
              type="button"
              onClick={onStop}
              data-testid="unified-composer-stop"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em]"
              style={{ backgroundColor: 'var(--ink)', border: '1px solid var(--ink)', color: 'var(--paper)' }}
            >
              <Square className="h-3 w-3 fill-current" /> Stop <kbd className="opacity-70">esc</kbd>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              data-testid="unified-composer-send"
              className={cn(
                'inline-flex items-center gap-2 border px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-[filter]',
                'border-interactive bg-interactive text-[color:var(--color-text-on-interactive)]',
                canSend ? 'hover:brightness-110' : 'cursor-not-allowed opacity-50',
              )}
            >
              {isSubmitting ? 'Sending…' : primaryLabel}
              <kbd className="inline-flex items-center gap-0.5 text-[10px] opacity-70">
                <CornerDownLeft className="h-3 w-3" />
              </kbd>
            </button>
          )}
        </div>
      </div>

      {disabled && disabledHint && <p className="text-[10px] text-text-tertiary">{disabledHint}</p>}
      {sendError && (
        <p className="text-xs text-status-error" role="alert">
          {sendError}
        </p>
      )}
    </div>
  );
}

/** Read-only control pill with a lock affordance (model / effort are session config in v1). */
function ReadonlyPill({ label }: { label: string }): React.ReactElement {
  return (
    <span
      title={READONLY_HINT}
      className="inline-flex items-center gap-1.5 border border-border-primary bg-surface-secondary px-2.5 py-1.5 text-[10px] text-text-secondary"
    >
      {label}
      <Lock className="h-3 w-3 text-text-tertiary" />
    </span>
  );
}

function SettingsGlyph(): React.ReactElement {
  // Inline gear to match the paper aesthetic (lucide Settings is fine too).
  return <span className="text-sm leading-none">⚙</span>;
}
