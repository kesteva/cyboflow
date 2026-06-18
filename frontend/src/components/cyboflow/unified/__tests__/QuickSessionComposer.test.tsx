import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef, useState } from 'react';

// Mock the panel-model fetch + the interactive send transport.
const mockSendInput = vi.fn();
const mockGetModel = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: {
    sessions: { sendInput: (id: string, text: string) => mockSendInput(id, text) },
    claudePanels: { getModel: (id: string) => mockGetModel(id) },
  },
}));

// Replace FilePathAutocomplete (SDK input) with a plain textarea — no file API.
vi.mock('../../../FilePathAutocomplete', () => ({
  default: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    textareaRef,
  }: {
    value: string;
    onChange: (v: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  }) => (
    <textarea
      ref={textareaRef}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  ),
}));

// CommitModePill pulls in stores/IPC we don't need here — stub it.
vi.mock('../../../CommitModeToggle', () => ({
  CommitModePill: () => <div data-testid="commit-mode-pill" />,
}));

import { QuickSessionComposer } from '../QuickSessionComposer';
import type { Session } from '../../../../types/session';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'quick-1',
    worktreePath: '/repo/wt/quick-1',
    prompt: '',
    status: 'ready',
    createdAt: '2026-06-12T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    ...over,
  } as Session;
}

function Harness(props: {
  session: Session;
  interactive: boolean;
  handleSendInput?: ReturnType<typeof vi.fn>;
  handleContinueConversation?: ReturnType<typeof vi.fn>;
}) {
  const [input, setInput] = useState('');
  const [ptyOpen, setPtyOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <QuickSessionComposer
      activeSession={props.session}
      input={input}
      setInput={setInput}
      textareaRef={textareaRef}
      handleSendInput={props.handleSendInput ?? vi.fn()}
      handleContinueConversation={props.handleContinueConversation ?? vi.fn()}
      onToggleSettings={vi.fn()}
      panelId="panel-1"
      interactive={props.interactive}
      ptyOpen={ptyOpen}
      onTogglePtyOpen={() => setPtyOpen((v) => !v)}
    />
  );
}

beforeEach(() => {
  mockSendInput.mockReset().mockResolvedValue({ success: true });
  mockGetModel.mockReset().mockResolvedValue({ success: true, data: 'sonnet' });
});

describe('QuickSessionComposer — SDK', () => {
  it('routes ⌘↵ to handleContinueConversation when not waiting', async () => {
    const cont = vi.fn();
    render(<Harness session={makeSession({ status: 'ready' })} interactive={false} handleContinueConversation={cont} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'continue this' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(cont).toHaveBeenCalledTimes(1));
  });

  it('routes ⌘↵ to handleSendInput when status is waiting', async () => {
    const sendIn = vi.fn();
    render(<Harness session={makeSession({ status: 'waiting' })} interactive={false} handleSendInput={sendIn} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'my answer' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(sendIn).toHaveBeenCalledTimes(1));
  });
});

describe('QuickSessionComposer — interactive (PTY)', () => {
  it('is hidden behind ⌃G, then relays via API.sessions.sendInput on ⌘↵', async () => {
    render(<Harness session={makeSession({ status: 'running' })} interactive />);

    // Hidden by default; reveal it.
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'run the tests' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(mockSendInput).toHaveBeenCalledWith('s1', 'run the tests'));
  });

  it('does not call the panel-model fetch in interactive mode', () => {
    render(<Harness session={makeSession()} interactive />);
    expect(mockGetModel).not.toHaveBeenCalled();
  });
});
