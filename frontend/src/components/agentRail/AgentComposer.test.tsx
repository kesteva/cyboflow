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
});
