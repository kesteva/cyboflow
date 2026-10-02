/**
 * SessionRow inline rename (sidebar rail, session rows) — SessionRow-local
 * state only (no new props; sessionRowPropsEqual is untouched). Semantics:
 * trim; empty-or-unchanged closes the editor without calling the API; Enter
 * saves; Escape cancels.
 *
 * Conventions (imports, prop scaffolding) copied from
 * DraggableProjectTreeView.sessionRowMemo.test.tsx.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRow, type SessionRowProps } from '../DraggableProjectTreeView';
import type { Session } from '../../types/session';
import { API } from '../../utils/api';

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      rename: vi.fn(),
    },
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'My Session',
    projectId: 1,
    displayOrder: 0,
    worktreePath: '/tmp/sess-1',
    prompt: '',
    status: 'ready',
    createdAt: '2026-01-01',
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

function makeProps(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    session: makeSession(),
    projectId: 1,
    isLastSession: true,
    isActive: false,
    relativeTime: '5 minutes ago',
    sessionDropIndicator: null,
    childRuns: [],
    activeRunId: null,
    onSessionClick: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onActiveRunClick: vi.fn(),
    ...overrides,
  };
}

describe('SessionRow — inline rename', () => {
  beforeEach(() => {
    vi.mocked(API.sessions.rename).mockReset();
    vi.mocked(API.sessions.rename).mockResolvedValue({ success: true, data: { id: 's1', name: 'renamed' } });
  });

  it('double-click on the name shows an input seeded with the current name', () => {
    const props = makeProps({ session: makeSession({ name: 'My Session' }) });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));

    const input = screen.getByDisplayValue('My Session');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('pencil button shows the input too', () => {
    const props = makeProps({ session: makeSession({ name: 'My Session' }) });
    render(<SessionRow {...props} />);

    fireEvent.click(screen.getByLabelText('Rename session'));

    expect(screen.getByDisplayValue('My Session')).toBeInTheDocument();
  });

  it('typing a new name + Enter calls API.sessions.rename(session.id, trimmed) exactly once', async () => {
    const props = makeProps({ session: makeSession({ id: 'sess-1', name: 'Old Name' }) });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('Old Name'));
    const input = screen.getByDisplayValue('Old Name');
    fireEvent.change(input, { target: { value: '  New Name  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(API.sessions.rename).toHaveBeenCalledTimes(1));
    expect(API.sessions.rename).toHaveBeenCalledWith('sess-1', 'New Name');
  });

  it('Escape closes the editor without calling rename', () => {
    const props = makeProps({ session: makeSession({ name: 'My Session' }) });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));
    const input = screen.getByDisplayValue('My Session');
    fireEvent.change(input, { target: { value: 'Something Else' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(API.sessions.rename).not.toHaveBeenCalled();
    expect(screen.getByText('My Session')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Something Else')).toBeNull();
  });

  it('submitting unchanged closes the editor without calling rename', () => {
    const props = makeProps({ session: makeSession({ name: 'My Session' }) });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));
    const input = screen.getByDisplayValue('My Session');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(API.sessions.rename).not.toHaveBeenCalled();
    expect(screen.getByText('My Session')).toBeInTheDocument();
  });

  it('submitting whitespace-only closes the editor without calling rename', () => {
    const props = makeProps({ session: makeSession({ name: 'My Session' }) });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));
    const input = screen.getByDisplayValue('My Session');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(API.sessions.rename).not.toHaveBeenCalled();
    expect(screen.getByText('My Session')).toBeInTheDocument();
  });

  it('while editing, Enter inside the input does NOT invoke onSessionClick, and clicking the input does not either', async () => {
    const onSessionClick = vi.fn();
    const props = makeProps({ session: makeSession({ name: 'My Session' }), onSessionClick });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));
    const input = screen.getByDisplayValue('My Session');

    fireEvent.click(input);
    expect(onSessionClick).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(API.sessions.rename).toHaveBeenCalledTimes(1));
    expect(onSessionClick).not.toHaveBeenCalled();
  });

  it('a real double-click (dispatching click, click, dblclick in sequence) does not navigate twice and opens the editor', async () => {
    const onSessionClick = vi.fn();
    const props = makeProps({ session: makeSession({ name: 'My Session' }), onSessionClick });
    render(<SessionRow {...props} />);

    // fireEvent.doubleClick fires a bare dblclick only; userEvent.dblClick fires
    // the real click(1), click(2), dblclick sequence a browser does.
    await userEvent.dblClick(screen.getByText('My Session'));

    expect(onSessionClick.mock.calls.length).toBeLessThanOrEqual(1);
    expect(screen.getByDisplayValue('My Session')).toBeInTheDocument();
  });

  it('while editing, clicking a non-input part of the row does not invoke onSessionClick', () => {
    const onSessionClick = vi.fn();
    const props = makeProps({ session: makeSession({ name: 'My Session' }), onSessionClick });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));
    // The relative-time label is part of the row but outside the input.
    fireEvent.click(screen.getByText('5 minutes ago'));

    expect(onSessionClick).not.toHaveBeenCalled();
  });

  it('a native-order click-away dismiss (mousedown → blur → click) does not invoke onSessionClick', () => {
    // Real browsers dispatch the dismissing click's mousedown, then the input's
    // blur, then the click. On the unchanged-name path handleSaveRename closes
    // the editor synchronously inside the blur handler, so the row's
    // isEditingName guard already sees false by click time — the mousedown-armed
    // suppression must swallow exactly that click.
    const onSessionClick = vi.fn();
    const props = makeProps({ session: makeSession({ name: 'My Session' }), onSessionClick });
    render(<SessionRow {...props} />);

    fireEvent.doubleClick(screen.getByText('My Session'));
    const input = screen.getByDisplayValue('My Session');

    const label = screen.getByText('5 minutes ago');
    fireEvent.mouseDown(label);
    fireEvent.blur(input);
    fireEvent.click(label);

    expect(onSessionClick).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('My Session')).toBeNull();

    // The suppression is one-shot: the next ordinary click opens the session.
    fireEvent.mouseDown(label);
    fireEvent.click(label);
    expect(onSessionClick).toHaveBeenCalledTimes(1);
  });
});
