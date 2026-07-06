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
const mockUpdateSessionMcps = vi.fn();
const mockUpdateSessionPlugins = vi.fn();
const mockSetModel = vi.fn();
const mockOnModelFallback = vi.fn((_cb: (notice: unknown) => void) => () => {});
const mockGetFastModeState = vi.fn();
const mockOnFastModeState = vi.fn((_cb: (notice: unknown) => void) => () => {});
const mockQueueInput = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: {
    sessions: {
      sendInput: (id: string, text: string) => mockSendInput(id, text),
      updateAgentPermissionMode: (id: string, mode: string) => mockUpdatePermission(id, mode),
      updateSessionMcps: (...args: unknown[]) => mockUpdateSessionMcps(...args),
      updateSessionPlugins: (...args: unknown[]) => mockUpdateSessionPlugins(...args),
    },
    panels: {
      queueInput: (panelId: string, id: string, text: string) => mockQueueInput(panelId, id, text),
    },
    claudePanels: {
      getModel: (id: string) => mockGetModel(id),
      getFastMode: (id: string) => mockGetFastMode(id),
      getFastModeState: (id: string) => mockGetFastModeState(id),
      onFastModeState: (cb: (notice: unknown) => void) => mockOnFastModeState(cb),
      setFastMode: (id: string, v: boolean) => mockSetFastMode(id, v),
      setModel: (id: string, model: string) => mockSetModel(id, model),
    },
    models: {
      onModelFallback: (cb: (notice: unknown) => void) => mockOnModelFallback(cb),
    },
  },
}));

// The MCP/plugin toggle pills (idle-SDK slots) query the read-only catalogue on
// mount; stub the tRPC client so the composer renders without a real IPC bridge.
const mockMcpsList = vi.fn();
const mockPluginsList = vi.fn();
vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      mcps: { list: { query: (...args: unknown[]) => mockMcpsList(...args) } },
      plugins: { list: { query: (...args: unknown[]) => mockPluginsList(...args) } },
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
import { usePendingSendStore } from '../../../../stores/pendingSendStore';
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
  onModelFallback?: (message: string) => void;
  onFastModeDeclined?: (message: string) => void;
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
      onModelFallback={props.onModelFallback}
      onFastModeDeclined={props.onFastModeDeclined}
    />
  );
}

beforeEach(() => {
  mockSendInput.mockReset().mockResolvedValue({ success: true });
  mockGetModel.mockReset().mockResolvedValue({ success: true, data: 'sonnet' });
  mockGetFastMode.mockReset().mockResolvedValue({ success: true, data: false });
  mockGetFastModeState.mockReset().mockResolvedValue({ success: true, data: null });
  mockOnFastModeState.mockReset().mockImplementation((_cb: (notice: unknown) => void) => () => {});
  mockSetFastMode.mockReset().mockResolvedValue({ success: true });
  mockUpdatePermission.mockReset().mockResolvedValue({ success: true });
  mockUpdateSessionMcps.mockReset().mockResolvedValue({ success: true });
  mockUpdateSessionPlugins.mockReset().mockResolvedValue({ success: true });
  mockMcpsList.mockReset().mockResolvedValue([]);
  mockPluginsList.mockReset().mockResolvedValue([]);
  mockSetModel.mockReset().mockResolvedValue({ success: true });
  mockOnModelFallback.mockReset().mockReturnValue(() => {});
  mockQueueInput.mockReset().mockResolvedValue({ success: true, data: { queued: true } });
  usePendingSendStore.setState({ byHost: {}, draftRequest: {} });
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

describe('QuickSessionComposer — mid-call model fallback', () => {
  it('swaps the pill + persists + toasts when THIS panel falls back off Fable', async () => {
    mockGetModel.mockResolvedValue({ success: true, data: 'fable' });
    const onModelFallback = vi.fn();
    render(
      <Harness session={makeSession({ status: 'running' })} interactive={false} onModelFallback={onModelFallback} />,
    );
    // The composer subscribed on mount; grab the registered push callback.
    await waitFor(() => expect(mockOnModelFallback).toHaveBeenCalled());
    const notify = mockOnModelFallback.mock.calls[0][0] as (n: unknown) => void;

    act(() => {
      notify({
        panelId: 'panel-1',
        sessionId: 's1',
        unavailableAlias: 'fable',
        unavailableLabel: 'Fable 5',
        fallbackAlias: 'opus',
      });
    });

    // Persisted the fallback alias so it survives a remount…
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('panel-1', 'opus'));
    // …and raised a human toast naming the swap.
    expect(onModelFallback).toHaveBeenCalledTimes(1);
    expect(onModelFallback.mock.calls[0][0]).toContain('Fable 5 is unavailable');
    expect(onModelFallback.mock.calls[0][0]).toContain('Opus 4.8');
  });

  it('ignores a fallback notice addressed to a DIFFERENT panel', async () => {
    mockGetModel.mockResolvedValue({ success: true, data: 'fable' });
    const onModelFallback = vi.fn();
    render(
      <Harness session={makeSession({ status: 'running' })} interactive={false} onModelFallback={onModelFallback} />,
    );
    await waitFor(() => expect(mockOnModelFallback).toHaveBeenCalled());
    const notify = mockOnModelFallback.mock.calls[0][0] as (n: unknown) => void;

    act(() => {
      notify({
        panelId: 'someone-else',
        sessionId: 's9',
        unavailableAlias: 'fable',
        unavailableLabel: 'Fable 5',
        fallbackAlias: 'opus',
      });
    });

    expect(mockSetModel).not.toHaveBeenCalled();
    expect(onModelFallback).not.toHaveBeenCalled();
  });
});

describe('QuickSessionComposer — declined fast-mode toast', () => {
  async function pushNotice(onFastModeDeclined: ReturnType<typeof vi.fn>, notice: unknown) {
    render(
      <Harness
        session={makeSession({ status: 'stopped' })}
        interactive={false}
        onFastModeDeclined={onFastModeDeclined}
      />,
    );
    await waitFor(() => expect(mockOnFastModeState).toHaveBeenCalled());
    const notify = mockOnFastModeState.mock.calls[0][0] as (n: unknown) => void;
    act(() => notify(notice));
  }

  it('toasts when a fast-requested turn reports off (entitlement copy)', async () => {
    const onFastModeDeclined = vi.fn();
    await pushNotice(onFastModeDeclined, { panelId: 'panel-1', sessionId: 's1', state: 'off', requestedFast: true });
    expect(onFastModeDeclined).toHaveBeenCalledTimes(1);
    expect(onFastModeDeclined.mock.calls[0][0]).toContain('extra usage');
  });

  it('toasts with cooldown copy when the CLI reports cooldown', async () => {
    const onFastModeDeclined = vi.fn();
    await pushNotice(onFastModeDeclined, { panelId: 'panel-1', sessionId: 's1', state: 'cooldown', requestedFast: true });
    expect(onFastModeDeclined.mock.calls[0][0]).toContain('cooling down');
  });

  it('does NOT toast when fast mode actually engaged', async () => {
    const onFastModeDeclined = vi.fn();
    await pushNotice(onFastModeDeclined, { panelId: 'panel-1', sessionId: 's1', state: 'on', requestedFast: true });
    expect(onFastModeDeclined).not.toHaveBeenCalled();
  });

  it('does NOT toast for a turn that never requested fast mode', async () => {
    const onFastModeDeclined = vi.fn();
    await pushNotice(onFastModeDeclined, { panelId: 'panel-1', sessionId: 's1', state: 'off', requestedFast: false });
    expect(onFastModeDeclined).not.toHaveBeenCalled();
  });

  it('ignores a notice addressed to a DIFFERENT panel', async () => {
    const onFastModeDeclined = vi.fn();
    await pushNotice(onFastModeDeclined, { panelId: 'someone-else', sessionId: 's9', state: 'off', requestedFast: true });
    expect(onFastModeDeclined).not.toHaveBeenCalled();
  });

  it('never toasts from the mount-time snapshot (push-only)', async () => {
    mockGetFastModeState.mockResolvedValue({
      success: true,
      data: { panelId: 'panel-1', sessionId: 's1', state: 'off', requestedFast: true },
    });
    const onFastModeDeclined = vi.fn();
    render(
      <Harness
        session={makeSession({ status: 'stopped' })}
        interactive={false}
        onFastModeDeclined={onFastModeDeclined}
      />,
    );
    await waitFor(() => expect(mockGetFastModeState).toHaveBeenCalled());
    expect(onFastModeDeclined).not.toHaveBeenCalled();
  });
});

describe('QuickSessionComposer — no MCP / plugin pills (moved to session start)', () => {
  // MCP / plugin selection is now a session-START decision (the launch wizard's
  // Advanced section), not a mid-conversation toggle — the deny-list is enforced
  // at the first SDK spawn and a mid-turn pill could leak a disabled server back
  // in via the CLI's settingSources auto-load. The composer must not render them.
  it('does NOT render the MCP or plugin pill, even for an idle SDK session with a deny-set', async () => {
    render(
      <Harness
        session={makeSession({
          status: 'ready',
          disabledMcpServers: ['peekaboo'],
          enabledPlugins: ['demo@local'],
        })}
        interactive={false}
      />,
    );
    // Flush the model fetch so the idle composer is fully settled before asserting.
    await waitFor(() => expect(mockGetModel).toHaveBeenCalled());
    expect(screen.queryByText('MCP')).toBeNull();
    expect(screen.queryByText('MCP · 1 off')).toBeNull();
    expect(screen.queryByText('Plugins')).toBeNull();
    expect(screen.queryByText('Plugins · 1')).toBeNull();
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

describe('QuickSessionComposer — pending-send (optimistic echo)', () => {
  const HOST = 'panel-1'; // Harness passes panelId="panel-1"

  it('pushes a sending pending entry and clears the input on submit (SDK)', async () => {
    render(<Harness session={makeSession({ status: 'ready' })} interactive={false} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'kick it off' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      const list = usePendingSendStore.getState().byHost[HOST] ?? [];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ text: 'kick it off', status: 'sending' });
    });
    // Input clears instantly (the send never gates the composer).
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('flips the pending entry to failed when the dispatch reports failure', async () => {
    const cont = vi.fn().mockResolvedValue({ success: false, error: 'boom' });
    render(
      <Harness session={makeSession({ status: 'ready' })} interactive={false} handleContinueConversation={cont} />,
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'will fail' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      const list = usePendingSendStore.getState().byHost[HOST] ?? [];
      expect(list.some((e) => e.status === 'failed' && e.text === 'will fail')).toBe(true);
    });
  });

  it('QUEUES via API.panels.queueInput while the session is RUNNING (no destructive continue)', async () => {
    const cont = vi.fn().mockResolvedValue({ success: true });
    render(
      <Harness session={makeSession({ status: 'running' })} interactive={false} handleContinueConversation={cont} />,
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'mid-turn note' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(mockQueueInput).toHaveBeenCalledTimes(1));
    // The queue entry id is the pending-send id (so reopen can dequeue it).
    const list = usePendingSendStore.getState().byHost[HOST] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ text: 'mid-turn note', status: 'queued' });
    expect(mockQueueInput).toHaveBeenCalledWith(HOST, list[0].id, 'mid-turn note');
    // The mid-turn message must NOT go through the (destructive) continue path.
    expect(cont).not.toHaveBeenCalled();
  });

  it('flips a queued entry to failed when the queue call is rejected', async () => {
    mockQueueInput.mockResolvedValue({ success: true, data: { queued: false } });
    render(<Harness session={makeSession({ status: 'running' })} interactive={false} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'will not queue' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      const list = usePendingSendStore.getState().byHost[HOST] ?? [];
      expect(list.some((e) => e.status === 'failed' && e.text === 'will not queue')).toBe(true);
    });
  });

  it('uses the CONTINUE path (not the queue) when the session is IDLE', async () => {
    const cont = vi.fn().mockResolvedValue({ success: true });
    render(
      <Harness session={makeSession({ status: 'ready' })} interactive={false} handleContinueConversation={cont} />,
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'idle send' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(cont).toHaveBeenCalledTimes(1));
    expect(mockQueueInput).not.toHaveBeenCalled();
  });

  it('repopulates the composer from a staged draft request (reopen)', async () => {
    render(<Harness session={makeSession({ status: 'ready' })} interactive={false} />);
    act(() => {
      // Simulate a reopen: stage a draft request for this host.
      const id = usePendingSendStore.getState().addPending(HOST, 'bring me back', 'failed');
      usePendingSendStore.getState().requestReopen(HOST, id);
    });
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('bring me back'),
    );
    // The request is acked (cleared) after consumption.
    expect(usePendingSendStore.getState().draftRequest[HOST]).toBeUndefined();
  });
});
