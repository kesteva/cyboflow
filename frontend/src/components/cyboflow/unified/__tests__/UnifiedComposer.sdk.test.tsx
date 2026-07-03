/**
 * UnifiedComposer — the SDK attachment surface (the sibling PTY-cell test only
 * covers the plain-textarea path). Exercises large-text paste, image clipboard /
 * drop / file-input intake, per-id removal, the submit clear-on-success /
 * keep-on-reject contract, and the SDK Escape behavior.
 *
 * FilePathAutocomplete is stubbed with a plain textarea that forwards the
 * onPaste/onKeyDown handlers (the real one pulls in the @-file IPC bridge).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, createEvent } from '@testing-library/react';
import { useRef, useState } from 'react';

vi.mock('../../../FilePathAutocomplete', () => ({
  default: ({
    value,
    onChange,
    onKeyDown,
    onPaste,
    placeholder,
    textareaRef,
  }: {
    value: string;
    onChange: (v: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  }) => (
    <textarea
      ref={textareaRef}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  ),
}));

import { UnifiedComposer, type UnifiedComposerProps } from '../UnifiedComposer';
import { resolveChatVisibility } from '../useChatVisibility';
import { LARGE_TEXT_THRESHOLD } from '../attachments';

function Harness(
  props: Partial<UnifiedComposerProps> & { running?: boolean; supportsAttachments?: boolean; initialValue?: string },
) {
  const [value, setValue] = useState(props.initialValue ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const visibility = resolveChatVisibility({
    transport: 'sdk',
    mode: 'quick',
    running: props.running ?? false,
    ptyOpen: false,
  });
  return (
    <UnifiedComposer
      visibility={visibility}
      running={props.running ?? false}
      value={value}
      onChange={(v) => {
        setValue(v);
        props.onChange?.(v);
      }}
      textareaRef={textareaRef}
      placeholder="Message…"
      onSubmit={props.onSubmit ?? (() => {})}
      onStop={props.onStop}
      onTogglePtyOpen={props.onTogglePtyOpen}
      supportsAttachments={props.supportsAttachments ?? true}
    />
  );
}

/** A minimal ClipboardEvent init object jsdom's fireEvent.paste accepts. */
function clipboard(opts: { text?: string; imageFiles?: File[] }) {
  const items = (opts.imageFiles ?? []).map((f) => ({
    type: f.type,
    getAsFile: () => f,
  }));
  return {
    getData: (type: string) => (type === 'text/plain' ? opts.text ?? '' : ''),
    items,
  };
}

function pngFile(name = 'shot.png'): File {
  return new File(['\x89PNG\r\n'], name, { type: 'image/png' });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('UnifiedComposer (SDK) — attachment intake', () => {
  it('converts a >threshold paste into a text attachment and calls preventDefault', async () => {
    const bigText = 'x'.repeat(LARGE_TEXT_THRESHOLD + 1);
    render(<Harness />);
    const textarea = screen.getByRole('textbox');
    const pasteEvent = createEvent.paste(textarea, { clipboardData: clipboard({ text: bigText }) });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    fireEvent(textarea, pasteEvent);
    // A "Pasted Text (N chars)" pill appears; the huge text is NOT inlined.
    expect(await screen.findByText(/Pasted Text/i)).toBeInTheDocument();
    expect(preventDefault).toHaveBeenCalled();
  });

  it('adds an image attachment from a clipboard image paste', async () => {
    render(<Harness />);
    const textarea = screen.getByRole('textbox');
    fireEvent.paste(textarea, { clipboardData: clipboard({ imageFiles: [pngFile()] }) });
    expect(await screen.findByAltText('shot.png')).toBeInTheDocument();
  });

  it('adds images via the file input and resets the input value', async () => {
    render(<Harness />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [pngFile('pick.png')] } });
    expect(await screen.findByAltText('pick.png')).toBeInTheDocument();
    // The onChange resets value so re-picking the same file re-fires change.
    expect(fileInput.value).toBe('');
  });

  it('drops images onto the composer body', async () => {
    render(<Harness />);
    const composer = screen.getByTestId('unified-composer');
    fireEvent.drop(composer, { dataTransfer: { files: [pngFile('drag.png')] } });
    expect(await screen.findByAltText('drag.png')).toBeInTheDocument();
  });

  it('drop is a no-op when supportsAttachments=false', async () => {
    render(<Harness supportsAttachments={false} />);
    const composer = screen.getByTestId('unified-composer');
    fireEvent.drop(composer, { dataTransfer: { files: [pngFile('nope.png')] } });
    // Give any (would-be) async image read a tick, then assert nothing landed.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByAltText('nope.png')).toBeNull();
  });
});

describe('UnifiedComposer (SDK) — per-id removal', () => {
  it('removeText drops only the targeted text pill', async () => {
    render(<Harness />);
    const textarea = screen.getByRole('textbox');
    fireEvent.paste(textarea, { clipboardData: clipboard({ text: 'A'.repeat(LARGE_TEXT_THRESHOLD + 1) }) });
    fireEvent.paste(textarea, { clipboardData: clipboard({ text: 'B'.repeat(LARGE_TEXT_THRESHOLD + 5) }) });
    const pills = await screen.findAllByText(/Pasted Text/i);
    expect(pills).toHaveLength(2);
    // Remove the first pill via its adjacent X button.
    const firstRemoveBtn = pills[0].parentElement!.querySelector('button')!;
    fireEvent.click(firstRemoveBtn);
    await waitFor(() => expect(screen.getAllByText(/Pasted Text/i)).toHaveLength(1));
  });

  it('removeImage drops only the targeted image pill', async () => {
    render(<Harness />);
    const textarea = screen.getByRole('textbox');
    fireEvent.paste(textarea, { clipboardData: clipboard({ imageFiles: [pngFile('one.png')] }) });
    await screen.findByAltText('one.png');
    fireEvent.paste(textarea, { clipboardData: clipboard({ imageFiles: [pngFile('two.png')] }) });
    await screen.findByAltText('two.png');
    const removeOne = screen.getByAltText('one.png').parentElement!.querySelector('button')!;
    fireEvent.click(removeOne);
    await waitFor(() => expect(screen.queryByAltText('one.png')).toBeNull());
    expect(screen.getByAltText('two.png')).toBeInTheDocument();
  });
});

describe('UnifiedComposer (SDK) — submit attachment lifecycle', () => {
  it('clears attachments after a successful submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.paste(textarea, { clipboardData: clipboard({ text: 'Z'.repeat(LARGE_TEXT_THRESHOLD + 1) }) });
    await screen.findByText(/Pasted Text/i);
    fireEvent.click(screen.getByTestId('unified-composer-send'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // onSubmit received the attachment…
    expect(onSubmit.mock.calls[0][0].texts).toHaveLength(1);
    // …and the pill was cleared on success.
    await waitFor(() => expect(screen.queryByText(/Pasted Text/i)).toBeNull());
  });

  it('LEAVES attachments in place when onSubmit rejects, with no unhandled rejection', async () => {
    // submit() catches its own rejection (console.error) so a rejecting onSubmit
    // never floats an unhandled rejection out of the fire-and-forget `void
    // submit()` call in the Send handler. Fail the test if one leaks anyway.
    const captured: unknown[] = [];
    const capture = (r: unknown) => captured.push(r);
    process.on('unhandledRejection', capture);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const onSubmit = vi.fn().mockRejectedValue(new Error('send failed'));
      render(<Harness onSubmit={onSubmit} />);
      const textarea = screen.getByRole('textbox');
      fireEvent.paste(textarea, { clipboardData: clipboard({ text: 'Q'.repeat(LARGE_TEXT_THRESHOLD + 1) }) });
      await screen.findByText(/Pasted Text/i);
      await act(async () => {
        fireEvent.click(screen.getByTestId('unified-composer-send'));
        await Promise.resolve();
      });
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      // The attachment survives the failed send so the user can retry.
      expect(screen.getByText(/Pasted Text/i)).toBeInTheDocument();
      // Give any (would-be) floating rejection a tick to surface, then assert
      // none did.
      await new Promise((r) => setTimeout(r, 0));
      expect(captured).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledWith(
        '[UnifiedComposer] onSubmit rejected',
        expect.any(Error),
      );
    } finally {
      process.removeListener('unhandledRejection', capture);
      consoleError.mockRestore();
    }
  });
});

describe('UnifiedComposer (SDK) — Escape', () => {
  it('Escape calls onStop while running', () => {
    const onStop = vi.fn();
    render(<Harness running onStop={onStop} initialValue="hi" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('Escape does NOT toggle the PTY composer in SDK mode when idle', () => {
    const onTogglePtyOpen = vi.fn();
    render(<Harness onTogglePtyOpen={onTogglePtyOpen} initialValue="hi" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    // The !isSDK branch is gated out for SDK; the PTY reveal toggle is untouched.
    expect(onTogglePtyOpen).not.toHaveBeenCalled();
  });
});
