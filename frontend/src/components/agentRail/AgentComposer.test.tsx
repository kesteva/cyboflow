import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { AgentComposer } from './AgentComposer';

/** A minimal real File the jsdom FileReader can read into a data URL. */
function imageFile(name: string, type: string, bytes = 4): File {
  return new File([new Uint8Array(bytes).fill(137)], name, { type });
}

/** Paste an image through the clipboard, the way a screenshot arrives. */
function pasteImage(file: File): void {
  fireEvent.paste(screen.getByTestId('agent-composer-input'), {
    clipboardData: { items: [{ type: file.type, getAsFile: () => file }] },
  });
}

describe('AgentComposer', () => {
  it('renders the placeholder and no model chip', () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);

    expect(screen.getByTestId('agent-composer-input')).toHaveAttribute(
      'placeholder',
      'Ask, or run /plan /approve /triage…',
    );
    expect(screen.queryByTestId('agent-composer-model-chip')).not.toBeInTheDocument();
  });

  it('Send button calls onSend with the trimmed text and clears the input', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: '  where is everything?  ' } });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('where is everything?', undefined);
    expect(input).toHaveValue('');
  });

  it('Cmd+Enter sends, matching UnifiedComposer keybinding', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'triage the backlog' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onSend).toHaveBeenCalledWith('triage the backlog', undefined);
  });

  it('does not send an empty/whitespace-only draft', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-composer-send')).toBeDisabled();
  });

  it('disables the textarea + send button while a turn is in flight', () => {
    render(<AgentComposer onSend={vi.fn()} disabled />);

    expect(screen.getByTestId('agent-composer-input')).toBeDisabled();
    expect(screen.getByTestId('agent-composer-send')).toBeDisabled();
  });

  it('typing multiline text does not break send', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'line one\nline two\nline three\nline four\nline five' } });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).toHaveBeenCalledWith('line one\nline two\nline three\nline four\nline five', undefined);
    expect(input).toHaveValue('');
  });

  it('does not call onSend when disabled, even via Cmd+Enter', () => {
    const onSend = vi.fn();
    const { rerender } = render(<AgentComposer onSend={onSend} disabled={false} />);
    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'queued while disabled' } });

    rerender(<AgentComposer onSend={onSend} disabled />);
    fireEvent.keyDown(screen.getByTestId('agent-composer-input'), { key: 'Enter', metaKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Image attachments
  //
  // The assistant runs with `tools: []`, so an attached image has to leave this
  // component as a real base64 content block — there is no path for it to read.
  // ---------------------------------------------------------------------

  it('pasting an image adds a thumbnail', async () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);

    pasteImage(imageFile('shot.png', 'image/png'));

    const strip = await screen.findByTestId('agent-composer-attachments');
    expect(strip.querySelectorAll('img')).toHaveLength(1);
  });

  it('the × button removes a thumbnail', async () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);
    pasteImage(imageFile('shot.png', 'image/png'));
    await screen.findByTestId('agent-composer-attachments');

    fireEvent.click(screen.getByLabelText('Remove shot.png'));

    await waitFor(() =>
      expect(screen.queryByTestId('agent-composer-attachments')).not.toBeInTheDocument(),
    );
  });

  it('picking a file through the paperclip input adds it too', async () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);

    fireEvent.change(screen.getByTestId('agent-composer-file-input'), {
      target: { files: [imageFile('picked.png', 'image/png')] },
    });

    const strip = await screen.findByTestId('agent-composer-attachments');
    expect(strip.querySelectorAll('img')).toHaveLength(1);
  });

  it('dropping a file adds it', async () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);

    fireEvent.drop(screen.getByTestId('agent-composer'), {
      dataTransfer: { files: [imageFile('dropped.png', 'image/png')] },
    });

    await screen.findByTestId('agent-composer-attachments');
  });

  it('send passes the wire-shaped images and clears them', async () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'what is this?' } });
    pasteImage(imageFile('shot.png', 'image/png'));
    await screen.findByTestId('agent-composer-attachments');

    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, images] = onSend.mock.calls[0] as [string, Array<Record<string, string>>];
    expect(text).toBe('what is this?');
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('shot.png');
    expect(images[0].mediaType).toBe('image/png');
    // The raw payload only — a `data:` prefix here would be sent verbatim to the
    // API as image bytes and fail the turn.
    expect(images[0].base64).not.toContain('data:');
    expect(images[0].base64.length).toBeGreaterThan(0);

    expect(screen.getByTestId('agent-composer-input')).toHaveValue('');
    await waitFor(() =>
      expect(screen.queryByTestId('agent-composer-attachments')).not.toBeInTheDocument(),
    );
  });

  it('an image with no text can be sent (the picture IS the message)', async () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);
    pasteImage(imageFile('shot.png', 'image/png'));
    await screen.findByTestId('agent-composer-attachments');

    expect(screen.getByTestId('agent-composer-send')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('');
    expect(onSend.mock.calls[0][1]).toHaveLength(1);
  });

  it('refuses an image type the model cannot receive, inline and at attach time', async () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);

    pasteImage(imageFile('diagram.svg', 'image/svg+xml'));

    expect(await screen.findByTestId('agent-composer-attach-error')).toHaveTextContent(
      'Only PNG, JPEG, GIF, and WebP images',
    );
    expect(screen.queryByTestId('agent-composer-attachments')).not.toBeInTheDocument();
  });

  it('caps the strip at four images and says so', async () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);

    // Fired back-to-back WITHOUT awaiting between them: the component must
    // apply the cap against the live list even when the async attach paths
    // overlap (a fast paste-paste-paste), not just when they are serialized.
    for (let i = 0; i < 5; i++) {
      pasteImage(imageFile(`shot-${i}.png`, 'image/png'));
    }

    await waitFor(() =>
      expect(
        screen.getByTestId('agent-composer-attachments').querySelectorAll('img'),
      ).toHaveLength(4),
    );
    await waitFor(() =>
      expect(screen.getByTestId('agent-composer-attach-error')).toHaveTextContent('At most 4 images'),
    );
  });

  it('a text-only send still omits the images argument', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} />);

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'plain' } });
    fireEvent.click(screen.getByTestId('agent-composer-send'));

    expect(onSend).toHaveBeenCalledWith('plain', undefined);
  });

  // ---------------------------------------------------------------------
  // `prefill` — the Custom Views §7.1 authoring kickoff's one-shot pre-fill
  // ---------------------------------------------------------------------

  /** Mirrors how `AgentThreadView` wires `composerDraft`: a `prefill` prop that
   *  the parent clears via `onPrefillConsumed`. */
  function PrefillHost({ onSend, onConsumed }: { onSend: (text: string) => void; onConsumed: () => void }) {
    const [draft, setDraft] = useState<string | null>('seed text');
    return (
      <AgentComposer
        onSend={onSend}
        disabled={false}
        prefill={draft}
        onPrefillConsumed={() => {
          setDraft(null);
          onConsumed();
        }}
      />
    );
  }

  it('applies a non-empty prefill to the textarea and reports it consumed once', () => {
    const onConsumed = vi.fn();
    render(<PrefillHost onSend={vi.fn()} onConsumed={onConsumed} />);

    expect(screen.getByTestId('agent-composer-input')).toHaveValue('seed text');
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it('a null/undefined/empty prefill never applies and never reports consumed', () => {
    const onPrefillConsumed = vi.fn();
    const { rerender } = render(
      <AgentComposer onSend={vi.fn()} disabled={false} prefill={null} onPrefillConsumed={onPrefillConsumed} />,
    );
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('');
    expect(onPrefillConsumed).not.toHaveBeenCalled();

    rerender(<AgentComposer onSend={vi.fn()} disabled={false} prefill="" onPrefillConsumed={onPrefillConsumed} />);
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('');
    expect(onPrefillConsumed).not.toHaveBeenCalled();
  });

  it('the user can edit the applied prefill freely, and it is not reapplied once the source clears (one-shot)', () => {
    const onConsumed = vi.fn();
    render(<PrefillHost onSend={vi.fn()} onConsumed={onConsumed} />);

    const input = screen.getByTestId('agent-composer-input');
    expect(input).toHaveValue('seed text');
    fireEvent.change(input, { target: { value: 'seed text edited' } });
    expect(input).toHaveValue('seed text edited');
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Stop (TASK-297): while `sending`, the send glyph becomes Stop, and Esc
  // in the focused composer also stops. The textarea stays FOCUSABLE while
  // sending (unlike `disabled`) — a disabled element cannot receive Esc.
  // ---------------------------------------------------------------------

  it('renders a Stop button instead of Send while sending, and the textarea stays enabled', () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} />);

    expect(screen.queryByTestId('agent-composer-send')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-composer-stop')).toBeInTheDocument();
    expect(screen.getByTestId('agent-composer-input')).not.toBeDisabled();
  });

  it('clicking Stop calls onStop', () => {
    const onStop = vi.fn();
    render(<AgentComposer onSend={vi.fn()} disabled={false} sending onStop={onStop} />);

    fireEvent.click(screen.getByTestId('agent-composer-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('Esc in the focused composer calls onStop while sending', () => {
    const onStop = vi.fn();
    render(<AgentComposer onSend={vi.fn()} disabled={false} sending onStop={onStop} />);

    fireEvent.keyDown(screen.getByTestId('agent-composer-input'), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('Esc is a no-op when not sending', () => {
    const onStop = vi.fn();
    render(<AgentComposer onSend={vi.fn()} disabled={false} onStop={onStop} />);

    fireEvent.keyDown(screen.getByTestId('agent-composer-input'), { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
  });

  it('Cmd+Enter does not send while sending (Send is replaced by Stop)', () => {
    const onSend = vi.fn();
    render(<AgentComposer onSend={onSend} disabled={false} sending onStop={vi.fn()} />);

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'typed mid-turn' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('reverts to the Send button once sending clears', () => {
    const { rerender } = render(<AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} />);
    expect(screen.getByTestId('agent-composer-stop')).toBeInTheDocument();

    rerender(<AgentComposer onSend={vi.fn()} disabled={false} sending={false} onStop={vi.fn()} />);
    expect(screen.queryByTestId('agent-composer-stop')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-composer-send')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Queue + Interrupt & send trio (TASK-301)
  // ---------------------------------------------------------------------

  it('an EMPTY draft while sending shows only Stop (no Queue/Interrupt & send)', () => {
    render(
      <AgentComposer
        onSend={vi.fn()}
        disabled={false}
        sending
        onStop={vi.fn()}
        onQueue={vi.fn()}
        onInterruptSend={vi.fn()}
      />,
    );

    expect(screen.getByTestId('agent-composer-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-composer-queue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-composer-interrupt-send')).not.toBeInTheDocument();
  });

  it('renders the full [Queue] [Interrupt & send] [Stop] trio once a draft exists while sending', () => {
    render(
      <AgentComposer
        onSend={vi.fn()}
        disabled={false}
        sending
        onStop={vi.fn()}
        onQueue={vi.fn()}
        onInterruptSend={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'mid-turn draft' } });

    expect(screen.getByTestId('agent-composer-queue')).toBeInTheDocument();
    expect(screen.getByTestId('agent-composer-interrupt-send')).toBeInTheDocument();
    expect(screen.getByTestId('agent-composer-stop')).toBeInTheDocument();
  });

  it('the textarea stays typeable while sending (not `disabled`)', () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} onQueue={vi.fn()} />);
    expect(screen.getByTestId('agent-composer-input')).not.toBeDisabled();
  });

  it('clicking Queue calls onQueue with the trimmed text and clears the draft', () => {
    const onQueue = vi.fn();
    render(
      <AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} onQueue={onQueue} onInterruptSend={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '  queue this  ' } });
    fireEvent.click(screen.getByTestId('agent-composer-queue'));

    expect(onQueue).toHaveBeenCalledWith('queue this', undefined);
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('');
  });

  it('clicking Interrupt & send calls onInterruptSend (not onQueue/onSend)', () => {
    const onQueue = vi.fn();
    const onSend = vi.fn();
    const onInterruptSend = vi.fn();
    render(
      <AgentComposer onSend={onSend} disabled={false} sending onStop={vi.fn()} onQueue={onQueue} onInterruptSend={onInterruptSend} />,
    );

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'abort and send' } });
    fireEvent.click(screen.getByTestId('agent-composer-interrupt-send'));

    expect(onInterruptSend).toHaveBeenCalledWith('abort and send', undefined);
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('plain ⌘↵ while sending queues (mirrors UnifiedComposer: same key sends idle, queues running)', () => {
    const onQueue = vi.fn();
    const onSend = vi.fn();
    render(
      <AgentComposer onSend={onSend} disabled={false} sending onStop={vi.fn()} onQueue={onQueue} onInterruptSend={vi.fn()} />,
    );

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'keyboard queue' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onQueue).toHaveBeenCalledWith('keyboard queue', undefined);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('⌘⇧↵ while sending triggers Interrupt & send, not Queue', () => {
    const onQueue = vi.fn();
    const onInterruptSend = vi.fn();
    render(
      <AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} onQueue={onQueue} onInterruptSend={onInterruptSend} />,
    );

    const input = screen.getByTestId('agent-composer-input');
    fireEvent.change(input, { target: { value: 'keyboard interrupt' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, shiftKey: true });

    expect(onInterruptSend).toHaveBeenCalledWith('keyboard interrupt', undefined);
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('an attached image survives Queue (passed through to onQueue)', async () => {
    const onQueue = vi.fn();
    render(
      <AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} onQueue={onQueue} onInterruptSend={vi.fn()} />,
    );
    pasteImage(imageFile('shot.png', 'image/png'));
    await screen.findByTestId('agent-composer-attachments');

    fireEvent.click(screen.getByTestId('agent-composer-queue'));

    expect(onQueue).toHaveBeenCalledTimes(1);
    const [text, images] = onQueue.mock.calls[0] as [string, Array<Record<string, string>>];
    expect(text).toBe('');
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('shot.png');
  });

  it('renders the "Queued" notice with a working Cancel control', () => {
    const onCancelQueued = vi.fn();
    render(
      <AgentComposer onSend={vi.fn()} disabled={false} sending onStop={vi.fn()} queued onCancelQueued={onCancelQueued} />,
    );

    expect(screen.getByTestId('agent-composer-queued')).toHaveTextContent(
      'Queued — sends once the current turn finishes.',
    );
    fireEvent.click(screen.getByTestId('agent-composer-queued-cancel'));
    expect(onCancelQueued).toHaveBeenCalledTimes(1);
  });

  it('renders no "Queued" notice when not queued', () => {
    render(<AgentComposer onSend={vi.fn()} disabled={false} />);
    expect(screen.queryByTestId('agent-composer-queued')).not.toBeInTheDocument();
  });
});
