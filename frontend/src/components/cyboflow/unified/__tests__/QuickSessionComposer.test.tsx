import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef, useState } from 'react';

// Mock the panel-model fetch + the interactive send transport + the
// permission-mode persist IPC.
const mockSendInput = vi.fn();
const mockGetModel = vi.fn();
const mockGetFastMode = vi.fn();
const mockSetFastMode = vi.fn();
const mockUpdatePermission = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: {
    sessions: {
      sendInput: (id: string, text: string) => mockSendInput(id, text),
      updateAgentPermissionMode: (id: string, mode: string) => mockUpdatePermission(id, mode),
    },
    claudePanels: {
      getModel: (id: string) => mockGetModel(id),
      getFastMode: (id: string) => mockGetFastMode(id),
      setFastMode: (id: string, v: boolean) => mockSetFastMode(id, v),
    },
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
  onPermissionApplied?: (message: string) => void;
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
      panelId="panel-1"
      interactive={props.interactive}
      ptyOpen={ptyOpen}
      onTogglePtyOpen={() => setPtyOpen((v) => !v)}
      onPermissionApplied={props.onPermissionApplied}
    />
  );
}

beforeEach(() => {
  mockSendInput.mockReset().mockResolvedValue({ success: true });
  mockGetModel.mockReset().mockResolvedValue({ success: true, data: 'sonnet' });
  mockGetFastMode.mockReset().mockResolvedValue({ success: true, data: false });
  mockSetFastMode.mockReset().mockResolvedValue({ success: true });
  mockUpdatePermission.mockReset().mockResolvedValue({ success: true });
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

describe('QuickSessionComposer — Opus-only fast-mode pill', () => {
  it('shows the fast-mode toggle for an idle Opus session', async () => {
    mockGetModel.mockResolvedValue({ success: true, data: 'opus' });
    render(<Harness session={makeSession({ status: 'ready' })} interactive={false} />);
    expect(await screen.findByTestId('composer-fast-mode-pill')).toBeInTheDocument();
  });

  it('hides the fast-mode toggle for a non-Opus model', async () => {
    mockGetModel.mockResolvedValue({ success: true, data: 'sonnet' });
    render(<Harness session={makeSession({ status: 'ready' })} interactive={false} />);
    // The model pill confirms the composer toolbar has rendered…
    await waitFor(() => expect(mockGetModel).toHaveBeenCalled());
    expect(screen.queryByTestId('composer-fast-mode-pill')).toBeNull();
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

describe('QuickSessionComposer — read-only effort pill (migration 029)', () => {
  it('shows "effort: ultracode" for an ultracode session once the PTY composer is revealed', () => {
    render(
      <Harness
        session={makeSession({ status: 'running', substrate: 'interactive', effort: 'ultracode' })}
        interactive
      />,
    );

    // The PTY composer (and its toolbar) is ⌃G-hidden by default — reveal it.
    act(() => {
      fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    });

    expect(screen.getByText('effort: ultracode')).toBeInTheDocument();
  });

  it('omits the effort pill for an interactive session with no effort', () => {
    render(
      <Harness session={makeSession({ status: 'running', substrate: 'interactive' })} interactive />,
    );

    act(() => {
      fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    });

    expect(screen.queryByText('effort: ultracode')).toBeNull();
  });
});

describe('QuickSessionComposer — agent permission pill (Issue #1)', () => {
  it('renders the permission pill for a RUNNING SDK session', () => {
    render(<Harness session={makeSession({ status: 'running' })} interactive={false} />);
    // Default mode label from PERMISSION_MODE_OPTIONS.
    expect(screen.getByText('Ask before edits')).toBeInTheDocument();
  });

  it('renders the permission pill for an interactive session once the PTY composer is revealed', () => {
    render(
      <Harness session={makeSession({ status: 'running', substrate: 'interactive' })} interactive />,
    );
    // Hidden behind ⌃G; the toolbar (and its pills) appear only after the reveal.
    expect(screen.queryByText('Ask before edits')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    });
    expect(screen.getByText('Ask before edits')).toBeInTheDocument();
  });

  it('persists the chosen mode via the IPC and fires host feedback (SDK)', async () => {
    const onApplied = vi.fn();
    render(
      <Harness
        session={makeSession({ status: 'running' })}
        interactive={false}
        onPermissionApplied={onApplied}
      />,
    );
    fireEvent.click(screen.getByText('Ask before edits')); // open the dropdown
    fireEvent.click(await screen.findByText('Auto'));
    await waitFor(() => expect(mockUpdatePermission).toHaveBeenCalledWith('s1', 'auto'));
    await waitFor(() =>
      expect(onApplied).toHaveBeenCalledWith('Permission mode updated — applies on your next message'),
    );
  });

  it('fires restart-scoped host feedback for an interactive session', async () => {
    const onApplied = vi.fn();
    render(
      <Harness
        session={makeSession({ status: 'running', substrate: 'interactive' })}
        interactive
        onPermissionApplied={onApplied}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId('unified-composer-reveal'));
    });
    fireEvent.click(screen.getByText('Ask before edits')); // open the dropdown
    fireEvent.click(await screen.findByText('Auto'));
    await waitFor(() => expect(mockUpdatePermission).toHaveBeenCalledWith('s1', 'auto'));
    await waitFor(() =>
      expect(onApplied).toHaveBeenCalledWith(
        'Permission mode updated — applies when the terminal restarts',
      ),
    );
  });
});
