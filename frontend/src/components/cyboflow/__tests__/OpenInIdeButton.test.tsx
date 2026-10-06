/**
 * OpenInIdeButton — the Diff tab header's "Open in IDE" action.
 *
 * Visibility is gated on the session's project having an open_ide_command in
 * the landing store; a click calls API.sessions.openIDE(sessionId), and a
 * failure envelope / rejection lands in the app-wide errorStore dialog.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openIDE } = vi.hoisted(() => ({ openIDE: vi.fn() }));

vi.mock('../../../utils/api', () => ({
  API: { sessions: { openIDE } },
}));
vi.mock('../../../trpc/client', () => ({ trpc: {} }));

import { OpenInIdeButton } from '../OpenInIdeButton';
import { useLandingStore } from '../../../stores/landingStore';
import { useErrorStore } from '../../../stores/errorStore';
import type { Project } from '../../../types/project';

function project(id: number, openIdeCommand: string | null): Project {
  return {
    id,
    name: `P${id}`,
    path: `/p${id}`,
    active: false,
    created_at: '2026-10-02 00:00:00',
    updated_at: '2026-10-02 00:00:00',
    open_ide_command: openIdeCommand,
  };
}

beforeEach(() => {
  openIDE.mockReset();
  useErrorStore.setState({ currentError: null });
  useLandingStore.setState({ projects: [project(1, 'code .'), project(2, null), project(3, '   ')] });
});

describe('OpenInIdeButton', () => {
  it('renders when the session project has an open_ide_command', () => {
    render(<OpenInIdeButton sessionId="s1" projectId={1} />);
    const button = screen.getByTestId('diff-open-in-ide');
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('title', 'Open in IDE (code .)');
  });

  it('renders nothing when the project has no (or a blank) command, no project, or no session', () => {
    const { rerender } = render(<OpenInIdeButton sessionId="s1" projectId={2} />);
    expect(screen.queryByTestId('diff-open-in-ide')).toBeNull();
    rerender(<OpenInIdeButton sessionId="s1" projectId={3} />);
    expect(screen.queryByTestId('diff-open-in-ide')).toBeNull();
    rerender(<OpenInIdeButton sessionId="s1" projectId={null} />);
    expect(screen.queryByTestId('diff-open-in-ide')).toBeNull();
    rerender(<OpenInIdeButton sessionId="s1" projectId={99} />);
    expect(screen.queryByTestId('diff-open-in-ide')).toBeNull();
    rerender(<OpenInIdeButton sessionId={null} projectId={1} />);
    expect(screen.queryByTestId('diff-open-in-ide')).toBeNull();
  });

  it('appears once the project is updated with a command', () => {
    render(<OpenInIdeButton sessionId="s1" projectId={2} />);
    expect(screen.queryByTestId('diff-open-in-ide')).toBeNull();
    act(() => {
      useLandingStore.setState({ projects: [project(2, 'cursor .')] });
    });
    expect(screen.getByTestId('diff-open-in-ide')).toBeInTheDocument();
  });

  it('calls API.sessions.openIDE with the session id and shows no error on success', async () => {
    openIDE.mockResolvedValueOnce({ success: true });
    render(<OpenInIdeButton sessionId="s1" projectId={1} />);
    fireEvent.click(screen.getByTestId('diff-open-in-ide'));
    await waitFor(() => expect(openIDE).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(screen.getByTestId('diff-open-in-ide')).not.toBeDisabled());
    expect(useErrorStore.getState().currentError).toBeNull();
  });

  it("surfaces the handler's error through the error dialog on success:false", async () => {
    openIDE.mockResolvedValueOnce({ success: false, error: 'IDE command not found: code .' });
    render(<OpenInIdeButton sessionId="s1" projectId={1} />);
    fireEvent.click(screen.getByTestId('diff-open-in-ide'));
    await waitFor(() =>
      expect(useErrorStore.getState().currentError).toEqual({
        title: 'Failed to open IDE',
        error: 'IDE command not found: code .',
      }),
    );
  });

  it('surfaces a rejected call through the error dialog', async () => {
    openIDE.mockRejectedValueOnce(new Error('Electron API not available'));
    render(<OpenInIdeButton sessionId="s1" projectId={1} />);
    fireEvent.click(screen.getByTestId('diff-open-in-ide'));
    await waitFor(() =>
      expect(useErrorStore.getState().currentError).toEqual({
        title: 'Failed to open IDE',
        error: 'Electron API not available',
      }),
    );
  });
});
